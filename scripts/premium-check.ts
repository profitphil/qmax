// Shows how far apart QX and QSwap priced each token that trades on both, from the trades QMax has already read. Reads a COPY
// of the trade index file (never the live one), makes no network calls and writes nothing.
//   npm run premium-check                          every token on both venues, same-hour data, 10M QU trades, 30 days
//   npm run premium-check -- QDOGE QMINE           only these
//   npm run premium-check -- --range=all --carry=3 --qu=1e6 --text
// Options: --range=7d|30d|90d|all  --carry=0..3  --qu=<reference trade in QU>  --file=<trades.json>  --text (print the sentences too)
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QubicRpc } from "../src/rpc.ts";
import { TradeIndex } from "../src/trades.ts";
import { assetNameFromU64 } from "../src/identity.ts";
import { DEFAULT_REFERENCE_QU, MAX_CARRY_HOURS, PREMIUM_RANGES, buildPremium, describePremium } from "../src/premium.ts";
import type { PremiumRange } from "../src/premium.ts";

const args = process.argv.slice(2);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const names = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());
const range = (opt("range") ?? "30d") as PremiumRange;
const carry = Number(opt("carry") ?? 0);
const referenceQu = Number(opt("qu") ?? DEFAULT_REFERENCE_QU);
if (!PREMIUM_RANGES.includes(range)) throw new Error(`--range must be one of ${PREMIUM_RANGES.join(", ")}`);
if (!Number.isInteger(carry) || carry < 0 || carry > MAX_CARRY_HOURS) throw new Error(`--carry must be 0 to ${MAX_CARRY_HOURS}`);
if (!Number.isFinite(referenceQu) || referenceQu <= 0) throw new Error("--qu must be a positive number of QU");

const source = opt("file") ?? new URL("../.cache/trades.json", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "qmax-premium-"));
try {
  const copy = join(dir, "trades.json");
  copyFileSync(source, copy);
  // never update()d: the index only loads the file
  const index = new TradeIndex(new QubicRpc({ maxRps: 1 }), { file: copy });
  const keys = Object.keys((JSON.parse(readFileSync(copy, "utf8")) as { assets: Record<string, unknown> }).assets);

  const pct = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(d)}%`);
  const gap = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${x > 0 ? "+" : ""}${x.toFixed(2)}%`);
  console.log(`Range ${range}, reference trade ${referenceQu.toLocaleString("en-US")} QU, ${carry ? `prices carried up to ${carry} h` : "same-hour data only"}\n`);
  console.log("token      traded h (QX/QSwap)  comparable (carried)  median gap  within 1%  beyond b/e  and deep  stretch med/max  QX step");
  const rows = keys
    .map((key) => ({ name: assetNameFromU64(BigInt(key.split("|")[0])), key }))
    .filter((a) => !names.length || names.includes(a.name))
    .map((a) => ({ ...a, r: buildPremium(a.name, index.hours(a.key, "QX"), index.hours(a.key, "QSwap"), { range, referenceQu, carryHours: carry }) }))
    .filter((a) => a.r.bothVenues)
    .sort((a, b) => (b.r.summary?.hours ?? 0) - (a.r.summary?.hours ?? 0));
  for (const { name, r } of rows) {
    const s = r.summary!;
    const be = s.enough ? `${pct(s.profitableShare)} (${pct(s.qswapDearerShare)} up, ${pct(s.qxDearerShare)} down)` : "not enough data";
    console.log(
      `${name.padEnd(10)} ${`${r.tradedHours.QX}/${r.tradedHours.QSwap}`.padEnd(20)} ${`${s.hours} (${s.carried})`.padEnd(21)} ${gap(s.medianPct).padStart(10)}  ${pct(s.closeShare).padStart(8)}  ${be.padEnd(33)} ${pct(s.profitableDeepShare).padStart(6)}  ${`${s.gaps.medianHours ?? "-"}/${s.gaps.longestHours ?? "-"}`.padEnd(15)}  ${s.qxStepPct === null ? "n/a" : `${s.qxStepPct.toFixed(2)}%`}${s.coarseQx ? " (coarse)" : ""}`,
    );
  }
  console.log(`\nBreak-even for a ${referenceQu.toLocaleString("en-US")} QU round trip: QSwap dearer by more than ${rows[0]?.r.breakEvenPct.qswapDearer ?? "n/a"}%, or QX dearer by more than ${rows[0]?.r.breakEvenPct.qxDearer ?? "n/a"}%.`);
  console.log("An indication from hourly averages, not a guarantee: it ignores the QX spread, slippage and that the legs are separate transactions.");
  if (args.includes("--text")) for (const { name, r } of rows) console.log(`\n${name}\n  ${describePremium(r, name).lines.join("\n  ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
