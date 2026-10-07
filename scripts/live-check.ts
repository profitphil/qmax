// Read-only check against the live chain through a running QMax API (npm run api).
// For every tradable asset it asks for a small buy and sell quote, checks the response is sane,
// builds the transactions a wallet would sign (nothing is signed or sent), and confirms QSwap
// prices match the contract's own quote. Usage: npm run live-check [-- http://localhost:8787]
import { buildExecutionPlan } from "../src/exec.ts";

// Only a real address counts, so a stray argument (say a pasted "#") cannot break the run.
const arg = process.argv[2];
const base = arg?.startsWith("http") ? arg : "http://localhost:8787";
// With QMax's own key (API_KEY, the same one the server was started with) there is no limit. Without it the API
// allows 60 quotes a minute per IP, so a 429 is waited out instead of counted as a failure.
const headers: Record<string, string> = process.env.API_KEY ? { "x-api-key": process.env.API_KEY } : {};
const get = async (path: string): Promise<{ status: number; body: any }> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, { headers });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 10) * 1000 + 250));
      continue;
    }
    return { status: res.status, body: await res.json() };
  }
};

const { body: list } = await get("/v1/assets");
console.log(`${list.assets.length} assets (scan ready: ${list.ready})`);
let problems = 0;
const fail = (msg: string) => {
  problems++;
  console.log("  FAIL", msg);
};

for (const a of list.assets) {
  // a quantity worth roughly 1M QU, at least 1 unit
  const qty = Math.max(1, Math.round(1_000_000 / Math.max(a.priceQu ?? 1, 1)));
  for (const side of ["buy", "sell"]) {
    const label = `${a.id} ${side} ${qty}`;
    const { status, body } = await get(`/v1/quote?side=${side}&asset=${encodeURIComponent(a.id)}&qty=${qty}`);
    if (status !== 200) {
      fail(`${label}: HTTP ${status} ${body.error ?? ""}`);
      continue;
    }
    if (!body.fillable) {
      console.log(`  skip ${label}: not fillable at this size (${body.warnings?.[0] ?? "no liquidity"})`);
      continue;
    }
    if (!body.executable) fail(`${label}: not executable (missing asset info)`);
    const sum = body.route.reduce((s: number, r: { qty: number }) => s + r.qty, 0);
    if (sum !== qty) fail(`${label}: route fills ${sum}, not ${qty}`);
    if (!(body.totalQu > 0)) fail(`${label}: non-positive total`);
    try {
      const holdings = side === "sell" ? { 1: qty, 13: qty } : {};
      const plan = buildExecutionPlan(body, holdings);
      if (!plan.steps.length) fail(`${label}: empty execution plan`);
    } catch (e) {
      fail(`${label}: plan failed: ${e instanceof Error ? e.message : e}`);
    }
    for (const c of body.onChainCheck ?? []) {
      if (c.differenceQu !== 0) fail(`${label}: QSwap model differs from contract by ${c.differenceQu} QU (${c.modelQu} vs ${c.onChainQu})`);
    }
    const venues = body.route.map((r: { venue: string }) => r.venue).join("+");
    console.log(`  ok   ${label}: ${venues}, total ${Math.round(body.totalQu).toLocaleString()} QU${body.onChainCheck?.length ? ", on-chain check matched" : ""}`);
  }
}
console.log(problems ? `\n${problems} problem(s) found` : "\nAll checks passed");
process.exit(problems ? 1 : 0);
