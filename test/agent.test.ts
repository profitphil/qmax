import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import cryptoModule from "@qubic-lib/qubic-ts-library/dist/crypto";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper";
import { createApi } from "../src/api.ts";
import type { QuoteResponse } from "../src/apitypes.ts";
import { SnapshotData } from "../src/data.ts";
import { buildExecutionPlan } from "../src/exec.ts";
import type { TxStep } from "../src/exec.ts";
import { bytesToHex } from "../src/identity.ts";
import { Meter } from "../src/meter.ts";
import { QMaxClient, QMaxError } from "../sdk/index.ts";
import { X402Error, createX402Fetch } from "../sdk/x402.ts";
import type { Payer } from "../sdk/x402.ts";
import { TradeRefused, agentTrade, checkPlan, contractPayer, nonceFromHex, seedSigner, worstCasePrice } from "../sdk/agent.ts";
import type { StepChain } from "../sdk/agent.ts";
import { QPAYHUB_IDENTITY, SESSION_RESOURCE_ID, UsedLedger, X402Gate, resourceTag } from "../src/x402.ts";
import { SELLER, fakeNetwork, randomTxId } from "./x402-helpers.ts";

const SEED = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabc";
const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";

/** The library's own crypto, to check signatures with the code that makes them. */
async function qubicCrypto(): Promise<any> {
  const m: any = cryptoModule;
  return await (m.default ?? m);
}

function decodeTx(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inputSize = v.getUint16(78, true);
  return {
    source: bytes.slice(0, 32),
    dest: bytes.slice(32, 64),
    amount: Number(v.getBigInt64(64, true)),
    tick: v.getUint32(72, true),
    inputType: v.getUint16(76, true),
    payload: bytes.slice(80, 80 + inputSize),
    body: bytes.slice(0, 80 + inputSize),
    signature: bytes.slice(80 + inputSize),
  };
}

async function signedBy(bytes: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  const c = await qubicCrypto();
  const tx = decodeTx(bytes);
  const digest = new Uint8Array(32);
  c.K12(tx.body, digest, 32);
  return c.schnorrq.verify(publicKey, digest, tx.signature) === 1;
}

const keys = await new QubicHelper().createIdPackage(SEED);
const signer = await seedSigner(SEED);

// ---------------- signing ----------------

test("a seed signs transactions that verify, and a changed transaction does not", async () => {
  assert.equal(signer.identity, keys.publicId);
  const net = fakeNetwork();
  const sent: Uint8Array[] = [];
  const chain: StepChain = { tick: async () => 5000, broadcast: async (b) => (sent.push(b), randomTxId()), wait: async () => ({ included: true, moneyFlew: true }) };
  const step: TxStep = { id: "t", kind: "qx-bid", description: "t", to: { contractIndex: 1 }, inputType: 6, amountQu: 300, payload: new Uint8Array(56).fill(9) };
  const { runSteps, TICK_OFFSET, INSTANT_SIGNER_TICK_OFFSET } = await import("../web/exec/run.ts");
  // a signer that answers at once (an agent's own key) asks for the short lead
  assert.equal(await runSteps(signer.identity, [step], (tx) => signer.sign(tx), () => {}, undefined, chain, undefined, INSTANT_SIGNER_TICK_OFFSET), true);
  assert.equal(sent.length, 1);
  const tx = decodeTx(sent[0]);
  assert.deepEqual([tx.inputType, tx.amount, tx.tick, tx.dest[0], bytesToHex(tx.source)], [6, 300, 5020, 1, bytesToHex(keys.publicKey)]);
  // and by default the lead is the one a person needs to open a wallet app and approve: 50 ticks, about 33 seconds
  assert.equal(TICK_OFFSET, 50);
  sent.length = 0;
  assert.equal(await runSteps(signer.identity, [step], (tx) => signer.sign(tx), () => {}, undefined, chain), true);
  assert.equal(decodeTx(sent[0]).tick, 5050);
  sent.length = 0;
  assert.equal(await runSteps(signer.identity, [step], (tx) => signer.sign(tx), () => {}, undefined, chain, undefined, INSTANT_SIGNER_TICK_OFFSET), true);
  assert.equal(await signedBy(sent[0], keys.publicKey), true);
  const tampered = new Uint8Array(sent[0]);
  tampered[70] ^= 1; // change the amount
  assert.equal(await signedBy(tampered, keys.publicKey), false);
  void net;
});

test("a bad seed is refused without being repeated", async () => {
  const bad = "not-a-seed-but-secret-looking-text";
  await assert.rejects(seedSigner(bad), (e: Error) => /55 lowercase letters/.test(e.message) && !e.message.includes(bad));
});

// ---------------- paying ----------------

/** A network where each broadcast transaction is read the way QPayhub would, so the server can find its receipt. */
function agentNetwork() {
  const net = fakeNetwork();
  const sent: Uint8Array[] = [];
  const chain: StepChain = {
    tick: async () => net.state.tick,
    broadcast: async (bytes) => {
      sent.push(bytes);
      const tx = decodeTx(bytes);
      if (tx.dest[0] === 29 && tx.dest.slice(1).every((b) => b === 0) && tx.payload.length === 72) {
        const nonce = new DataView(tx.payload.buffer, tx.payload.byteOffset, 72).getBigUint64(64, true);
        return net.record({ payer: tx.source, sourceId: signer.identity, seller: tx.payload.slice(0, 32), resourceId: tx.payload.slice(32, 64), nonce, amount: tx.amount, destId: QPAYHUB_IDENTITY }).txId;
      }
      return randomTxId();
    },
    wait: async () => ({ included: true, moneyFlew: true }),
  };
  return { net, chain, sent };
}

const server = (net: ReturnType<typeof fakeNetwork>, freePerMin = 2, price = 10_000) => {
  const gate = new X402Gate({ priceQu: price, seconds: 3600, sellerId: SELLER, chain: net.chain, ledger: new UsedLedger(), secrets: { ticket: "t", grant: "g" } });
  const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: SELLER, lookupReceipt: async () => null });
  const data = new SnapshotData([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
  const s = createApi({ data, meter, x402: gate, freePerMin });
  return new Promise<{ base: string; asset: string; close: () => void }>((resolve) => s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}`, asset: data.assets()[0], close: () => s.close() })));
};

/** Uses up the free allowance with a plain request, so that the next one is answered with a 402. */
const burnFreeCall = (srv: { base: string; asset: string }) => fetch(`${srv.base}/v1/quote?side=buy&asset=${srv.asset}&qty=100000`).then((r) => r.arrayBuffer());

test("the whole agent loop: it hits the free limit, signs a real QPAYHUB.Pay with its own seed, and QMax accepts the receipt", async () => {
  const { net, chain, sent } = agentNetwork();
  const srv = await server(net);
  after(() => srv.close());
  const pay = createX402Fetch({ payer: contractPayer(signer, { chain }), maxAmountPerCall: 20_000, confirmIntervalMs: 0, sleep: async () => {} });
  const client = new QMaxClient({ baseUrl: srv.base, fetch: pay as typeof fetch });

  await client.quote({ side: "buy", asset: srv.asset, qty: 100_000 });
  await client.quote({ side: "buy", asset: srv.asset, qty: 100_000 });
  assert.equal(sent.length, 0); // the free allowance costs nothing
  const q = await client.quote({ side: "buy", asset: srv.asset, qty: 100_000 }); // over the limit: pays, then gets this very answer
  assert.ok(q.route.length >= 1);
  assert.equal(sent.length, 1);
  assert.equal(pay.stats().totalSpent, 10_000);

  // what it signed and sent
  const tx = decodeTx(sent[0]);
  assert.equal(await signedBy(sent[0], keys.publicKey), true); // signed by the agent's own key
  assert.deepEqual([tx.dest[0], tx.inputType, tx.amount, tx.payload.length], [29, 1, 10_000, 72]); // QPAYHUB.Pay, the advertised price
  assert.equal(bytesToHex(tx.payload.slice(32, 64)), bytesToHex(resourceTag(SESSION_RESOURCE_ID)));
  // an agent signs at once, so it keeps the short lead (20 ticks) and its payment confirms sooner than a person's would (50)
  assert.equal(tx.tick, net.state.tick + 20);

  // and it has a session now: more calls, no more payments
  for (let i = 0; i < 6; i++) await client.quote({ side: "buy", asset: srv.asset, qty: 100_000 });
  assert.equal(sent.length, 1);
  assert.equal(pay.stats().hasSession, true);
});

test("many requests at once pay for one session, not one each", async () => {
  const { net, chain, sent } = agentNetwork();
  const srv = await server(net, 1);
  after(() => srv.close());
  const pay = createX402Fetch({ payer: contractPayer(signer, { chain }), confirmIntervalMs: 0, sleep: async () => {} });
  const client = new QMaxClient({ baseUrl: srv.base, fetch: pay as typeof fetch });
  await client.quote({ side: "buy", asset: srv.asset, qty: 100_000 }); // uses the one free call
  const results = await Promise.all(Array.from({ length: 6 }, () => client.quote({ side: "buy", asset: srv.asset, qty: 100_000 })));
  assert.equal(results.length, 6);
  assert.equal(sent.length, 1);
});

test("spending limits stop a payment before anything is signed", async () => {
  const { net, chain, sent } = agentNetwork();
  const srv = await server(net, 1);
  after(() => srv.close());
  await burnFreeCall(srv); // so the next call is the one that has to pay
  const attempt = (o: Parameters<typeof createX402Fetch>[0]) =>
    new QMaxClient({ baseUrl: srv.base, fetch: createX402Fetch({ payer: contractPayer(signer, { chain }), confirmIntervalMs: 0, sleep: async () => {}, ...o }) as typeof fetch }).quote({ side: "buy", asset: srv.asset, qty: 100_000 });
  await assert.rejects(attempt({ maxAmountPerCall: 9_999 }), (e: unknown) => e instanceof X402Error && e.code === "limit_per_call");
  await assert.rejects(attempt({ maxAmountPerCall: 20_000, maxTotalSpend: 5_000 }), (e: unknown) => e instanceof X402Error && e.code === "limit_total");
  await assert.rejects(attempt({ payer: undefined }), (e: unknown) => e instanceof X402Error && e.code === "no_payer");
  assert.equal(sent.length, 0); // nothing was ever signed
  await assert.rejects(attempt({ autoPay: false }), (e: unknown) => e instanceof QMaxError && e.status === 402); // the 402 is handed back untouched
  assert.equal(sent.length, 0);
  await attempt({ maxAmountPerCall: 10_000, maxTotalSpend: 10_000 }); // exactly at the cap is allowed
  assert.equal(sent.length, 1);
});

test("a payment the network is slow to show is waited for, then accepted", async () => {
  const net = fakeNetwork();
  const srv = await server(net, 1);
  after(() => srv.close());
  await burnFreeCall(srv);
  let sleeps = 0;
  const hidden = new Map<string, any>();
  const slow: Payer = {
    name: "slow",
    async pay(req) {
      const challenge = { accepts: [{ amount: String(req.amount), payTo: req.payTo, extra: { sellerId: req.sellerId, resourceId: req.resourceId } }], paymentTicket: `${Buffer.from(JSON.stringify({ nonce: req.nonceHex })).toString("base64url")}.x` };
      const { txId } = net.pay(challenge);
      hidden.set(txId, net.txs.get(txId));
      net.txs.delete(txId); // in a block, but the node answering does not know it yet
      return { txId };
    },
  };
  const fetchPaying = createX402Fetch({ payer: slow, confirmAttempts: 5, confirmIntervalMs: 0, sleep: async () => { if (++sleeps === 2) for (const [id, tx] of hidden) net.txs.set(id, tx); } });
  const r = await new QMaxClient({ baseUrl: srv.base, fetch: fetchPaying as typeof fetch }).quote({ side: "buy", asset: srv.asset, qty: 100_000 });
  assert.ok(r.route.length >= 1);
  assert.equal(sleeps, 2); // asked again until the payment showed

  const never = createX402Fetch({ payer: { name: "never", pay: async () => ({ txId: "z".repeat(60) }) }, confirmAttempts: 3, confirmIntervalMs: 0, sleep: async () => {} });
  await assert.rejects(new QMaxClient({ baseUrl: srv.base, fetch: never as typeof fetch }).quote({ side: "buy", asset: srv.asset, qty: 100_000 }), (e: unknown) => e instanceof X402Error && e.code === "confirm_timeout");
});

test("the payer only ever pays QPayhub, whatever the server says", async () => {
  const payer = contractPayer(signer, { chain: agentNetwork().chain });
  const ok = { settlement: "contract", payTo: QPAYHUB_IDENTITY, amount: 10_000, asset: "QUBIC", network: "qubic:mainnet", resourceId: SESSION_RESOURCE_ID, sellerId: SELLER, nonceHex: "0102030405060708", url: "u" };
  const refused = (over: object) => assert.rejects(payer.pay({ ...ok, ...over }), (e: unknown) => e instanceof X402Error);
  await refused({ payTo: SELLER }); // a plain transfer to the seller, or to anyone else the server names
  await refused({ payTo: "A".repeat(60) });
  await refused({ settlement: "direct" });
  await refused({ nonceHex: null });
  await refused({ nonceHex: "xyz" });
  await refused({ resourceId: "" });
  await refused({ sellerId: "not an identity" });
  assert.equal(nonceFromHex("0100000000000000"), 1n); // little-endian, as the contract reads it
  assert.equal(nonceFromHex("0001000000000000"), 256n);
});

// ---------------- trading ----------------

const info = { issuer: ISSUER, assetName: "CFB", transferFeeQu: { qx: 100, qswap: 100 } };
/** A leg whose own numbers agree with its limits at 1% slippage, the way a genuine quote's do (the plan check compares the two). */
const leg = (venue: "QX" | "QSwap", execution: any) => {
  let totalQu: number;
  let priceRangeQu: { best: number; worst: number } | undefined;
  if (execution.type === "qx-bid") {
    const worst = Math.floor(execution.limitPrice / 1.01);
    totalQu = worst * execution.qty;
    priceRangeQu = { best: worst, worst };
  } else if (execution.type === "qx-ask") {
    const worst = Math.ceil(execution.limitPrice / 0.99);
    totalQu = worst * execution.qty;
    priceRangeQu = { best: worst, worst };
  } else if (execution.type === "qswap-buy") totalQu = Math.floor(execution.maxQuIn / 1.01);
  else totalQu = Math.ceil(execution.minQuOut / 0.99);
  return { venue, qty: execution.qty, shareOfOrder: 1, totalQu, effectivePriceQu: totalQu / execution.qty, priceImpact: 0, feesQu: 0, fixedCostQu: 0, ...(priceRangeQu ? { priceRangeQu } : {}), execution };
};
const quoteOf = (side: "buy" | "sell", route: any[], over: object = {}): QuoteResponse =>
  ({ asset: "CFB", side, qty: route.reduce((a, r) => a + r.qty, 0), filledQty: 0, fillable: true, executable: true, totalQu: route.reduce((a, r) => a + r.totalQu, 0), averagePriceQu: 100, slippageBps: 100, assetInfo: info, route, alternatives: [], warnings: [], ...over }) as QuoteResponse;
const buyQuote = () => quoteOf("buy", [leg("QX", { type: "qx-bid", qty: 10, limitPrice: 101 })]);
const sellQuote = (minOut = 900) => quoteOf("sell", [leg("QSwap", { type: "qswap-sell", qty: 10, minQuOut: minOut })]);

test("the worst price a quote allows comes from its own limits", () => {
  assert.equal(worstCasePrice(buyQuote()), 101);
  assert.equal(worstCasePrice(sellQuote(900)), 90);
  assert.equal(worstCasePrice(quoteOf("buy", [leg("QX", { type: "qx-bid", qty: 10, limitPrice: 100 }), leg("QSwap", { type: "qswap-buy", qty: 30, maxQuIn: 4_000 })])), (1000 + 4000) / 40);
});

test("a plan inside the limits is fine; each way of going outside them is named", () => {
  const plan = buildExecutionPlan(buyQuote());
  assert.deepEqual(checkPlan(plan, buyQuote(), { maxOutlayQu: 2_000 }), []);
  assert.match(checkPlan(plan, buyQuote(), { maxOutlayQu: 1_000 }).join(" | "), /could spend 1,010 QU, over the limit of 1,000 QU/);
  assert.match(checkPlan(plan, buyQuote(), { maxOutlayQu: 2_000, allowedAssets: ["QX"] })[0], /CFB is not on the allowed list/);
  assert.deepEqual(checkPlan(plan, buyQuote(), { maxOutlayQu: 2_000, allowedAssets: ["cfb"] }), []);
  assert.match(checkPlan(plan, buyQuote(), { maxOutlayQu: 2_000, maxAveragePriceQu: 100 })[0], /worst price it allows, 101\.0000 QU each, is above 100/);
  assert.deepEqual(checkPlan(plan, buyQuote(), { maxOutlayQu: 2_000, maxAveragePriceQu: 101 }), []);
  assert.throws(() => checkPlan(plan, buyQuote(), {} as never), /maxOutlayQu is required/);
  assert.throws(() => checkPlan(plan, buyQuote(), { maxOutlayQu: Infinity }), /maxOutlayQu is required/);
});

test("a sale must say the least it will take, because a hostile quote could otherwise sell for nothing", () => {
  const q = sellQuote(900);
  const plan = buildExecutionPlan(q, { 13: 10 });
  assert.throws(() => checkPlan(plan, q, { maxOutlayQu: 200_000 }), /minAveragePriceQu is required for a sale/);
  assert.deepEqual(checkPlan(plan, q, { maxOutlayQu: 200_000, minAveragePriceQu: 90 }), []);
  assert.match(checkPlan(plan, q, { maxOutlayQu: 200_000, minAveragePriceQu: 95 })[0], /worst price it allows, 90\.0000 QU each, is below 95/);
  const greedy = sellQuote(1); // the server set a floor of 1 QU in total
  assert.match(checkPlan(buildExecutionPlan(greedy, { 13: 10 }), greedy, { maxOutlayQu: 200_000, minAveragePriceQu: 90 })[0], /is below 90/);
});

test("a plan that sends money anywhere but QX and QSwap is never signed", () => {
  const q = buyQuote();
  const evil = (step: Partial<TxStep>) => ({ steps: [{ id: "x", kind: "qx-bid", description: "", to: { contractIndex: 1 }, inputType: 6, amountQu: 1, payload: new Uint8Array(), ...step } as TxStep], maxOutlayQu: 1 });
  assert.match(checkPlan(evil({ to: { identity: SELLER } }), q, { maxOutlayQu: 100 })[0], /somewhere other than QX or QSwap/);
  assert.match(checkPlan(evil({ to: { contractIndex: 29 } }), q, { maxOutlayQu: 100 })[0], /somewhere other than QX or QSwap/);
  assert.match(checkPlan(evil({ kind: "payment" }), q, { maxOutlayQu: 100 })[0], /a payment, which a trade never needs/);
  assert.match(checkPlan({ steps: [], maxOutlayQu: 0 }, q, { maxOutlayQu: 100 })[0], /no steps/);
});

function tradeRig(quote: QuoteResponse) {
  const { net, chain, sent } = agentNetwork();
  const holdings: Record<number, number> = {};
  const balance = { qu: 1_000_000 };
  const states: string[] = [];
  const env = {
    snapshot: async () => ({ balanceQu: balance.qu, holdings: { ...holdings } }),
    openOrders: async () => [],
    sleep: async () => {},
  };
  // the venue "fills" the order as soon as it is broadcast
  const filling: StepChain = { ...chain, broadcast: async (b) => { const id = await chain.broadcast(b); if (decodeTx(b).dest[0] === 1) { holdings[1] = 10; balance.qu -= 1000; } return id; } };
  const client = { quote: async () => quote };
  return { net, sent, holdings, states, run: (limits: any, over: object = {}) => agentTrade({ client, signer, side: quote.side, asset: "CFB", qty: quote.qty, limits, chain: filling, env, onState: (id, s) => states.push(`${id}:${s.status}`), ...over }) };
}

test("a guarded trade: quote, check, sign with its own key, send, then read the wallet to say what happened", async () => {
  const rig = tradeRig(buyQuote());
  const r = await rig.run({ maxOutlayQu: 2_000, maxAveragePriceQu: 105 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome?.status, "filled");
  assert.equal(r.outcome?.filledQty, 10);
  assert.equal(rig.sent.length, 1);
  const tx = decodeTx(rig.sent[0]);
  assert.deepEqual([tx.dest[0], tx.inputType, tx.amount], [1, 6, 1010]); // QX, add-to-bid, the limit price times the quantity
  assert.equal(await signedBy(rig.sent[0], keys.publicKey), true);
  assert.deepEqual(rig.states, ["qx-bid:signing", "qx-bid:confirming", "qx-bid:done"]);
});

test("a trade outside the limits signs nothing at all", async () => {
  const rig = tradeRig(buyQuote());
  await assert.rejects(rig.run({ maxOutlayQu: 500 }), (e: unknown) => e instanceof TradeRefused && /over the limit/.test(e.message));
  await assert.rejects(rig.run({ maxOutlayQu: 2_000, allowedAssets: ["QX"] }), TradeRefused);
  await assert.rejects(rig.run({}), /maxOutlayQu is required/);
  assert.equal(rig.sent.length, 0);
  assert.deepEqual(rig.states, []);
});

test("a hostile sale quote is refused before the seed is used", async () => {
  const rig = tradeRig(sellQuote(1));
  rig.holdings[13] = 10;
  await assert.rejects(rig.run({ maxOutlayQu: 200_000, minAveragePriceQu: 90 }), (e: unknown) => e instanceof TradeRefused && /below 90/.test(e.message));
  assert.equal(rig.sent.length, 0);
});

test("an order that cannot be filled or paid for stops before signing", async () => {
  const unfillable = tradeRig(quoteOf("buy", [leg("QX", { type: "qx-bid", qty: 10, limitPrice: 101 })], { fillable: false, filledQty: 4 }));
  await assert.rejects(unfillable.run({ maxOutlayQu: 2_000 }), /Only 4 of 10/);
  assert.equal(unfillable.sent.length, 0);
});
