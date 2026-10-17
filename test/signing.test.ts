import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELEASE_KEY, llmsText } from "../src/llms.ts";

/**
 * The downloads' checksum list is signed with the maintainer's minisign key, and three places publish its public half: the README (the copy to trust, it is on GitHub, not on the site), the
 * agents page and /llms.txt. A key that differs between them would send a careful reader to a signature check that fails, or worse, to a key that is not the maintainer's.
 */
const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const keysIn = (text: string) => [...new Set(text.match(/RW[A-Za-z0-9+/]{54}/g) ?? [])];

test("the release key is a minisign public key: RW and 54 base64 characters, 56 in all", () => {
  assert.match(RELEASE_KEY, /^RW[A-Za-z0-9+/]{54}$/);
});

test("the README, the agents page and /llms.txt all carry that key and no other", () => {
  for (const [name, text] of [["README.md", read("README.md")], ["agents page", read("web/public/agents/index.html")], ["llms.txt", llmsText({})]] as const) {
    assert.deepEqual(keysIn(text), [RELEASE_KEY], name);
  }
});

test("the agents page and /llms.txt link the signature and tell the reader to trust the GitHub copy of the key", () => {
  const page = read("web/public/agents/index.html");
  const llms = llmsText({});
  for (const [name, text] of [["agents page", page], ["llms.txt", llms]] as const) {
    assert.match(text, /agents\/SHA256SUMS\.minisig/, name);
    assert.match(text, /github\.com\/profitphil\/qmax/, name);
    assert.match(text, new RegExp(`minisign -V -P ${RELEASE_KEY.replace(/[+/]/g, "\\$&")} -m SHA256SUMS`), name);
  }
  assert.match(read("README.md"), /### Verifying the downloads/, "the agents page links to this heading");
});

// The server's own files (deploy/) are not in the public copy of the repository: this test is skipped there.
test("the deploy signs by default when the maintainer's key is at its usual place, and says so loudly when it cannot", { skip: existsSync(join(ROOT, "deploy/deploy.sh")) ? false : "deploy/ is not in this copy" }, () => {
  const deploy = read("deploy/deploy.sh");
  assert.match(deploy, /\$HOME\/\.minisign\/minisign\.key/);
  assert.match(deploy, /\.\/scripts\/sign-release\.sh/);
  assert.match(deploy, /WARNING: no minisign key found/);
});
