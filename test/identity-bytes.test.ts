import { test } from "node:test";
import assert from "node:assert/strict";
import { PAYWALL } from "../src/config.ts";
import { bytesToHex, bytesToIdentity, hexToBytes, identityToBytes } from "../src/identity.ts";
import { QSWAP_ID, QX_ID } from "../src/ledger.ts";
import { QPAYHUB_IDENTITY } from "../src/x402.ts";
import { buildBook } from "../src/book.ts";
import { QxVenue } from "../src/venues.ts";
import type { BookLevel } from "../src/venues.ts";

test("a public key becomes the identity it came from, checksum letters included (checked on real addresses)", () => {
  for (const id of [QX_ID, QSWAP_ID, PAYWALL.recipient, QPAYHUB_IDENTITY]) assert.equal(bytesToIdentity(identityToBytes(id)), id);
  assert.throws(() => bytesToIdentity(new Uint8Array(31)), /32 bytes/);
});

const level = (price: number, qty: number, owner?: string): BookLevel => ({ price, qty, ...(owner ? { ownerKey: bytesToHex(identityToBytes(owner)) } : {}) });
const venue = (asks: BookLevel[], bids: BookLevel[]) => new QxVenue({ asks, bids, buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 0 });

test("a book row names its wallet when the orders at that price are all one wallet's, and counts the wallets", () => {
  const book = buildBook(
    venue(
      [level(100, 10, QPAYHUB_IDENTITY), level(100, 5, QPAYHUB_IDENTITY), level(101, 20, QX_ID), level(101, 1, QSWAP_ID), level(105, 1)],
      [level(99, 7, PAYWALL.recipient)],
    ),
    undefined,
  ).qx!;
  const [one, mixed, unknown] = book.asks;
  assert.deepEqual([one.orders, one.owner, one.owners], [2, QPAYHUB_IDENTITY, 1], "two orders from one wallet: that wallet");
  assert.deepEqual([mixed.orders, mixed.owner, mixed.owners], [2, undefined, 2], "two wallets at the price: no single owner");
  assert.deepEqual([unknown.owner, unknown.owners], [undefined, undefined], "an order whose wallet the book did not say");
  assert.equal(book.bids[0].owner, PAYWALL.recipient);
  assert.equal(bytesToHex(hexToBytes(bytesToHex(identityToBytes(QX_ID)))), bytesToHex(identityToBytes(QX_ID)));
});
