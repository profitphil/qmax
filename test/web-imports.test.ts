import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The page is built from web/main.tsx and everything it imports. Server code (anything that reads files, or imports a node: module) must not be in that set: it fails to load in the
 * browser (the dev server throws, and a built page carries dead weight). This follows the page's real imports, skipping `import type` (erased at build time), and names the path to the
 * first server-only module it meets.
 */
const ROOT = resolve(import.meta.dirname, "..");
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"\n;]*?\s+from\s+)?["']([^"']+)["']/g;

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(c) && /\.(tsx?|mjs)$/.test(c)) return c;
  return null;
}

test("nothing the page imports reaches a node: module or a file-reading server module", () => {
  const seen = new Map<string, string[]>();
  const bad: string[] = [];
  const walk = (file: string, trail: string[]) => {
    if (seen.has(file)) return;
    seen.set(file, trail);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT)) {
      const [, , isType, spec] = m;
      if (isType) continue;
      if (spec.startsWith("node:")) bad.push(`${[...trail, file].map((f) => f.slice(ROOT.length + 1)).join(" -> ")} -> ${spec}`);
      const next = resolveImport(file, spec);
      if (next) walk(next, [...trail, file]);
    }
  };
  walk(join(ROOT, "web/main.tsx"), []);
  assert.ok(seen.size > 50, "the walk reached the page's modules");
  assert.deepEqual(bad, [], "server-only modules in the page:\n" + bad.join("\n"));
});
