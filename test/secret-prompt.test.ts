import test from "node:test";
import assert from "node:assert/strict";
import { readSecret } from "../scripts/secret-prompt.ts";
import type { SecretInput } from "../scripts/secret-prompt.ts";

function terminal() {
  const listeners: ((c: string) => void)[] = [];
  const log: string[] = [];
  const input: SecretInput = {
    isTTY: true,
    setRawMode: (on: boolean) => log.push(`raw:${on}`),
    resume: () => log.push("resume"),
    pause: () => log.push("pause"),
    setEncoding: () => {},
    on: (_e, cb) => listeners.push(cb),
    off: (_e, cb) => listeners.splice(listeners.indexOf(cb), 1),
  };
  const shown: string[] = [];
  return { input, log, shown, output: { write: (s: string) => shown.push(s) }, type: (s: string) => listeners.slice().forEach((l) => l(s)), listeners };
}

test("a secret typed at a terminal is read without being shown, and the terminal is put back", async () => {
  const t = terminal();
  const p = readSecret("Seed: ", t.input, t.output);
  t.type("abc");
  t.type("x\u007fd"); // a backspace takes the x back
  t.type("ef\r");
  assert.equal(await p, "abcdef");
  assert.equal(t.shown.join(""), "Seed: \n", "only the question and a new line are written: never what was typed");
  assert.deepEqual(t.log.filter((l) => l.startsWith("raw")), ["raw:true", "raw:false"]);
  assert.equal(t.listeners.length, 0, "the listener is removed");
});

test("a pasted secret arrives in one piece, and Ctrl-C gives up", async () => {
  const t = terminal();
  const p = readSecret("Seed: ", t.input, t.output);
  t.type("pasted-value\n");
  assert.equal(await p, "pasted-value");
  const t2 = terminal();
  const q = readSecret("Seed: ", t2.input, t2.output);
  t2.type("ab\u0003");
  assert.equal(await q, null);
});

test("with no terminal there is nothing to ask on", async () => {
  assert.equal(await readSecret("Seed: ", { isTTY: false } as unknown as SecretInput), null);
});
