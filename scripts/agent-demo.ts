// Try QMax as an agent would. Reads nothing from anyone but you: the seed comes from your own environment and stays in this process.
//
//   npm run agent-demo                                   how to pay, and the free allowance (spends nothing)
//   QMAX_AGENT_SEED=... npm run agent-demo -- --max QDOGE --yes
//                                                        the whole agent flow in one run: ask for a Max plan, get the 402, pay for a session once through QPayhub,
//                                                        get the plan, then ask again inside the session (no new payment)
//   QMAX_AGENT_SEED=... npm run agent-demo -- --session --yes
//                                                        buys a session and nothing else (it is forgotten when this run ends, so --max is the better test)
//   QMAX_AGENT_SEED=... npm run agent-demo -- --buy CFB 10 --max-outlay 5000 --yes
//                                                        a guarded trade: quote, check, sign with your seed, send, report
//
// Nothing is spent or signed without --yes. Use a wallet that holds only what you are happy to test with.
import { QMaxClient, createX402Fetch } from "../sdk/index.ts";
import { agentTrade, contractPayer, seedSigner } from "../sdk/agent.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const base = process.env.QMAX_API ?? "http://localhost:8787";
const n = (x: number) => x.toLocaleString("en-US");

const info: any = await (await fetch(`${base}/v1/x402`)).json().catch(() => null);
if (!info?.session) {
  console.log(`${base} does not sell sessions by x402 (the server needs API_ACCESS=billing, or API_MAX_PRICE_QU set to sell Max plans, and API_X402 not off).`);
  process.exit(1);
}
console.log(`QMax at ${base}`);
console.log(`  A session is ${n(info.session.priceQu)} QU for ${info.session.seconds / 60} minutes, paid through QPayhub (${info.payTo.slice(0, 6)}…) to ${info.sellerId.slice(0, 6)}…`);
if (info.maxQuotePriceQu) console.log(`  Everything is free except Max plans (GET /v1/max): ${n(info.maxQuotePriceQu)} QU each from a prepaid key, or unlimited inside a session. Without either, GET /v1/max answers 402 and an x402 client pays for a session.`);
else console.log(`  Without one, you get a free allowance per minute; past it the API answers 402 and an x402 client pays for a session.`);

const seed = process.env.QMAX_AGENT_SEED;
const wantsSession = flag("--session");
const maxAsset = value("--max");
const trade = (["--buy", "--sell"] as const).find(flag);
if (!seed || (!wantsSession && !trade && !maxAsset)) {
  console.log(`\nNothing spent. Set QMAX_AGENT_SEED (55 lowercase letters, in your own terminal) and add --max ASSET, --session or --buy/--sell ASSET QTY to try it.`);
  process.exit(0);
}
// The wallet's address comes first and costs nothing: it is what you fund before the run that spends.
const signer = await seedSigner(seed);
console.log(`\nAgent wallet: ${signer.identity}`);
if (!flag("--yes")) {
  console.log(`This would spend real QU. Fund the wallet above first, then run it again with --yes to go ahead.`);
  process.exit(0);
}
// The most this run may spend is YOUR number (--max-spend, 20,000 QU by default), not what the server says it costs: a server that is not what it
// claims to be could otherwise raise its own limit by raising its own price.
const maxSpend = value("--max-spend") === undefined ? 20_000 : Number(value("--max-spend"));
if (!Number.isSafeInteger(maxSpend) || maxSpend <= 0) {
  console.log("--max-spend must be a whole number of QU above zero.");
  process.exit(1);
}
const pay = createX402Fetch({
  payer: contractPayer(signer, { onState: (s) => console.log(`  payment: ${s.status}${"txId" in s ? ` ${s.txId}` : ""}${s.status === "failed" ? ` ${s.error}` : ""}`) }),
  maxAmountPerCall: maxSpend,
  maxTotalSpend: maxSpend,
});
const client = new QMaxClient({ baseUrl: base, fetch: pay as typeof fetch });

if (maxAsset) {
  // A Max plan costs agents. The first call is answered 402, the client pays for a session once (QPayhub), and every call after that, for the session's hour, is free.
  const show = (label: string, plan: Awaited<ReturnType<typeof client.max>>) => {
    const top = plan.picks.find((p) => p.id === plan.recommendedId) ?? plan.picks[0];
    console.log(`${label}: ${top ? `recommended "${top.title}" (${top.actions.length} step${top.actions.length === 1 ? "" : "s"}): ${top.why}` : "no pick"}`);
    console.log(`  counted against your cap so far: ${n(pay.stats().totalSpent)} QU`);
  };
  try {
    console.log(`\nMax plan 1 for ${maxAsset}: asking (expect a 402, then one payment)…`);
    show("Max plan 1", await client.max({ asset: maxAsset, side: "buy", balanceQu: 5_000_000 }));
    console.log(`\nMax plan 2 for ${maxAsset}: asking again, inside the session (no new payment)…`);
    show("Max plan 2", await client.max({ asset: maxAsset, side: "buy", balanceQu: 10_000_000 }));
  } catch (e) {
    console.log(`No plan: ${e instanceof Error ? e.message : e}`);
    console.log(`Counted against your cap: ${n(pay.stats().totalSpent)} QU. A payment counts from the moment it is sent, because one that is sent and not yet confirmed can still land: check the transaction on the explorer before trying again.`);
  }
}

if (wantsSession) {
  const res = await pay(`${base}/v1/session`);
  console.log(res.ok ? `Session bought: ${JSON.stringify(await res.json())}` : `Not bought: ${res.status} ${await res.text()}`);
  console.log(`Counted against your cap: ${n(pay.stats().totalSpent)} QU (a payment counts from the moment it is sent).`);
}

if (trade) {
  const [asset, qty] = [args[args.indexOf(trade) + 1], Number(args[args.indexOf(trade) + 2])];
  const maxOutlayQu = Number(value("--max-outlay"));
  const price = Number(value(trade === "--buy" ? "--max-price" : "--min-price"));
  if (trade === "--sell" && !(price > 0)) {
    console.log(`A sale needs --min-price P (the least to accept per unit): its outlay is only fees, so without a price floor nothing else limits it.`);
    process.exit(1);
  }
  if (!asset || !Number.isInteger(qty) || !(maxOutlayQu > 0)) {
    console.log(`A trade needs an asset, a quantity and --max-outlay N (the most QU it may spend).`);
    process.exit(1);
  }
  const result = await agentTrade({
    client,
    signer,
    side: trade === "--buy" ? "buy" : "sell",
    asset,
    qty,
    limits: { maxOutlayQu, ...(trade === "--buy" ? { maxAveragePriceQu: price || undefined } : { minAveragePriceQu: price || 0 }) },
    onState: (id, s) => console.log(`  ${id}: ${s.status}${s.txId ? ` ${s.txId}` : ""}${s.error ? ` ${s.error}` : ""}`),
  }).catch((e) => {
    console.log(`Not traded: ${e instanceof Error ? e.message : e}`);
    return null;
  });
  if (result) console.log(result.ok ? `Done: ${JSON.stringify(result.outcome)}` : "The trade stopped before it finished; check the steps above.");
}
