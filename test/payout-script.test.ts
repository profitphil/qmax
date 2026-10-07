import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { PAYWALL } from "../src/config.ts";
import { identityToBytes } from "../src/identity.ts";
import { batchStep, buildBatches } from "../src/payouts.ts";
import type { Batch } from "../src/payouts.ts";
import { QPAYHUB_IDENTITY } from "../src/x402.ts";

/**
 * scripts/payout.ts run for real, as a dry run (no seed, nothing signed), against a fake QMax server and a fake archive on this machine. It is the
 * signer's last line of defence: whatever the server says, it must refuse a plan that could misdirect money and show nothing that could redraw
 * the terminal. (Signing itself needs the owner's seed and is never exercised here.)
 */

const OWNER = PAYWALL.recipient;
const w = (i: number) => "Q" + String.fromCharCode(66 + i).repeat(19) + "R" + String.fromCharCode(66 + i).repeat(20) + "R" + String.fromCharCode(66 + i).repeat(17) + "Z";
const NOW = 1_791_000_000_000;
const build = (lines: { wallet: string; amountQu: number }[]) => buildBatches(lines, 10, "2026-09", NOW)[0];
const view = (batch: Batch, tweak: (v: any) => void = () => {}) => {
  const step = batchStep(batch);
  const v: any = { id: batch.id, status: "prepared", throughPeriod: batch.throughPeriod, wallets: batch.lines.length, toWalletsQu: batch.lines.reduce((s, l) => s + l.amountQu, 0), feeQu: batch.feeQu, amountQu: batch.amountQu, txId: null, note: null, lines: batch.lines, tx: { destinationContractIndex: 4, inputType: step.inputType, amountQu: step.amountQu, payloadBase64: batch.payload, description: step.description } };
  tweak(v);
  return v;
};
const plan = (batch: Batch, tweakPlan: (p: any) => void = () => {}, tweakView: (v: any) => void = () => {}) => {
  const bt = view(batch, tweakView);
  const p: any = { owner: OWNER, throughPeriod: "2026-09", feeQu: 10, wallets: bt.lines.length, toWalletsQu: bt.toWalletsQu, totalAttachedQu: bt.amountQu, batches: [bt], skipped: [], howToSign: "" };
  tweakPlan(p);
  return p;
};
const balances = (owed: [string, number][]) => ({ start: "2026-09", periods: ["2026-09"], totalEarnedQu: 0, totalPaidQu: 0, totalOwedQu: 0, balances: owed.map(([wallet, o]) => ({ wallet, discordIds: ["1\u001b[2J2"], earnedQu: o, paidQu: 0, owedQu: o })) });

const honest = build([{ wallet: w(1), amountQu: 5000 }, { wallet: w(2), amountQu: 7000 }]);
const honestBalances = balances([[w(1), 5000], [w(2), 7000]]);

// A fake archive in which September 2026 holds two real subscriptions: w(1) paid 10,000 QU and w(2) 12,000 (earning 75% of what QPayhub forwarded).
const SEP = Date.UTC(2026, 8, 15);
const resource = Buffer.alloc(32);
resource.write("QMAXSUB", 0, "latin1");
resource.writeBigUInt64LE(123n, 16);
const payInput = (() => {
  const x = Buffer.alloc(72);
  Buffer.from(identityToBytes(OWNER)).copy(x, 0);
  resource.copy(x, 32);
  return x.toString("base64");
})();
const pays = [[1, 10_000], [2, 12_000]].map(([i, gross]) => ({ hash: String.fromCharCode(97 + i).repeat(60), source: w(i), destination: QPAYHUB_IDENTITY, amount: String(gross), tickNumber: 1000 + i, timestamp: String(SEP + i * 1000), inputType: 1, inputData: payInput, moneyFlew: true }));
const eventsOf = (t: (typeof pays)[number]) => [
  { logType: 0, quTransfer: { source: t.source, destination: QPAYHUB_IDENTITY, amount: t.amount } },
  { logType: 0, quTransfer: { source: QPAYHUB_IDENTITY, destination: OWNER, amount: String(Number(t.amount) - Math.max(100, Math.floor(Number(t.amount) * 0.0075))) } },
];

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });

async function serve() {
  const state = { plan: plan(honest) as unknown, balances: honestBalances as unknown };
  const qmax = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== "k".repeat(24)) return void ((res.statusCode = 401), res.end("{}"));
    if (req.url!.endsWith("/balances")) return void res.end(JSON.stringify(state.balances));
    if (req.url!.endsWith("/prepare")) return void res.end(JSON.stringify(state.plan));
    res.statusCode = 404;
    res.end("{}");
  });
  const archive = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (req.url!.endsWith("getLastProcessedTick")) return void res.end(JSON.stringify({ tickNumber: 5000, logTickNumber: 5002 }));
    if (req.url!.endsWith("getTickData")) return void res.end(JSON.stringify({ tickData: { tickNumber: j.tickNumber, timestamp: String(Date.now()) } }));
    if (req.url!.endsWith("getTransactionsForIdentity")) return void res.end(JSON.stringify({ hits: { total: pays.length }, transactions: pays, validForTick: 5000 }));
    if (req.url!.endsWith("getEventLogs")) {
      const ev = eventsOf(pays.find((p) => p.hash === j.filters.transactionHash)!);
      return void res.end(JSON.stringify({ hits: { total: ev.length }, eventLogs: ev, validForTick: 5000 }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { state, qmax, archive };
}

const run = (qmaxBase: string, archivePort: number): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    // Only what the script needs: no .env, so no real key is ever in play, and no seed.
    const child = spawn("node", ["--experimental-strip-types", "--no-warnings", "--import", "./test/loader.mjs", "scripts/payout.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { PATH: process.env.PATH ?? "", QMAX_API: qmaxBase, API_KEY: "k".repeat(24), QUBIC_RPC_URL: `http://localhost:${archivePort}` } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

test("the payout script, dry run: an honest plan is shown in full and passes its independent check against the chain", async () => {
  const { qmax, archive } = await serve();
  try {
    const r = await run(`http://localhost:${qmax.port}`, archive.port);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Independent check passed: checked against the chain: 2 wallets/);
    assert.match(r.out, /Dry run: nothing was signed/);
    for (const line of honest.lines) assert.ok(r.out.includes(line.wallet), "every wallet is printed in full, to be read against what is expected");
    assert.ok(!r.out.includes("\u001b"), "no terminal control characters from the server's text");
  } finally {
    qmax.server.close();
    archive.server.close();
  }
});

test("the payout script refuses what a tampered or mistaken server could send, and signs nothing", async () => {
  const { state, qmax, archive } = await serve();
  try {
    const hb = Buffer.alloc(1000);
    hb.writeBigInt64LE(12_000n, 800);
    const swapped = build([{ wallet: w(7), amountQu: 5000 }, { wallet: w(2), amountQu: 7000 }]);
    const inflated = build([{ wallet: w(1), amountQu: 9000 }, { wallet: w(2), amountQu: 7000 }]);
    const cases: [string, unknown, unknown, RegExp][] = [
      ["the all-zero wallet, which QUtil skips while keeping the money", plan(honest, undefined, (v) => ((v.lines = [{ wallet: "A".repeat(60), amountQu: 12_000 }]), (v.tx.payloadBase64 = hb.toString("base64")))), balances([["A".repeat(60), 12_000]]), /not a wallet that can be paid/],
      ["bytes that do not match the wallets listed", plan(honest, undefined, (v) => { const b = Buffer.from(v.tx.payloadBase64, "base64"); b[3] ^= 1; v.tx.payloadBase64 = b.toString("base64"); }), honestBalances, /bytes do not match/],
      ["a plan paid from some other address", plan(honest, (p) => (p.owner = w(5))), honestBalances, /is paid from/],
      ["totals that are not what the batches add up to", plan(honest, (p) => (p.toWalletsQu = 99_999_999)), honestBalances, /own totals/],
      ["a line above what the server's own balances say is owed", plan(honest), balances([[w(1), 100], [w(2), 7000]]), /more than the 100 QU it is owed/],
      ["a wallet the chain never saw pay anything", plan(swapped), balances([[w(7), 5000], [w(2), 7000]]), /chain itself entitles it to at most 0 QU/],
      ["an amount above what the chain says the wallet earned", plan(inflated), balances([[w(1), 9000], [w(2), 7000]]), /would be paid 9000 QU, but the chain itself entitles it to at most 7425 QU/],
    ];
    for (const [what, p, bal, expect] of cases) {
      state.plan = p;
      state.balances = bal;
      const r = await run(`http://localhost:${qmax.port}`, archive.port);
      assert.equal(r.code, 1, `${what}: ${r.out}`);
      assert.match(r.out, /not safe to sign/, what);
      assert.match(r.out, expect, what);
      assert.ok(!/Dry run|signed/.test(r.out.replace(/not safe to sign/, "")), `${what}: nothing is offered for signing`);
    }
    // Text from the server is shown as plain text.
    state.plan = plan(honest, (p) => (p.skipped = [{ wallet: w(3), owedQu: 5, reason: "\u001b[2J\u001b[Hall is fine\u0007" }]));
    state.balances = honestBalances;
    const r = await run(`http://localhost:${qmax.port}`, archive.port);
    assert.equal(r.code, 0, r.out);
    assert.ok(!/[\u001b\u0007]/.test(r.out), "escape and bell characters from the server never reach the terminal");
    assert.match(r.out, /all is fine/);
  } finally {
    qmax.server.close();
    archive.server.close();
  }
});

test("the payout script will not send QMax's API key across a network in the clear", async () => {
  const { qmax, archive } = await serve();
  try {
    const r = await run("http://example.org:8787", archive.port);
    assert.equal(r.code, 1);
    assert.match(r.out, /not this machine and not https/);
  } finally {
    qmax.server.close();
    archive.server.close();
  }
});
