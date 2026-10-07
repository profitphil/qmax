import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createApi } from "../src/api.ts";
import { SnapshotData } from "../src/data.ts";
import { bytesToHex, identityToBytes } from "../src/identity.ts";
import { Meter } from "../src/meter.ts";
import { SELLER, PAYER, OTHER, fakeNetwork, header } from "./x402-helpers.ts";
import { ASSET, NETWORK, QPAYHUB_IDENTITY, SESSION_RESOURCE_ID, UsedLedger, X402Gate, issueGrant, issueTicket, loadSecrets, resourceTag, verifyGrant, verifyTicket } from "../src/x402.ts";

const SECRET = "test-secret";
const DAY = 86_400_000;

// ---------------- tickets, grants, secrets, ledger ----------------

test("a ticket carries an unguessable 8-byte nonce, bound to the seller, the resource and the price", () => {
  const t = issueTicket({ sellerId: SELLER, resourceId: "r", amount: "10000" }, SECRET, 1_000_000);
  assert.match(t.nonceHex, /^[0-9a-f]{16}$/);
  assert.notEqual(issueTicket({ sellerId: SELLER, resourceId: "r", amount: "10000" }, SECRET).nonceHex, t.nonceHex);
  const ok = verifyTicket(t.token, { sellerId: SELLER, resourceId: "r", amount: "10000" }, SECRET, 1_000_000);
  assert.ok(ok.valid && ok.claims.nonce === t.nonceHex && ok.claims.v === "pt1");
  const why = (token: unknown, e = { sellerId: SELLER, resourceId: "r", amount: "10000" }, secret = SECRET, now = 1_000_000) => {
    const r = verifyTicket(token, e, secret, now);
    return r.valid ? "valid" : r.reason;
  };
  assert.equal(why(undefined), "ticket_missing");
  assert.equal(why("nonsense"), "ticket_malformed");
  assert.equal(why(t.token, undefined, "other-secret"), "ticket_bad_signature");
  assert.equal(why(t.token.slice(0, -2) + "xx"), "ticket_bad_signature");
  assert.equal(why(t.token, undefined, SECRET, 1_000_000 + 601_000), "ticket_expired");
  assert.equal(why(t.token, { sellerId: SELLER, resourceId: "r", amount: "9999" }), "ticket_mismatch"); // a ticket for another price
  assert.equal(why(t.token, { sellerId: OTHER, resourceId: "r", amount: "10000" }), "ticket_mismatch");
  assert.equal(why(t.token, { sellerId: SELLER, resourceId: "other", amount: "10000" }), "ticket_mismatch");
});

test("a session grant is good for its time and its resource, and no longer", () => {
  const g = issueGrant({ subject: "ab".repeat(32), resourceId: "r", seconds: 3600, reference: "cd".repeat(32) }, SECRET, 5_000_000);
  assert.equal(g.expiresAt, 5_000 + 3600);
  const ok = verifyGrant(g.token, "r", SECRET, 5_000_000 + 3_599_000);
  assert.ok(ok.valid && ok.claims.sub === "ab".repeat(32));
  const why = (token: unknown, rid = "r", secret = SECRET, now = 5_000_000) => {
    const r = verifyGrant(token, rid, secret, now);
    return r.valid ? "valid" : r.reason;
  };
  assert.equal(why(g.token, "r", SECRET, 5_000_000 + 3_601_000), "grant_expired");
  assert.equal(why(g.token, "another"), "grant_wrong_resource");
  assert.equal(why(g.token, "r", "other"), "grant_bad_signature");
  assert.equal(why(""), "grant_missing");
  assert.equal(why("x.y"), "grant_bad_signature");
});

test("secrets come from the environment, or are made once and kept so sessions survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmax-x402-"));
  const file = join(dir, "secrets.json");
  const a = loadSecrets(file, {});
  assert.notEqual(a.ticket, a.grant); // one key cannot mint both
  assert.equal(a.ticket.length, 64);
  assert.deepEqual(loadSecrets(file, {}), a); // the same after a restart
  assert.equal(statSync(file).mode & 0o777, 0o600); // readable by this user only
  assert.equal(loadSecrets(file, { X402_TICKET_SECRET: "T", X402_GRANT_SECRET: "G" }).ticket, "T");
  assert.deepEqual(loadSecrets(join(dir, "none.json"), { X402_TICKET_SECRET: "T", X402_GRANT_SECRET: "G" }), { ticket: "T", grant: "G" });
  assert.equal(existsSync(join(dir, "none.json")), false); // nothing written when both come from the environment
  assert.equal(loadSecrets(undefined, { X402_GRANT_SECRET: "G" }).ticket, "G"); // one secret can serve both
});

test("a payment is used once, remembered across restarts, and forgotten after QPayhub forgets its receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmax-ledger-"));
  const file = join(dir, "used.json");
  const a = new UsedLedger(file, 0);
  assert.equal(a.claim("aa", 100), true);
  assert.equal(a.claim("aa", 200), false);
  assert.equal(a.has("aa"), true);
  a.flush();
  assert.equal(new UsedLedger(file, 1000).has("aa"), true);
  assert.equal(new UsedLedger(file, 100 + 22 * DAY).has("aa"), false);
});

// ---------------- paying and checking ----------------

const newGate = (net = fakeNetwork(), extra: Partial<ConstructorParameters<typeof X402Gate>[0]> = {}) => ({
  net,
  gate: new X402Gate({ priceQu: 10_000, seconds: 3600, sellerId: SELLER, chain: net.chain, ledger: new UsedLedger(), secrets: { ticket: "t", grant: "g" }, ...extra }),
});

test("the 402 challenge has Q+Pay's shape: version 2, scheme exact, network qubic:mainnet, QPayhub as payTo, a ticket", () => {
  const { gate } = newGate();
  const c: any = gate.challenge("https://api.example/v1/quote", "X-PAYMENT header is required");
  assert.equal(c.x402Version, 2);
  assert.equal(c.error, "X-PAYMENT header is required");
  assert.equal(c.resource.url, "https://api.example/v1/quote");
  assert.deepEqual(c.accepts[0], {
    scheme: "exact", network: NETWORK, amount: "10000", asset: ASSET, payTo: QPAYHUB_IDENTITY, maxTimeoutSeconds: 300,
    extra: { sellerId: SELLER, resourceId: SESSION_RESOURCE_ID, settlement: "contract", grantSeconds: 3600, note: c.accepts[0].extra.note },
  });
  assert.equal(c.paymentTicketField, "paymentPayload.payload.ticket");
  assert.equal(typeof c.paymentTicket, "string");
  assert.notEqual((gate.challenge("u", "e") as any).paymentTicket, c.paymentTicket); // a fresh ticket every time
  assert.equal(identityToBytes(QPAYHUB_IDENTITY)[0], 29); // QPayhub is contract 29
  assert.ok(identityToBytes(QPAYHUB_IDENTITY).slice(1).every((b) => b === 0));
  assert.equal(bytesToHex(resourceTag("abc")), createHash("sha256").update("abc").digest("hex"));
});

test("paying with a transaction id buys a session; the same payment cannot buy a second", async () => {
  const { gate, net } = newGate();
  const c: any = gate.challenge("u", "e");
  const { txId, reference } = net.pay(c);
  const r = await gate.settle(header(c, { txHash: txId }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.reference, reference);
  assert.equal(r.payer, bytesToHex(identityToBytes(PAYER)));
  assert.deepEqual(r.response, { success: true, payer: r.payer, transaction: reference, network: NETWORK });
  const g = gate.checkGrant(r.grant.token);
  assert.ok(g.valid && g.claims.sub === r.payer && g.claims.ref === reference);
  assert.equal(r.grant.expiresAt - Math.floor(Date.now() / 1000), 3600);
  const again = await gate.settle(header(c, { txHash: txId }));
  assert.deepEqual(again, { ok: false, reason: "payment_already_used" });
});

test("the receipt key works too, in place of the transaction id", async () => {
  const { gate, net } = newGate();
  const c: any = gate.challenge("u", "e");
  const { reference } = net.pay(c);
  assert.ok((await gate.settle(header(c, { reference }))).ok);
});

test("a payment the network has not shown yet says so, so the buyer waits and tries again", async () => {
  const { gate, net } = newGate();
  const c: any = gate.challenge("u", "e");
  const fresh = "a".repeat(60);
  assert.deepEqual(await gate.settle(header(c, { txHash: fresh })), { ok: false, reason: "invalid_transaction_state" }); // no such transaction yet
  const { txId } = net.pay(c, { moneyFlew: false });
  assert.deepEqual(await gate.settle(header(c, { txHash: txId })), { ok: false, reason: "invalid_transaction_state" }); // in a block but the money did not move
  net.receipts.clear();
  const { txId: t2 } = net.pay(c);
  net.receipts.clear(); // QPayhub refused it (no receipt)
  assert.deepEqual(await gate.settle(header(c, { txHash: t2 })), { ok: false, reason: "invalid_transaction_state" });
});

test("every way a payment can be wrong is refused, with a reason", async () => {
  const cases: [string, Parameters<ReturnType<typeof fakeNetwork>["pay"]>[1], string][] = [
    ["too little paid", { amount: 9_999 }, "invalid_exact_evm_payload_authorization_value_mismatch"],
    ["too much paid (the amount must be exact)", { amount: 10_001 }, "invalid_exact_evm_payload_authorization_value_mismatch"],
    ["paid a different seller", { seller: OTHER }, "invalid_transaction_state"], // the receipt key is built from the right seller, so it finds nothing
    ["paid for a different resource", { resource: "qmax:something-else" }, "invalid_transaction_state"],
    ["used a nonce that was not on the ticket", { nonceHex: "0102030405060708" }, "invalid_transaction_state"],
    ["receipt already marked used by the seller", { consumed: true }, "payment_already_used"],
    ["paid too long ago", { tickPaid: 10_000 - 600 }, "invalid_exact_evm_payload_authorization_valid_before"],
    ["sent the money somewhere else", { destId: OTHER }, "invalid_exact_evm_payload_recipient_mismatch"],
  ];
  for (const [what, over, reason] of cases) {
    const { gate, net } = newGate();
    const c: any = gate.challenge("u", "e");
    const { txId } = net.pay(c, over);
    const r = await gate.settle(header(c, { txHash: txId }));
    assert.deepEqual(r, { ok: false, reason }, what);
  }
});

test("a receipt with the wrong contents is refused even when handed in by its key", async () => {
  const { gate, net } = newGate();
  const c: any = gate.challenge("u", "e");
  const { reference } = net.pay(c, { amount: 5 });
  assert.deepEqual(await gate.settle(header(c, { reference })), { ok: false, reason: "invalid_exact_evm_payload_authorization_value_mismatch" });
  const wrongResource = net.pay(c, { resource: "x" });
  assert.deepEqual(await gate.settle(header(c, { reference: wrongResource.reference })), { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" });
});

test("front-running: somebody who sees a payment on the chain cannot redeem it with a ticket of their own", async () => {
  const { gate, net } = newGate();
  const victim: any = gate.challenge("u", "e");
  const { txId } = net.pay(victim, { payer: PAYER });
  const attacker: any = gate.challenge("u", "e"); // their own, differently-nonced ticket
  const stolen = await gate.settle(header(attacker, { txHash: txId }));
  assert.equal(stolen.ok, false);
  assert.ok(!stolen.ok && stolen.reason === "invalid_transaction_state"); // the receipt under their nonce does not exist
  assert.ok((await gate.settle(header(victim, { txHash: txId }))).ok); // the real buyer still can
});

test("malformed requests are refused before anything is read from the network", async () => {
  const { gate, net } = newGate();
  net.chain.getReceipt = async () => { throw new Error("must not be called"); };
  net.chain.transaction = async () => { throw new Error("must not be called"); };
  const c: any = gate.challenge("u", "e");
  const reason = async (h: string) => ((await gate.settle(h)) as { reason: string }).reason;
  assert.equal(await reason("%%%not-base64-json"), "invalid_payload");
  assert.equal(await reason(Buffer.from("[]").toString("base64")), "invalid_payload");
  assert.equal(await reason(header(c, {}, { accepted: { scheme: "exact", network: "base" } })), "invalid_network");
  assert.equal(await reason(header(c, {}, { accepted: undefined })), "invalid_network");
  assert.equal(await reason(header({ ...c, paymentTicket: undefined }, { ticket: undefined })), "ticket_missing");
  assert.equal(await reason(header(c, { ticket: c.paymentTicket + "x" })), "ticket_bad_signature");
  const elsewhere = newGate(undefined, { secrets: { ticket: "a-different-server", grant: "g" } }).gate.challenge("u", "e") as any;
  assert.equal(await reason(header(c, { ticket: elsewhere.paymentTicket })), "ticket_bad_signature"); // another server's ticket
  const dearer = newGate(undefined, { priceQu: 20_000 }).gate.challenge("u", "e") as any;
  assert.equal(await reason(header(c, { ticket: dearer.paymentTicket })), "ticket_mismatch"); // a ticket for a different price
  assert.equal(await reason(header(c, { txHash: "not-a-tx" })), "invalid_payload");
});

test("a session price below QPayhub's minimum is refused at start-up", () => {
  const net = fakeNetwork();
  assert.throws(() => new X402Gate({ priceQu: 99, seconds: 60, sellerId: SELLER, chain: net.chain, ledger: new UsedLedger(), secrets: { ticket: "t", grant: "g" } }), /at least 100/);
  assert.throws(() => new X402Gate({ priceQu: 1000, seconds: 0, sellerId: SELLER, chain: net.chain, ledger: new UsedLedger(), secrets: { ticket: "t", grant: "g" } }), /whole number of seconds/);
});

// ---------------- over HTTP ----------------

const net = fakeNetwork();
const gate = new X402Gate({ priceQu: 10_000, seconds: 3600, sellerId: SELLER, chain: net.chain, ledger: new UsedLedger(), secrets: { ticket: "t", grant: "g" } });
const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: SELLER, lookupReceipt: async () => null });
const data = new SnapshotData([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
const server = createApi({ data, meter, x402: gate, freePerMin: 3 });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const asset = data.assets()[0];
const quoteUrl = `${base}/v1/quote?side=buy&asset=${asset}&qty=100000`;
const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then(async (r) => ({ r, j: (await r.json()) as any }));

test("agents can find out how to pay", async () => {
  const { r, j } = await get(`${base}/v1/x402`);
  assert.equal(r.status, 200);
  assert.deepEqual([j.x402Version, j.asset, j.payTo, j.sellerId], [2, "QUBIC", QPAYHUB_IDENTITY, SELLER]);
  assert.deepEqual(j.session, { priceQu: 10_000, seconds: 3600, resourceId: SESSION_RESOURCE_ID });
});

test("asking for a session without paying gets the 402 challenge", async () => {
  const { r, j } = await get(`${base}/v1/session`);
  assert.equal(r.status, 402);
  assert.equal(j.x402Version, 2);
  assert.equal(j.error, "X-PAYMENT header is required");
  assert.equal(j.accepts[0].payTo, QPAYHUB_IDENTITY);
  assert.equal(j.accepts[0].amount, "10000");
  assert.match(j.resource.url, /\/v1\/session$/);
});

test("past the free limit, the answer is a 402 an agent can act on, with a Retry-After", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await get(quoteUrl)).r.status, 200);
  const { r, j } = await get(quoteUrl);
  assert.equal(r.status, 402);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.match(j.error, /Free limit|Too many requests/);
  assert.equal(j.accepts[0].extra.resourceId, SESSION_RESOURCE_ID);
  assert.match(j.resource.url, /\/v1\/quote/); // it names the very request that was refused
});

test("the whole journey: challenge, pay, retry the same request with X-PAYMENT, get the answer and a session", async () => {
  const first = await get(quoteUrl); // still over the free limit
  assert.equal(first.r.status, 402);
  const { txId } = net.pay(first.j);
  const paid = await get(quoteUrl, { "x-payment": header(first.j, { txHash: txId }) });
  assert.equal(paid.r.status, 200);
  assert.ok(paid.j.route.length >= 1); // the quote the caller wanted, in the same round trip
  const grant = paid.r.headers.get("x-access-grant")!;
  assert.ok(grant);
  assert.ok(Number(paid.r.headers.get("x-access-grant-expires")) > Date.now() / 1000);
  const receipt = JSON.parse(Buffer.from(paid.r.headers.get("x-payment-response")!, "base64").toString());
  assert.deepEqual([receipt.success, receipt.network], [true, NETWORK]);

  // the session: many calls, no payment, however far over the free limit
  for (let i = 0; i < 10; i++) assert.equal((await get(quoteUrl, { "x-access-grant": grant })).r.status, 200);
  const arb = await get(`${base}/v1/arbitrage?asset=${asset}`, { "x-access-grant": grant });
  assert.equal(arb.r.status, 200);
  assert.equal(arb.r.headers.get("x-qmax-charged-qu"), null); // nothing billed
  // and it is the paying wallet's session, not the address's: a stranger without it is still held to the free limit
  assert.equal((await get(quoteUrl)).r.status, 402);

  // the same payment cannot be used again
  const replay = await get(quoteUrl, { "x-payment": header(first.j, { txHash: txId }) });
  assert.equal(replay.r.status, 402);
  assert.equal(replay.j.error, "payment_already_used");
  assert.equal(replay.j.paymentTicket, undefined); // a rejection does not hand out a new ticket
});

test("/v1/session gives the grant as JSON for an agent that wants it explicitly", async () => {
  const c = await get(`${base}/v1/session`);
  const { txId } = net.pay(c.j, { payer: OTHER });
  const bought = await get(`${base}/v1/session`, { "x-payment": header(c.j, { txHash: txId }) });
  assert.equal(bought.r.status, 200);
  assert.equal(bought.j.ok, true);
  assert.equal(bought.j.seconds, 3600);
  const grant = bought.r.headers.get("x-access-grant")!;
  const again = await get(`${base}/v1/session`, { "x-access-grant": grant });
  assert.equal(again.r.status, 200);
  assert.equal(again.r.headers.get("x-access-grant"), null); // already has one: nothing new is sold
});

test("a payment that is not there yet is a 402 the buyer can retry; a bad or stale grant just falls back to the free tier", async () => {
  const c = await get(`${base}/v1/session`);
  const early = await get(`${base}/v1/session`, { "x-payment": header(c.j, { txHash: "b".repeat(60) }) });
  assert.equal(early.r.status, 402);
  assert.equal(early.j.error, "invalid_transaction_state");
  const bad = await get(`${base}/v1/assets`, { "x-access-grant": "garbage.token" }); // a free endpoint does not even look
  assert.equal(bad.r.status, 200);
  const stale = issueGrant({ subject: "00", resourceId: SESSION_RESOURCE_ID, seconds: 1, reference: "11" }, "g", Date.now() - 10_000).token;
  const viaQuote = await get(quoteUrl, { "x-access-grant": stale });
  assert.equal(viaQuote.r.headers.get("x-access-grant-status"), "grant_expired");
});

test("a server without x402 still answers 429 at the free limit, as before", async () => {
  const plain = createApi({ data, meter, freePerMin: 1 });
  await new Promise<void>((r) => plain.listen(0, () => r()));
  const u = `http://localhost:${(plain.address() as AddressInfo).port}/v1/quote?side=buy&asset=${asset}&qty=100000`;
  assert.equal((await get(u)).r.status, 200);
  assert.equal((await get(u)).r.status, 429);
  plain.close();
});
