import test from "node:test";
import assert from "node:assert/strict";
import { PAYWALL } from "../src/config.ts";
import { QX_ID } from "../src/ledger.ts";
import { VIEW_KEY, isReadOnly, parseWallet, readViewed, shortAddress, writeViewed } from "../web/viewwallet.ts";

const REAL = PAYWALL.recipient;

test("an address is taken from what was pasted, in any case, with spaces, or inside an explorer link", () => {
  assert.deepEqual(parseWallet(REAL), { ok: true, id: REAL });
  assert.deepEqual(parseWallet(`  ${REAL}\n`), { ok: true, id: REAL }, "spaces and a line break around it");
  assert.deepEqual(parseWallet(REAL.toLowerCase()), { ok: true, id: REAL }, "lower case");
  assert.deepEqual(parseWallet(`https://explorer.qubic.org/network/address/${REAL}`), { ok: true, id: REAL }, "a link to it");
  assert.deepEqual(parseWallet(`${REAL} (my wallet)`), { ok: true, id: REAL }, "with a note after it");
  assert.deepEqual(parseWallet(`${REAL}, ${REAL}`), { ok: true, id: REAL }, "the same address twice is one address");
  assert.deepEqual(parseWallet(QX_ID), { ok: true, id: QX_ID }, "a contract's address is an address");
});

test("anything else is refused with a sentence that says what is wrong", () => {
  const bad = (text: string) => {
    const r = parseWallet(text);
    assert.equal(r.ok, false, text);
    return (r as { error: string }).error;
  };
  assert.match(bad(""), /Paste a Qubic address/);
  assert.match(bad("   "), /Paste a Qubic address/);
  assert.match(bad("hello world"), /not a Qubic address/);
  assert.match(bad("QDOGE"), /not a Qubic address/);
  assert.match(bad(REAL.slice(0, 56)), /60 letters; that one has 56/, "cut short");
  assert.match(bad(REAL + "AB"), /60 letters; that one has 62/, "too long");
  assert.match(bad(REAL.slice(0, 59) + (REAL.endsWith("E") ? "F" : "E")), /do not match/, "one letter wrong: the checksum catches it");
  assert.match(bad("A".repeat(60)), /do not match/, "60 letters that are not an address");
  assert.match(bad(`${REAL} ${QX_ID}`), /more than one address/);
  assert.match(bad(REAL.replace("Q", "1")), /not a Qubic address|60 letters/, "a digit in it");
});

test("the address looked at is remembered, only if it is still a real one", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  assert.equal(readViewed(storage), null, "nothing yet");
  writeViewed(storage, REAL);
  assert.equal(store.get(VIEW_KEY), REAL);
  assert.equal(readViewed(storage), REAL);
  store.set(VIEW_KEY, "garbage");
  assert.equal(readViewed(storage), null, "a stored value that is not an address is ignored");
  writeViewed(storage, null);
  assert.equal(store.has(VIEW_KEY), false, "stopping forgets it");
  assert.equal(readViewed(null), null);
  assert.equal(readViewed({ getItem: () => { throw new Error("blocked"); } }), null, "a browser that blocks storage");
  assert.doesNotThrow(() => writeViewed({ setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } }, REAL));
});

test("a wallet looked at is read-only unless it is the connected one", () => {
  assert.equal(isReadOnly(null, null), false, "looking at nothing");
  assert.equal(isReadOnly(null, REAL), false, "your own wallet");
  assert.equal(isReadOnly(REAL, null), true, "looking at an address with nothing connected");
  assert.equal(isReadOnly(QX_ID, REAL), true, "looking at another wallet while connected: nothing may be signed for it");
  assert.equal(isReadOnly(REAL, REAL), false, "looking at the address that is connected is just your wallet");
  assert.equal(shortAddress(REAL), "QDOGE…MBUTZE".replace("MBUTZE", REAL.slice(-5)));
});
