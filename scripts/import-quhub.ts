// Reads older QX history from Quhub (quhub.app) into .cache/quhub.json, once. See src/quhub.ts for what it is, what it is not, and why.
//
//   npm run import-quhub                what is there, written to .cache/quhub.json (about 80 requests, one a second: two or three minutes)
//   npm run import-quhub -- --only CFB,QX   just those assets, merged into the file that is already there (to try it, or to read a few again)
//   npm run import-quhub -- --dry-run   reads and reports, writes nothing
//
// It reads Quhub's public API as its own web page does, slowly, and stops if the server starts failing. The list of assets comes from QMax's own
// catalog (.cache/catalog.json: start the server once first).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readQuhub, readSnapshotFile, saveSnapshot } from "../src/quhub.ts";

const args = process.argv.slice(2);
const only = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").toUpperCase().split(",").filter(Boolean) : undefined;
const dry = args.includes("--dry-run");
const root = new URL("../", import.meta.url);
const catalogFile = fileURLToPath(new URL(".cache/catalog.json", root));
const out = fileURLToPath(new URL(".cache/quhub.json", root));

if (!existsSync(catalogFile)) {
  console.error("There is no .cache/catalog.json yet: start the server once (npm start) so it can list the assets, then run this again.");
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(catalogFile, "utf8")) as { symbol: string; issuer: string; venues?: string[] }[];
const assets = catalog.filter((a) => a.venues?.length && (!only || only.includes(a.symbol.toUpperCase()))).map((a) => ({ symbol: a.symbol, issuer: a.issuer }));
if (!assets.length) {
  console.error(only ? `No asset called ${only.join(", ")} in the catalog.` : "The catalog has no assets with a market.");
  process.exit(1);
}
console.log(`Reading ${assets.length} asset${assets.length === 1 ? "" : "s"} from quhub.app, one request a second...`);
let n = 0;
const snap = await readQuhub({
  assets,
  onAsset: (s, i) => console.log(`${String(++n).padStart(3)}/${assets.length} ${s.padEnd(8)} ${i.days ? `${i.days} days${i.trades !== null ? `, all ${i.trades} trades` : ""}` : ""}${i.note ? `  (${i.note})` : ""}`),
});
// A few named assets are merged into what is already there; all of them replace it.
if (only) {
  const before = readSnapshotFile(out);
  if (before) snap.assets = { ...before.assets, ...snap.assets };
}
const list = Object.values(snap.assets);
const withTrades = list.filter((a) => a.trades).length;
console.log(`\n${list.length} assets with history, ${list.reduce((s, a) => s + a.daily.length, 0).toLocaleString("en-US")} daily points, ${withTrades} with every trade (exact times).`);
if (dry) console.log("Dry run: nothing written.");
else {
  saveSnapshot(out, snap);
  console.log(`Written to ${out}. Restart the server to use it.`);
}
