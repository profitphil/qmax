// Copies the asset logos from qubictrade.com into web/public/logos so QMax can show them from its own origin (nothing is fetched from a third party at
// page load, as the Content-Security-Policy requires). Usage:
//
//   npm run logos                 fetch what is missing (the API must be running: it lists the assets)
//   npm run logos -- --force      fetch everything again
//   npm run logos -- --dry-run    only report what would be saved
//
// qubictrade.com serves a logo for each listed asset at /public/assets/icons/asset_<NAME>-<ISSUER>_logo_<light|dark>.png. Many assets have no logo of their own
// and get the same placeholder; a picture that more than two different assets share is treated as that placeholder and left out, so those assets keep QMax's
// own lettered badge. Pictures are checked (a real PNG, not too big), shrunk to a size a list can use (macOS `sips`, if it is there), and one request is made at a time.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.API_URL ?? "http://127.0.0.1:8787";
const SOURCE = "https://qubictrade.com/public/assets/icons";
const OUT = join(import.meta.dirname, "..", "web", "public", "logos");
const MAX_BYTES = 2_000_000;
const SIZE = 128; // pixels on the long side: lists show them at 22 to 44 CSS pixels
const force = process.argv.includes("--force");
const dry = process.argv.includes("--dry-run");

interface Asset {
  symbol: string;
  issuer: string;
}
interface Entry {
  issuer: string;
  light?: string;
  dark?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

async function get(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url, { headers: { "user-agent": "QMax-logo-import/0.1" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length <= MAX_BYTES && isPng(buf) ? buf : null; // a missing file can answer with the site's own page: only a real PNG counts
}

const assets = ((await (await fetch(`${API}/v1/assets`)).json()) as { assets: Asset[] }).assets.filter((a) => a.issuer && /^[A-Za-z0-9]{1,7}$/.test(a.symbol));
console.log(`${assets.length} assets listed`);

type Found = { asset: Asset; variant: "light" | "dark"; bytes: Uint8Array; hash: string };
const found: Found[] = [];
for (const asset of assets) {
  for (const variant of ["light", "dark"] as const) {
    try {
      const bytes = await get(`${SOURCE}/asset_${asset.symbol}-${asset.issuer}_logo_${variant}.png`);
      if (bytes) found.push({ asset, variant, bytes, hash: createHash("sha256").update(bytes).digest("hex") });
    } catch (e) {
      console.warn(`${asset.symbol} ${variant}: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(120);
  }
}

// A picture several different assets share is the site's placeholder, not a logo.
const sharedBy = new Map<string, Set<string>>();
for (const f of found) sharedBy.set(f.hash, (sharedBy.get(f.hash) ?? new Set()).add(`${f.asset.symbol}|${f.asset.issuer}`));
const placeholder = new Set([...sharedBy].filter(([, who]) => who.size > 2).map(([h]) => h));
const real = found.filter((f) => !placeholder.has(f.hash));
console.log(`${found.length} pictures found, ${found.length - real.length} are shared placeholders (${placeholder.size} different), ${real.length} kept`);

const index = new Map<string, Entry>();
let saved = 0;
let bytesOut = 0;
if (!dry) mkdirSync(OUT, { recursive: true });
// the same picture for light and dark is kept once (the page uses the one it has for either theme)
const same = new Set(real.filter((f) => f.variant === "dark" && real.some((g) => g.variant === "light" && g.asset === f.asset && g.hash === f.hash)).map((f) => f));
for (const f of real) {
  if (same.has(f)) continue;
  const key = `${f.asset.symbol}|${f.asset.issuer}`;
  const file = `${safeName(f.asset.symbol)}-${f.asset.issuer.slice(0, 8)}-${f.variant}.png`;
  const path = join(OUT, file);
  if (!dry && (force || !existsSync(path))) {
    writeFileSync(path, f.bytes);
    try {
      execFileSync("sips", ["-Z", String(SIZE), path], { stdio: "ignore" }); // only shrinks what is bigger
    } catch {
      // no sips: the picture is kept as it came
    }
    saved++;
  }
  if (!dry) bytesOut += statSync(path).size;
  const e = index.get(key) ?? { issuer: f.asset.issuer };
  e[f.variant] = file;
  index.set(key, e);
}
const bySymbol: Record<string, Entry[]> = {};
for (const [key, e] of index) (bySymbol[key.split("|")[0]] ??= []).push(e);
if (!dry) {
  writeFileSync(join(OUT, "index.json"), JSON.stringify({ source: "https://qubictrade.com", fetchedAt: new Date().toISOString(), assets: bySymbol }, null, 1) + "\n");
  console.log(`saved ${saved} new files; ${index.size} assets have a logo; ${Math.round(bytesOut / 1024)} KB in ${OUT}`);
} else console.log(`dry run: ${index.size} assets would have a logo`);
