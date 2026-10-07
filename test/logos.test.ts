import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logoFor } from "../src/logos.ts";
import type { LogoIndex } from "../src/logos.ts";

const idx: LogoIndex = {
  QMINE: [{ issuer: "QMINE_ISSUER", light: "QMINE-light.png", dark: "QMINE-dark.png" }],
  CFB: [{ issuer: "CFB_ISSUER", light: "CFB-light.png" }],
  TWIN: [{ issuer: "A", light: "TWIN-A-light.png" }, { issuer: "B", light: "TWIN-B-light.png" }],
};

test("the logo for the page's theme, or the one picture there is", () => {
  assert.equal(logoFor(idx, "QMINE", "QMINE_ISSUER", "dark"), "/logos/QMINE-dark.png");
  assert.equal(logoFor(idx, "QMINE", "QMINE_ISSUER", "light"), "/logos/QMINE-light.png");
  assert.equal(logoFor(idx, "CFB", "CFB_ISSUER", "dark"), "/logos/CFB-light.png", "one picture serves both themes");
});

test("no logo for an asset that has none, before the index is in, or for another issuer's token of the same name", () => {
  assert.equal(logoFor(idx, "NOPE", "X", "dark"), null);
  assert.equal(logoFor(undefined, "QMINE", "QMINE_ISSUER", "dark"), null);
  assert.equal(logoFor(null, "QMINE", undefined, "dark"), null);
  assert.equal(logoFor(idx, "QMINE", "SOMEONE_ELSE", "dark"), null);
});

test("without an issuer the symbol must belong to one asset", () => {
  assert.equal(logoFor(idx, "QMINE", undefined, "dark"), "/logos/QMINE-dark.png");
  assert.equal(logoFor(idx, "TWIN", undefined, "dark"), null, "two issuers: which one is not known");
  assert.equal(logoFor(idx, "TWIN", "B", "dark"), "/logos/TWIN-B-light.png");
});

test("every file the saved index names is really there, and is a PNG", () => {
  const dir = join(import.meta.dirname, "..", "web", "public", "logos");
  const path = join(dir, "index.json");
  if (!existsSync(path)) return; // not fetched on this machine
  const saved = JSON.parse(readFileSync(path, "utf8")) as { assets: LogoIndex };
  let n = 0;
  for (const [symbol, list] of Object.entries(saved.assets)) {
    assert.match(symbol, /^[A-Za-z0-9]{1,7}$/);
    for (const e of list) {
      assert.ok(e.light || e.dark, `${symbol} has a picture`);
      for (const f of [e.light, e.dark]) {
        if (!f) continue;
        assert.match(f, /^[A-Za-z0-9._-]+\.png$/, "a plain file name: nothing that could climb out of the folder");
        const b = readFileSync(join(dir, f));
        assert.ok(b.length > 100 && b.length < 200_000, `${f}: ${b.length} bytes`);
        assert.deepEqual([...b.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${f} is a PNG`);
        n++;
      }
    }
  }
  assert.ok(n > 0);
});
