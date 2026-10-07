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
