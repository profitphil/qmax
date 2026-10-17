/** Qubic identity (60 chars A-Z) → 32 public-key bytes. The last 4 chars are a checksum and are ignored. */
export function identityToBytes(identity: string): Uint8Array {
  if (!/^[A-Z]{60}$/.test(identity)) throw new Error(`Invalid Qubic identity: ${identity}`);
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    let v = 0n;
    for (let j = 13; j >= 0; j--) v = v * 26n + BigInt(identity.charCodeAt(i * 14 + j) - 65);
    view.setBigUint64(i * 8, v, true);
  }
  return out;
}

/** Asset name (up to 7 ASCII chars) → the uint64 the contracts use. */
export function assetNameToU64(name: string): bigint {
  if (!/^[\x21-\x7e]{1,7}$/.test(name)) throw new Error(`Invalid asset name: ${name}`);
  const bytes = new Uint8Array(8);
  bytes.set(new TextEncoder().encode(name));
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

/** The reverse of assetNameToU64: up to 7 ASCII characters, stopping at the first zero byte. */
export function assetNameFromU64(v: bigint): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, v, true);
  let out = "";
  for (const b of bytes) {
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

export const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

// ---- 32 public-key bytes → identity (the other way). Needs the identity's last four letters, a checksum made with KangarooTwelve.

const MASK64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & MASK64;
/** Keccak's round constants; Keccak-p[1600,12] (what KangarooTwelve and TurboSHAKE use) runs the last 12 of the 24 rounds. */
const RC = [
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation amounts of the rho step and the lane order of the pi step. */
const ROT = [1n, 3n, 6n, 10n, 15n, 21n, 28n, 36n, 45n, 55n, 2n, 14n, 27n, 41n, 56n, 8n, 25n, 43n, 62n, 18n, 39n, 61n, 20n, 44n];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function keccakP12(a: bigint[]): void {
  const c = new Array<bigint>(5);
  for (const rc of RC) {
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) a[y + x] ^= d;
    }
    let t = a[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const next = a[j];
      a[j] = rotl(t, ROT[i]);
      t = next;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) c[x] = a[y + x];
      for (let x = 0; x < 5; x++) a[y + x] = c[x] ^ (~c[(x + 1) % 5] & MASK64 & c[(x + 2) % 5]);
    }
    a[0] ^= rc;
  }
}

/** KangarooTwelve of a short message (under 8192 bytes, no customisation string), `outLen` bytes (at most 168): TurboSHAKE128 of the message, a zero byte, and the 0x07 marker. */
function k12(message: Uint8Array, outLen: number): Uint8Array {
  const RATE = 168;
  if (message.length + 2 > RATE) throw new Error("Only a message shorter than one block is supported");
  const block = new Uint8Array(RATE);
  block.set(message); // the byte after it is the length of the (empty) customisation string: 0
  block[message.length + 1] ^= 0x07; // then the domain byte, and the padding's last bit
  block[RATE - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let i = 0; i < RATE / 8; i++) {
    let lane = 0n;
    for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(block[i * 8 + j]);
    state[i] = lane;
  }
  keccakP12(state);
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = Number((state[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

const identityMemo = new Map<string, string>();

/** 32 public-key bytes → the 60-letter identity: fourteen letters for each 8 bytes, then four letters of checksum. */
export function bytesToIdentity(key: Uint8Array): string {
  if (key.length !== 32) throw new Error("A public key is 32 bytes");
  const hex = bytesToHex(key);
  const known = identityMemo.get(hex);
  if (known) return known;
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  let id = "";
  for (let i = 0; i < 4; i++) {
    let v = view.getBigUint64(i * 8, true);
    for (let j = 0; j < 14; j++) {
      id += String.fromCharCode(65 + Number(v % 26n));
      v /= 26n;
    }
  }
  const sum = k12(key, 3);
  let check = (sum[0] | (sum[1] << 8) | (sum[2] << 16)) & 0x3ffff;
  for (let i = 0; i < 4; i++) {
    id += String.fromCharCode(65 + (check % 26));
    check = Math.floor(check / 26);
  }
  if (identityMemo.size >= 5000) identityMemo.delete(identityMemo.keys().next().value as string);
  identityMemo.set(hex, id);
  return id;
}
