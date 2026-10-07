import test from "node:test";
import assert from "node:assert/strict";
import { Raw, RouteError } from "../src/routes.ts";
import { CSV_COLUMNS, POSITION_COLUMNS, QSWAP_ID, QX_ID, buildLedger, contractIndexOf, csvCell, fetchLedgerInput, ledgerRoutes, qswapBuyFee, qswapSellFee, qxFee, qxGrossFromNet, toCsv } from "../src/ledger.ts";
import type { ArchiveClient, Ledger, LedgerEntry, QxFill, WalletEvent, WalletTx } from "../src/ledger.ts";

/* ---------- real events, trimmed (from the public archive, October 2026) ---------- */

const JMFL = "JMFLTJAAFJJYWGZAQFYENGKDOILATKKHRVKIOJWYBAZAXUOJTEOYBVIFFIHB";
const KCEB = "KCEBMRWMXJPTDERZCJMZCVGBOTFDEYOCBHFLMWVPBGQRQOABNFJXQDBBZTOE";
const TNYY = "TNYYHTXOXEJHIGIEXZZLLXPVNHRBGHILDYNJZNTWFGKNTAOBBYMEWBGACZTH";
const HCFQ = "HCFQHYQEVDLXNEJBVWPSLNRFQSFDUKOHQAMNFKLEIGULVCAROEDOLTGCNUNJ";
const CUVB = "CUVBFYJUFLUJJCOIDWLDKHEIHQNBAMYQENIGANJAGAJORWVAVTUVMUEARQPG";
const FALL = "FALLXQCVWIQQSFPEAFNNIWFGOVQDIPBFJRMRPAGBHDQTRFNEEMFXJQUGZTKK";
const KXY = "KXYURHAGAPBDBBUEVOMYFWDINJDDROKBANDWTVWUSBHCQBLQFYQBSYEGZWBG";
const QMINE = "QMINEQQXYBEGBHNSUPOUYDIQKZPCBPQIIHUUZMCPLBPCCAIARVZBTYKGFCWM";
const QDOGE = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const PORTAL = "IQUGNVFDQSLTXFJSIOPPNPZINSCDQTJVJWGRPWRTFFXMXSJIAASXOBFFBERK";
const QPAYHUB = "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH";
/** QX's own key for QMINE (`activityKey`), as its trade messages carry it. */
const QMINE_KEY = "297666170193|b080e1181018abf269d91fd12d73065ae79aae3e2606c531cb630498bdca19dd";

const qu = (h: string | undefined, epoch: number, tick: number, ms: string, logId: string, source: string, destination: string, amount: string): WalletEvent => ({ epoch, tickNumber: tick, timestamp: ms, ...(h ? { transactionHash: h } : {}), logType: 0, logId, quTransfer: { source, destination, amount } });
const own = (h: string | undefined, epoch: number, tick: number, ms: string, logId: string, source: string, destination: string, assetIssuer: string, assetName: string, numberOfShares: string): WalletEvent => ({ epoch, tickNumber: tick, timestamp: ms, ...(h ? { transactionHash: h } : {}), logType: 2, logId, assetOwnershipChange: { source, destination, assetIssuer, assetName, numberOfShares } });
const tx = (hash: string, source: string, destination: string, amount: string, tick: number, inputType: number, inputData = ""): WalletTx => ({ hash, source, destination, amount, tickNumber: tick, timestamp: "0", inputType, inputData, moneyFlew: true });

// QSwap buy (SwapQuForExactAsset): 4,383,361 QU sent, 1,000 QMINE back, 42,409 QU refunded. The SwapMessage said 4,240,952 QU into the pool.
const SWAP_BUY_H = "mjpkuozhnyzfsaxydgozjrcrchcdypuafhuilkyrygdbvsyomdrlnjbcswvn";
const SWAP_BUY = [
  qu(SWAP_BUY_H, 233, 83082062, "1791144876000", "5980610", JMFL, QSWAP_ID, "4383361"),
  own(SWAP_BUY_H, 233, 83082062, "1791144876000", "5980611", QSWAP_ID, JMFL, QMINE, "QMINE", "1000"),
  qu(SWAP_BUY_H, 233, 83082062, "1791144876000", "5980613", QSWAP_ID, JMFL, "42409"),
];
// QSwap sell (SwapExactAssetForQu): the 100,000 QU flat fee, 3,658 PORTAL in, 415,015,871 QU out.
const SWAP_SELL_H = "tnczeqhkguvtzbwgxqhupzwmhtuabpplastegzyoufmtsykpfhrwieafnoxc";
const SWAP_SELL = [
  qu(SWAP_SELL_H, 233, 83077782, "1791142490000", "5911490", KCEB, QSWAP_ID, "100000"),
  own(SWAP_SELL_H, 233, 83077782, "1791142490000", "5911491", KCEB, QSWAP_ID, PORTAL, "PORTAL", "3658"),
  qu(SWAP_SELL_H, 233, 83077782, "1791142490000", "5911493", QSWAP_ID, KCEB, "415015871"),
];
// QX fill: TNYY's buy order took HCFQ's resting sell order, 44,993 QMINE at 4,154 (HCFQ got 186,340,219 after QX's 0.3%).
const QX_FILL_H = "zazgdzyqmchuefezqpoxuqimhyxclkawjqubgepxeduswscpwclcpybdawqb";
const QX_FILL = [
  qu(QX_FILL_H, 233, 83103103, "1791156484000", "6175853", TNYY, QX_ID, "186900922"),
  qu(QX_FILL_H, 233, 83103103, "1791156484000", "6175854", QX_ID, HCFQ, "186340219"),
  own(QX_FILL_H, 233, 83103103, "1791156484000", "6175855", HCFQ, TNYY, QMINE, "QMINE", "44993"),
];
const QX_FILL_TX = tx(QX_FILL_H, TNYY, QX_ID, "186900922", 83103103, 6, "sIDhGBAYq/Jp2R/RLXMGWuearj4mBsUxy2MEmL3KGd1RTUlORQAAADoQAAAAAAAAwa8AAAAAAAA=");
// CUVB's buy order for 110,107 QMINE at 4,650: 42,852 filled at once, the rest rested; two sellers later filled 60,000 and 1,751 of it.
const BID_H = "szzyojslrzsvnfykjminjnolxqafsbitcrdwzjkrzercujmaipkoptdhjtmd";
const BID = [
  qu(BID_H, 212, 51851091, "1778345398000", "128468012", CUVB, QX_ID, "511997550"),
  own(BID_H, 212, 51851091, "1778345398000", "128468014", "IMBAAMLYDXLLQDIYYCUFKPOISJFAIOOHNITRJXKONGYGFLICCLCBZSJFZJXL", CUVB, QMINE, "QMINE", "42852"),
];
const BID_TX = tx(BID_H, CUVB, QX_ID, "511997550", 51851091, 6, "sIDhGBAYq/Jp2R/RLXMGWuearj4mBsUxy2MEmL3KGd1RTUlORQAAACoSAAAAAAAAG64BAAAAAAA=");
const MAKER1_H = "lngsngksshbjsddxnmzkuoxtipvevkyjyifdqwrzjbcvzxuvujoizchhodxm";
const MAKER2_H = "xdhtzxuyyaupahsveljtxqbkvnncjniyukihlouabfdcutwlrlnltwpazmio";
const MAKERS = [
  own(MAKER1_H, 212, 51851256, "1778345506000", "128519905", "PQEVFBONLHDNHBKDMREWHRELJYVCIIHSIHBTEMUIYCGNZXINLPTVCPXFTWMA", CUVB, QMINE, "QMINE", "60000"),
  own(MAKER2_H, 212, 51852570, "1778346361000", "128982108", "SREXRVCQPGACTAESTYQISKDDZERDLQQJRYDBJSLEWEVBLEDJYXECVCCBUSQO", CUVB, QMINE, "QMINE", "1751"),
];
const MAKER_FILLS = new Map<string, QxFill[]>([
  [MAKER1_H, [{ logId: 128519907, key: QMINE_KEY, price: 4650, qty: 60000 }]],
  [MAKER2_H, [{ logId: 128982110, key: QMINE_KEY, price: 4650, qty: 1751 }]],
]);
// CUVB's sell order for QDOGE at 23 swept three resting buy orders (the 1 QU sent with it was refunded first).
const SWEEP_H = "lsreinqdvztgjduxsyvjdnvslmacsxwppdyfmxvalcuymqevjevruuqaxjbh";
const SWEEP = [
  qu(SWEEP_H, 233, 82541573, "1790848013000", "876491", CUVB, QX_ID, "1"),
  qu(SWEEP_H, 233, 82541573, "1790848013000", "876492", QX_ID, CUVB, "1"),
  qu(SWEEP_H, 233, 82541573, "1790848013000", "876493", QX_ID, CUVB, "9743358"),
  own(SWEEP_H, 233, 82541573, "1790848013000", "876494", CUVB, "DLZICSCLAJSOVGTHAZQSASHTTMJBPITGPGYLMLUQIAJJBRIECYPWBEJETADJ", QDOGE, "QDOGE", "424899"),
  qu(SWEEP_H, 233, 82541573, "1790848013000", "876497", QX_ID, CUVB, "22930999"),
  own(SWEEP_H, 233, 82541573, "1790848013000", "876498", CUVB, FALL, QDOGE, "QDOGE", "1000000"),
  qu(SWEEP_H, 233, 82541573, "1790848013000", "876501", QX_ID, CUVB, "19491349"),
  own(SWEEP_H, 233, 82541573, "1790848013000", "876502", CUVB, "NOHJZJKAXOKUUEPLCAMFKZNCYUWCVVHPBEQHOUXOKDCCVYEOXKTMHGBESCPK", QDOGE, "QDOGE", "850000"),
];
const SWEEP_TX = tx(SWEEP_H, CUVB, QX_ID, "1", 82541573, 5, "BrDwcDzmfU+0yq8Ni4TEEumR61o2TI/+i07nqpaWpTJRRE9HRQAAABcAAAAAAAAAgJaYAAAAAAA=");
// KXY's buy order matched its own sell order: only QX's fee changed hands.
const SELF_H = "wltlzfddwmvhobtpcnyqhphbkirbojynqyncekiqvgjfrrkanlmvyqbhtnid";
const SELF = [
  qu(SELF_H, 233, 82590641, "1790874845000", "1158237", KXY, QX_ID, "2431350"),
  qu(SELF_H, 233, 82590641, "1790874845000", "1158238", QX_ID, KXY, "2424055"),
  own(SELF_H, 233, 82590641, "1790874845000", "1158239", KXY, KXY, QMINE, "QMINE", "675"),
];
const SELF_TX = tx(SELF_H, KXY, QX_ID, "2431350", 82590641, 6, "sIDhGBAYq/Jp2R/RLXMGWuearj4mBsUxy2MEmL3KGd1RTUlORQAAABIOAAAAAAAAowIAAAAAAAA=");
// FALL sent 3 QTREAT with QX's transfer procedure (100 QU fee).
const SEND_H = "xbyttvequrdsihczxajnkjyhcjagwdlcrgnynvznbgzhqoyvxkbcvyigqowj";
const SEND = [
  qu(SEND_H, 233, 83100258, "1791154869000", "6148163", FALL, QX_ID, "100"),
  own(SEND_H, 233, 83100258, "1791154869000", "6148164", FALL, "JREGNLHFUNFOVEXWGQHXQMRTTFSDVDCTBQSZENDCLDEOMKVUOWQWFFNFXKSO", QDOGE, "QTREAT", "3"),
];
const SEND_TX = tx(SEND_H, FALL, QX_ID, "100", 83100258, 2);
// QU-only QX and QSwap operations: a buy order placed (nothing filled), one cancelled, a management move with its 100 QU fee.
const PLACED_H = "gtmopkbkteywzdcldovikgjyiipdvfxufbzzjuqkpcmfpgodxiaguuibkqfc";
const PLACED = [qu(PLACED_H, 233, 82629613, "1790896371000", "1397298", FALL, QX_ID, "42000000")];
const PLACED_TX = tx(PLACED_H, FALL, QX_ID, "42000000", 82629613, 6, "BrDwcDzmfU+0yq8Ni4TEEumR61o2TI/+i07nqpaWpTJRVFJFQVQAAIDegAIAAAAAAQAAAAAAAAA=");
const CANCEL_H = "tecnuwiclqhcyagyojyembxtsowgzvgwfooxgfrawfqesojhitkhavydjlci";
const CANCEL = [qu(CANCEL_H, 233, 82403001, "1790771911000", "22752", QX_ID, FALL, "25000000")];
const CANCEL_TX = tx(CANCEL_H, FALL, QX_ID, "0", 82403001, 8);
const MGMT_H = "tklsgjpfxrrisguuvlmxhxztaqwgntlfnzowgkhmbhrgqcbbusgopcldfela";
const MGMT = [qu(MGMT_H, 233, 82619607, "1790890877000", "1347525", KXY, QSWAP_ID, "100")];
const MGMT_TX = tx(MGMT_H, KXY, QSWAP_ID, "100", 82619607, 11);
// Shares from their issuer, in a transaction that was looked up and had no QX trade message: a plain transfer.
const GIFT_H = "ifyswftfdkyuigrmqwhbabucgdpeqxlelqxblgfybfwjcwhmuoughgcdwrxk";
const GIFT = [own(GIFT_H, 233, 82589476, "1790874209000", "1150524", QDOGE, KXY, QDOGE, "QDOGE", "24038")];
// Events a contract caused without a transaction: a dividend (contract 20) and shares sent by contract 24.
const DIVIDEND = qu(undefined, 233, 82713854, "1790942400000", "1877025", "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQEE", CUVB, "1943973");
const DISTRIBUTION = own(undefined, 233, 82707300, "1790938819000", "1838799", "YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMSME", CUVB, "SSGXSLSXFEJOOBTZWVDSRCEFGXNDYUVDXMQALXLBXGDCRXTKFZIOTGZFUNXO", "QHEART", "502");

const trades = (l: Ledger) => l.entries.filter((e) => e.kind === "buy" || e.kind === "sell");
const only = (l: Ledger): LedgerEntry => {
  assert.equal(l.entries.length, 1, `expected one entry, got ${JSON.stringify(l.entries)}`);
  return l.entries[0];
};

/* ---------- fee rules ---------- */

test("contract identities are recognised by their index, ordinary wallets are not", () => {
  assert.equal(contractIndexOf(QX_ID), 1);
  assert.equal(contractIndexOf(QSWAP_ID), 13);
  assert.equal(contractIndexOf(QPAYHUB), 29);
  assert.equal(contractIndexOf("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFXIB"), 0);
  assert.equal(contractIndexOf(CUVB), null);
  assert.equal(contractIndexOf("baaaa"), null);
});

test("QX's fee matches what real sellers received", () => {
  assert.equal(qxFee(186_900_922), 560_703); // 44,993 QMINE at 4,154
  assert.equal(qxFee(40_000_000), 120_001);
  assert.equal(qxFee(2_431_350), 7_295);
  assert.equal(qxFee(4_000_000_000_000), Math.floor(4_000_000_000_000 / 333) + 1, "the coarser formula for huge fills");
});

test("a QX fill's value is recovered from what the seller received, preferring the round price", () => {
  assert.equal(qxGrossFromNet(186_340_219, 44_993), 186_900_922);
  assert.equal(qxGrossFromNet(9_743_358, 424_899), 23 * 424_899);
  assert.equal(qxGrossFromNet(598_199_999, 1), 600_000_000, "599,999,999 leaves the same net; the round price is far likelier");
  assert.equal(qxGrossFromNet(5, 1000), null, "no whole price fits");
  assert.equal(qxGrossFromNet(0, 10), null);
});

test("QSwap's flat fee only counts from epoch 215, when the contract started keeping it", () => {
  assert.equal(qswapBuyFee(4_340_952, 233), 100_000 + Math.floor(4_240_952 * 0.003));
  assert.equal(qswapBuyFee(1_000_000, 208), 3_000);
  assert.equal(qswapSellFee(414_915_871, 233), 100_000 + Math.round((415_015_871 * 30) / 9970));
  assert.equal(qswapSellFee(1_000_000, 214), Math.round((1_000_000 * 30) / 9970));
  assert.equal(qswapBuyFee(50_000, 233), 50_000, "a payment smaller than the flat fee is all fee");
});

/* ---------- trades ---------- */

test("a QSwap buy is priced by everything paid, refund deducted, and its fees estimated", () => {
  const e = only(buildLedger(SWAP_BUY, { identity: JMFL, ownTxs: [tx(SWAP_BUY_H, JMFL, QSWAP_ID, "4383361", 83082062, 7)] }));
  assert.deepEqual([e.kind, e.venue, e.qty, e.quNet, e.valueQu, e.price, e.feeQu], ["buy", "QSwap", 1000, -4_340_952, 4_340_952, 4340.952, 112_722]);
  assert.deepEqual(e.asset, { key: `QMINE|${QMINE}`, symbol: "QMINE", issuer: QMINE });
  assert.equal(e.position, 1000);
  assert.equal(e.t, 1791144876000);
  assert.equal(e.tx, SWAP_BUY_H);
});

test("a QSwap sale nets the flat fee out of its proceeds", () => {
  const e = only(buildLedger(SWAP_SELL, { identity: KCEB, ownTxs: [tx(SWAP_SELL_H, KCEB, QSWAP_ID, "100000", 83077782, 8)] }));
  assert.deepEqual([e.kind, e.venue, e.qty, e.quNet, e.valueQu], ["sell", "QSwap", 3658, 414_915_871, 414_915_871]);
  assert.equal(e.feeQu, qswapSellFee(414_915_871, 233));
  assert.equal(e.realizedQu, null, "the units were bought before the window, so there is no cost to set against");
});

test("the venue comes from the counterparty even without the wallet's own transaction list", () => {
  assert.equal(only(buildLedger(SWAP_BUY, { identity: JMFL })).venue, "QSwap");
  const sale = only(buildLedger(QX_FILL, { identity: HCFQ }));
  assert.equal(sale.venue, "QX");
});

test("one QX fill is a buy for the taker and a sale, net of QX's fee, for the maker", () => {
  const buy = only(buildLedger(QX_FILL, { identity: TNYY, ownTxs: [QX_FILL_TX] }));
  assert.deepEqual([buy.kind, buy.venue, buy.qty, buy.valueQu, buy.price, buy.feeQu, buy.escrowQu], ["buy", "QX", 44_993, 186_900_922, 4154, 0, undefined]);
  const sale = only(buildLedger(QX_FILL, { identity: HCFQ }));
  assert.deepEqual([sale.kind, sale.venue, sale.qty, sale.quNet, sale.feeQu], ["sell", "QX", 44_993, 186_340_219, 560_703]);
  assert.match(sale.note!, /resting QX sell order/);
});

test("a partly filled QX buy order costs only what filled; the rest stays locked at the order's price", () => {
  const e = only(buildLedger(BID, { identity: CUVB, ownTxs: [BID_TX] }));
  assert.equal(e.qty, 42_852);
  assert.equal(e.quNet, -511_997_550, "the whole order's QU left the wallet");
  assert.equal(e.escrowQu, 4650 * (110_107 - 42_852));
  assert.equal(e.valueQu, 42_852 * 4650);
  assert.equal(e.price, 4650);
});

test("a maker fill gets its price from QX's trade message and releases the locked QU", () => {
  const l = buildLedger([...BID, ...MAKERS], { identity: CUVB, ownTxs: [BID_TX], fills: MAKER_FILLS });
  const buys = trades(l);
  assert.deepEqual(buys.map((e) => [e.qty, e.price, e.quNet]), [[42_852, 4650, -511_997_550], [60_000, 4650, 0], [1751, 4650, 0]]);
  assert.equal(l.totals.escrowQu, 4650 * (110_107 - 42_852 - 60_000 - 1751), "what is still locked: the 5,504 units not yet filled");
  assert.equal(l.positions[0].held, 104_603);
  assert.equal(l.positions[0].avgCost, 4650);
  assert.equal(l.truncated, false);
});

test("shares that arrive with no QU are a transfer when QX has no fill for them, and flagged when nobody checked", () => {
  const checked = only(buildLedger(GIFT, { identity: KXY, fills: new Map([[GIFT_H, []]]) }));
  assert.deepEqual([checked.kind, checked.qty, checked.venue], ["transfer-in", 24_038, undefined]);
  assert.match(checked.note!, /not a QX fill/);
  const unchecked = buildLedger(GIFT, { identity: KXY });
  assert.equal(only(unchecked).kind, "transfer-in");
  assert.equal(unchecked.truncated, true);
  assert.match(unchecked.truncatedReasons[0], /not checked against QX fills/);
});

test("a sell order that sweeps several buy orders is one sale; each fill's QX fee is recovered exactly", () => {
  const e = only(buildLedger(SWEEP, { identity: CUVB, ownTxs: [SWEEP_TX] }));
  assert.equal(e.kind, "sell");
  assert.equal(e.qty, 424_899 + 1_000_000 + 850_000);
  assert.equal(e.quNet, 9_743_358 + 22_930_999 + 19_491_349, "the 1 QU sent and refunded nets out");
  assert.equal(e.feeQu, qxFee(23 * 424_899) + qxFee(23_000_000) + qxFee(19_550_000));
});

test("a QX order that matched the wallet's own order is a fee, not a trade", () => {
  const e = only(buildLedger(SELF, { identity: KXY, ownTxs: [SELF_TX] }));
  assert.deepEqual([e.kind, e.venue, e.qty, e.quNet, e.feeQu], ["other", "QX", 0, -7_295, 7_295]);
  assert.equal(e.position, 0, "no units moved");
});

/* ---------- not trades ---------- */

test("shares sent with QX's transfer procedure are a transfer out with its 100 QU fee", () => {
  const e = only(buildLedger(SEND, { identity: FALL, ownTxs: [SEND_TX] }));
  assert.deepEqual([e.kind, e.qty, e.feeQu, e.quNet, e.asset!.symbol], ["transfer-out", 3, 100, -100, "QTREAT"]);
});

test("fee-only and order-only transactions are listed as other, and only real fees count as fees", () => {
  const l = buildLedger([...PLACED, ...CANCEL, ...MGMT], { identity: FALL, ownTxs: [PLACED_TX, CANCEL_TX] });
  const placed = l.entries.find((e) => e.tx === PLACED_H)!;
  assert.deepEqual([placed.kind, placed.escrowQu, placed.feeQu], ["other", 42_000_000, null]);
  const cancelled = l.entries.find((e) => e.tx === CANCEL_H)!;
  assert.deepEqual([cancelled.kind, cancelled.escrowQu], ["other", -25_000_000]);
  const mgmt = buildLedger(MGMT, { identity: KXY, ownTxs: [MGMT_TX] });
  assert.deepEqual([only(mgmt).kind, only(mgmt).venue, only(mgmt).feeQu], ["other", "QSwap", 100]);
  assert.equal(mgmt.totals.feesQu, 100);
  assert.equal(mgmt.totals.otherFeesQu, 100);
  assert.equal(l.totals.trades, 0);
});

test("dividends, QPayhub payments and wallet transfers are counted, not listed", () => {
  const h = "paymentpaymentpaymentpaymentpaymentpaymentpaymentpaymentpayx";
  const events = [
    DIVIDEND,
    qu(h, 233, 82713900, "1790942500000", "1877100", CUVB, QPAYHUB, "500000"),
    qu("transfertransfertransfertransfertransfertransfertransfertran", 233, 82713901, "1790942501000", "1877101", CUVB, FALL, "7000"),
    qu("incomingincomingincomingincomingincomingincomingincomingincom", 233, 82713902, "1790942502000", "1877102", KXY, CUVB, "9000"),
  ];
  const l = buildLedger(events, { identity: CUVB });
  assert.equal(l.entries.length, 0);
  assert.deepEqual(l.excluded.contractIncome, { count: 1, qu: 1_943_973 });
  assert.deepEqual(l.excluded.contractPayments, { count: 1, qu: 500_000 });
  assert.deepEqual(l.excluded.transfersOut, { count: 1, qu: 7_000 });
  assert.deepEqual(l.excluded.transfersIn, { count: 1, qu: 9_000 });
});

test("shares a contract sends without a transaction are a transfer in, with no cost", () => {
  const l = buildLedger([DISTRIBUTION], { identity: CUVB });
  const e = only(l);
  assert.deepEqual([e.kind, e.qty, e.tx], ["transfer-in", 502, "tick:82707300"]);
  assert.match(e.note!, /contract 24/);
  assert.deepEqual([l.positions[0].held, l.positions[0].costedQty, l.positions[0].avgCost], [502, 0, null]);
});

test("QU that arrives with shares is shown on that entry and not counted again as excluded", () => {
  const contract27 = "BBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXXXX";
  const l = buildLedger([qu(undefined, 233, 8037151, "1790000000000", "1", contract27, CUVB, "5000"), own(undefined, 233, 8037151, "1790000000000", "2", contract27, CUVB, QDOGE, "QDOGE", "70")], { identity: CUVB });
  const e = only(l);
  assert.deepEqual([e.kind, e.qty, e.quNet], ["transfer-in", 70, 5000]);
  assert.match(e.note!, /contract 27/);
  assert.deepEqual(l.excluded.contractIncome, { count: 0, qu: 0 });
});

test("a QSwap sale too small to cover the flat fee is still a sale, at a negative net price, and says why", () => {
  const h = "tinysaletinysaletinysaletinysaletinysaletinysaletinysaletinys";
  const e = only(buildLedger([qu(h, 233, 9, "9", "1", KCEB, QSWAP_ID, "100000"), own(h, 233, 9, "9", "2", KCEB, QSWAP_ID, QDOGE, "QHEART", "1000"), qu(h, 233, 9, "9", "3", QSWAP_ID, KCEB, "522")], { identity: KCEB, ownTxs: [tx(h, KCEB, QSWAP_ID, "100000", 9, 8)] }));
  assert.deepEqual([e.kind, e.quNet, e.valueQu, e.price], ["sell", -99_478, -99_478, -99.478]);
  assert.match(e.note!, /less than QSwap's flat 100,000 QU fee/);
});

test("a swap refunded in full changes nothing and is not listed", () => {
  const h = "refundrefundrefundrefundrefundrefundrefundrefundrefundrefundr";
  const l = buildLedger([qu(h, 233, 1, "1", "1", KCEB, QSWAP_ID, "100000"), qu(h, 233, 1, "1", "2", QSWAP_ID, KCEB, "100000")], { identity: KCEB, ownTxs: [tx(h, KCEB, QSWAP_ID, "100000", 1, 8)] });
  assert.equal(l.entries.length, 0);
  assert.equal(l.excluded.noChange, 1);
});

test("shares and QU swapped with something other than QX or QSwap are a trade at an unknown venue", () => {
  const h = "launchpadlaunchpadlaunchpadlaunchpadlaunchpadlaunchpadlaunchp";
  const contract = "FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXXXX";
  const e = only(buildLedger([qu(h, 233, 5, "5", "1", CUVB, contract, "1000"), own(h, 233, 5, "5", "2", contract, CUVB, QDOGE, "NEW", "10")], { identity: CUVB }));
  assert.deepEqual([e.kind, e.venue, e.price, e.feeQu], ["buy", "unknown", 100, null]);
});

/* ---------- positions and P&L ---------- */

const ME = KCEB;
let n = 0;
/** A QSwap swap of `units` (negative = sold) for `quNet` QU, as the archive logs it (epoch 214: no flat fee, so small numbers stay readable). */
function swap(units: number, quNet: number, tick: number, name = "CFB", issuer = QDOGE): WalletEvent[] {
  const h = `swap${String(++n).padStart(56, "x")}`;
  const ms = String(1_790_000_000_000 + tick * 1000);
  return [
    quNet < 0 ? qu(h, 214, tick, ms, `${tick}1`, ME, QSWAP_ID, String(-quNet)) : qu(h, 214, tick, ms, `${tick}1`, QSWAP_ID, ME, String(quNet)),
    units > 0 ? own(h, 214, tick, ms, `${tick}2`, QSWAP_ID, ME, issuer, name, String(units)) : own(h, 214, tick, ms, `${tick}2`, ME, QSWAP_ID, issuer, name, String(-units)),
  ];
}

test("average cost across several buys and sells: each sale realizes proceeds minus the average cost at that moment", () => {
  const events = [...swap(100, -1000, 1), ...swap(300, -4200, 2), ...swap(-200, 3000, 3), ...swap(100, -1100, 4), ...swap(-300, 4500, 5)];
  const l = buildLedger(events, { identity: ME });
  const sells = l.entries.filter((e) => e.kind === "sell");
  assert.equal(sells[0].realizedQu, 3000 - 200 * 13, "average after two buys: 5,200 / 400 = 13");
  assert.equal(sells[1].realizedQu, 4500 - 3700, "200 left at 13 plus 100 at 11: 3,700 for 300");
  assert.equal(l.totals.realizedQu, 1200);
  assert.deepEqual(l.entries.map((e) => e.position), [100, 400, 200, 300, 0]);
  const p = l.positions[0];
  assert.deepEqual([p.held, p.costQu, p.avgCost, p.bought, p.sold, p.spentQu, p.receivedQu, p.trades], [0, 0, null, 500, 500, 6300, 7500, 5]);
});

test("unrealized profit uses the current price for units with a known cost", () => {
  const events = [...swap(100, -1000, 1), ...swap(100, -3000, 2)];
  const l = buildLedger(events, { identity: ME, priceOf: (k) => (k === `CFB|${QDOGE}` ? 25 : null) });
  const p = l.positions[0];
  assert.deepEqual([p.avgCost, p.priceQu, p.valueQu, p.unrealizedQu, p.unrealizedPct], [20, 25, 5000, 1000, 25]);
  assert.equal(l.totals.unrealizedQu, 1000);
  const unpriced = buildLedger(events, { identity: ME });
  assert.equal(unpriced.totals.unrealizedQu, null);
  assert.equal(unpriced.totals.unpricedPositions, 1);
});

test("units with no known cost are sold after the costed ones and kept out of realized profit", () => {
  const gift = own(undefined, 233, 1, "1790000001000", "11", "YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMSME", ME, QDOGE, "CFB", "50");
  const events = [gift, ...swap(50, -500, 2), ...swap(-80, 1600, 3), ...swap(-40, 800, 4)];
  const l = buildLedger(events, { identity: ME });
  const [first, second] = l.entries.filter((e) => e.kind === "sell");
  assert.equal(first.realizedQu, 1000 - 500, "50 costed units at 10 earned 5/8 of the proceeds");
  assert.equal(second.realizedQu, null, "no costed units left");
  const p = l.positions[0];
  assert.equal(p.uncostedProceedsQu, 600 + 800);
  assert.equal(p.preWindowQty, 20, "20 more were sold than the window saw arrive");
  assert.equal(p.held, 0);
  assert.equal(l.totals.realizedQu, 500);
});

test("assets with the same name from different issuers are kept apart", () => {
  const other = "OTHERISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 60);
  const l = buildLedger([...swap(10, -100, 1, "QDOGE", QDOGE), ...swap(10, -900, 2, "QDOGE", other)], { identity: ME });
  assert.equal(l.positions.length, 2);
  assert.deepEqual(l.positions.map((p) => p.avgCost).sort(), [10, 90]);
});

test("the same event read twice is counted once", () => {
  const l = buildLedger([...SWAP_BUY, ...SWAP_BUY], { identity: JMFL });
  assert.equal(only(l).qty, 1000);
  assert.equal(only(l).quNet, -4_340_952);
});

test("an empty wallet gives zeros and nulls, never NaN", () => {
  const l = buildLedger([], { identity: ME, now: 1000 });
  assert.equal(l.entries.length, 0);
  assert.deepEqual([l.totals.trades, l.totals.realizedQu, l.totals.feesQu, l.totals.unrealizedQu], [0, 0, 0, null]);
  assert.ok(!JSON.stringify(l).includes("NaN"));
});

test("every number in a real ledger is finite, and QU amounts stay whole", () => {
  const l = buildLedger([...BID, ...MAKERS, ...SWEEP, ...SELF, ...QX_FILL, ...SWAP_BUY, DIVIDEND, DISTRIBUTION], { identity: CUVB, ownTxs: [BID_TX, SWEEP_TX], fills: MAKER_FILLS, priceOf: () => 4000 });
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} is ${v}`);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(l, "ledger");
  for (const e of l.entries) {
    assert.ok(Number.isInteger(e.quNet), `quNet ${e.quNet}`);
    if (e.valueQu !== null) assert.ok(Number.isInteger(e.valueQu));
    if (e.feeQu !== null) assert.ok(Number.isInteger(e.feeQu));
  }
  assert.ok(Number.isInteger(l.totals.spentQu) && Number.isInteger(l.totals.receivedQu) && Number.isInteger(l.totals.feesQu));
});

test("an own transaction that moved QU but has no events is reported as missing", () => {
  const l = buildLedger(SWAP_BUY, { identity: JMFL, ownTxs: [tx(SWAP_BUY_H, JMFL, QSWAP_ID, "4383361", 83082062, 7), tx("gapgapgapgapgapgapgapgapgapgapgapgapgapgapgapgapgapgapgapgapg", JMFL, QX_ID, "500", 57_828_795, 6), { ...tx("failedfailedfailedfailedfailedfailedfailedfailedfailedfailedf", JMFL, QX_ID, "500", 57_828_796, 6), moneyFlew: false }] });
  assert.equal(l.warnings.length, 1);
  assert.match(l.warnings[0], /^1 of this wallet's/);
});

/* ---------- CSV ---------- */

test("the CSV has fixed columns, UTC dates, CRLF line ends and an empty hash for events without a transaction", () => {
  const toJmfl = { ...DISTRIBUTION, assetOwnershipChange: { ...DISTRIBUTION.assetOwnershipChange!, destination: JMFL } };
  const l = buildLedger([...SWAP_BUY, toJmfl], { identity: JMFL });
  const csv = toCsv(l.entries);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], CSV_COLUMNS.join(","));
  assert.equal(lines[0], "date_utc,tx_hash,kind,venue,asset,issuer,quantity,price_qu,qu_net,est_fee_qu,position_after,realized_pnl_qu,note");
  assert.equal(lines.at(-1), "", "ends with a line break");
  const buy = lines.find((x) => x.includes(SWAP_BUY_H))!.split(",");
  assert.deepEqual(buy.slice(0, 12), [new Date(1791144876000).toISOString(), SWAP_BUY_H, "buy", "QSwap", "QMINE", QMINE, "1000", "4340.952", "-4340952", "112722", "1000", ""]);
  const dist = lines.find((x) => x.includes("QHEART"))!;
  assert.ok(dist.startsWith(`${new Date(1790938819000).toISOString()},,transfer-in,,QHEART,`), dist);
});

test("CSV cells with commas, quotes or line breaks are quoted, and formula-like text is defused", () => {
  assert.equal(csvCell('he said "hi", then\nleft'), '"he said ""hi"", then\nleft"');
  assert.equal(csvCell("=HYPERLINK(1)", true), "'=HYPERLINK(1)");
  assert.equal(csvCell("+1,2", true), `"'+1,2"`);
  assert.equal(csvCell(-12, true), "-12", "numbers are numbers");
  assert.equal(csvCell(1 / 3), "0.333333");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(Number.NaN), "");
  const e: LedgerEntry = { t: 0, tick: 1, tx: "abc", kind: "buy", venue: "QX", asset: { key: "=X|I", symbol: "=X", issuer: "I" }, qty: 1, quNet: -5, valueQu: 5, price: 5, feeQu: 0, position: 1, realizedQu: null, note: 'a "b", c' };
  const row = toCsv([e]).split("\r\n")[1];
  assert.equal(row, `1970-01-01T00:00:00.000Z,abc,buy,QX,'=X,I,1,5,-5,0,1,,"a ""b"", c"`);
});

test("positions follow the trades as a second table after an empty line", () => {
  const l = buildLedger([...swap(100, -1000, 1)], { identity: ME, priceOf: () => 12 });
  const lines = toCsv(l.entries, l.positions).split("\r\n");
  const blank = lines.indexOf("");
  assert.equal(blank, 2);
  assert.equal(lines[3], POSITION_COLUMNS.join(","));
  assert.equal(lines[4], `CFB,${QDOGE},100,10,1000,0,0,12,200,3`, "0.3% of 1,000 QU in fees");
});

/* ---------- reading the archive ---------- */

/** A stand-in for the archive that follows its rules: newest first, pages of at most 1000, a 10,000 cap, equal tick ends refused. */
function fakeArchive(opts: { lastTick: number; events?: WalletEvent[]; txs?: WalletTx[]; trades?: { hash: string; tick: number; logId: string; payload: string }[]; otherTicks?: number[]; delayMs?: number; fail?: boolean | string }) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const page = <T>(all: T[], p: { offset: number; size: number }) => {
    assert.ok(p.size <= 1000, "page size over the API's limit");
    assert.ok(p.offset < 10_000 || all.length === 0, "paged past the cap");
    return { total: Math.min(all.length, 10_000), items: all.slice(p.offset, p.offset + p.size) };
  };
  const inRange = (v: number, r?: { gte?: string; lte?: string }) => !r || ((r.gte === undefined || v >= Number(r.gte)) && (r.lte === undefined || v <= Number(r.lte)));
  const client: ArchiveClient & { calls: typeof calls } = {
    calls,
    async get<T>(path: string) {
      calls.push({ path });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error(typeof opts.fail === "string" ? opts.fail : "archive down");
      assert.ok(path.endsWith("/getLastProcessedTick"));
      return { logTickNumber: opts.lastTick } as T;
    },
    async post<T>(path: string, body: unknown) {
      const b = body as { identity?: string; filters: Record<string, string>; should?: { terms: Record<string, string> }[]; ranges?: Record<string, { gte?: string; lte?: string }>; pagination: { offset: number; size: number } };
      calls.push({ path, body: b as unknown as Record<string, unknown> });
      const tr = b.ranges?.tickNumber;
      if (tr?.gte !== undefined && tr.gte === tr.lte) throw new Error("invalid range");
      const order = (a: { tick: number; log: number }, c: { tick: number; log: number }) => c.tick - a.tick || c.log - a.log;
      if (path.endsWith("/getTransactionsForIdentity")) {
        const dests = b.filters.destination.split(",");
        const hits = (opts.txs ?? []).filter((t) => t.source === b.filters.source && dests.includes(t.destination) && inRange(t.tickNumber, tr) && inRange(Number(t.timestamp), b.ranges?.timestamp)).sort((a, c) => c.tickNumber - a.tickNumber);
        const p = page(hits, b.pagination);
        return { hits: { total: p.total }, transactions: p.items } as T;
      }
      assert.ok(path.endsWith("/getEventLogs"));
      if (b.should) {
        const id = b.should[0].terms.source;
        assert.equal(b.should[0].terms.destination, id);
        assert.equal(b.filters.logType, "0,2");
        const hits = (opts.events ?? [])
          .filter((e) => {
            const p = e.quTransfer ?? e.assetOwnershipChange!;
            return (p.source === id || p.destination === id) && inRange(e.tickNumber, tr) && inRange(Number(e.timestamp), b.ranges?.timestamp);
          })
          .sort((a, c) => order({ tick: a.tickNumber, log: Number(a.logId) }, { tick: c.tickNumber, log: Number(c.logId) }));
        const p = page(hits, b.pagination);
        return { hits: { total: p.total }, eventLogs: p.items } as T;
      }
      if (!b.filters) {
        // a probe for gaps: is there any event at all in this tick range?
        const any = [...(opts.events ?? []).map((e) => e.tickNumber), ...(opts.trades ?? []).map((t) => t.tick), ...(opts.otherTicks ?? [])].filter((t) => inRange(t, tr));
        return { hits: { total: any.length }, eventLogs: [] } as T;
      }
      assert.deepEqual(b.filters, { logType: "6", contractIndex: "1" });
      const hits = (opts.trades ?? [])
        .filter((t) => inRange(t.tick, tr))
        .sort((a, c) => order({ tick: a.tick, log: Number(a.logId) }, { tick: c.tick, log: Number(c.logId) }))
        .map((t) => ({ epoch: 212, tickNumber: t.tick, timestamp: "1", transactionHash: t.hash, logType: 6, logId: t.logId, rawPayload: t.payload, smartContractMessage: { contractIndex: "1", contractMessageType: "0" } }));
      const p = page(hits, b.pagination);
      return { hits: { total: p.total }, eventLogs: p.items } as T;
    },
  };
  return client;
}

/** QX's TradeMessage body for QMINE: issuer key, asset name, price, units. */
function qmineTrade(price: number, qty: number): string {
  const [name, issuer] = QMINE_KEY.split("|");
  const b = Buffer.alloc(56);
  Buffer.from(issuer, "hex").copy(b, 0);
  b.writeBigUInt64LE(BigInt(name), 32);
  b.writeBigInt64LE(BigInt(price), 40);
  b.writeBigInt64LE(BigInt(qty), 48);
  return b.toString("base64");
}

const NOW = 1778400000000; // shortly after the CUVB fixtures

test("reads the wallet's events in one query, its own transactions, and QX fills around shares that came without QU", async () => {
  const archive = fakeArchive({
    lastTick: 51_900_000,
    events: [...BID, ...MAKERS],
    txs: [{ ...BID_TX, timestamp: "1778345398000" }],
    trades: [
      { hash: MAKER1_H, tick: 51851256, logId: "128519907", payload: qmineTrade(4650, 60000) },
      { hash: MAKER2_H, tick: 51852570, logId: "128982110", payload: qmineTrade(4650, 1751) },
      { hash: "someoneelse".padEnd(60, "x"), tick: 51852000, logId: "128700000", payload: qmineTrade(4700, 5) },
    ],
  });
  const input = await fetchLedgerInput(archive, CUVB, { now: NOW, days: 30 });
  assert.equal(input.events.length, 4);
  assert.equal(input.ownTxs.length, 1);
  assert.deepEqual([...input.fills.keys()].sort(), [MAKER1_H, MAKER2_H].sort());
  assert.equal(input.requests, 4, "last tick, own transactions, events, one fill lookup for both nearby candidates");
  const walletQuery = archive.calls[2].body as { ranges: Record<string, { gte?: string; lte?: string }> };
  assert.equal(walletQuery.ranges.tickNumber.lte, "51900000", "never newer than the archive's last complete tick");
  assert.equal(walletQuery.ranges.timestamp.gte, String(NOW - 30 * 86_400_000));
  const ledger = buildLedger(input.events, { ...input });
  assert.deepEqual(trades(ledger).map((e) => e.qty), [42_852, 60_000, 1751]);
  assert.equal(ledger.truncated, false);
});

test("a transaction of the wallet's that falls in a gap of the archive's event log is reported by date", async () => {
  const placed = { ...PLACED_TX, hash: "gapaskgapaskgapaskgapaskgapaskgapaskgapaskgapaskgapaskgapask", tickNumber: 57_933_566, timestamp: String(Date.UTC(2026, 5, 11, 19)), amount: "0", inputType: 5 };
  const quiet = { ...PLACED_TX, hash: "quietquietquietquietquietquietquietquietquietquietquietquietq", tickNumber: 82_629_000, timestamp: String(Date.UTC(2026, 9, 1, 10)), amount: "0", inputType: 5 };
  const archive = fakeArchive({ lastTick: 83_000_000, events: PLACED, txs: [placed, quiet], otherTicks: [82_629_050] });
  const input = await fetchLedgerInput(archive, FALL, { now: Date.UTC(2026, 9, 4), days: 180 });
  assert.equal(input.warnings.length, 1);
  assert.match(input.warnings[0], /no events at all around 2026-06-11,/);
  assert.equal(input.requests, 5, "last tick, own transactions, events, two probes");
  const l = buildLedger(input.events, { ...input });
  assert.deepEqual(l.warnings, input.warnings);
});

test("a long history is paged, and one that passes the 10,000 cap is split by time without losing or repeating anything", async () => {
  const events: WalletEvent[] = [];
  for (let i = 0; i < 10_400; i++) events.push(qu(`h${i}`.padEnd(60, "q"), 233, 1000 + i, String(NOW - 10_400_000 + i * 1000), String(i), CUVB, FALL, "1"));
  const archive = fakeArchive({ lastTick: 50_000, events });
  const input = await fetchLedgerInput(archive, CUVB, { now: NOW, days: 1, maxRequests: 100 });
  assert.equal(input.events.length, 10_400);
  assert.equal(new Set(input.events.map((e) => e.logId)).size, 10_400);
  assert.equal(input.truncatedReasons.length, 0);
  const l = buildLedger(input.events, { ...input });
  assert.equal(l.excluded.transfersOut.count, 10_400);
});

test("stops at the request budget, keeps the newest complete stretch and says so", async () => {
  const events: WalletEvent[] = [];
  for (let i = 0; i < 2500; i++) events.push(qu(`h${i}`.padEnd(60, "q"), 233, 1000 + Math.floor(i / 2), String(NOW - 2_500_000 + i * 1000), String(i), CUVB, FALL, "1"));
  const archive = fakeArchive({ lastTick: 50_000, events });
  const input = await fetchLedgerInput(archive, CUVB, { now: NOW, days: 1, maxRequests: 3 });
  assert.equal(input.requests, 3);
  assert.ok(input.truncatedReasons[0].includes("covers"), input.truncatedReasons[0]);
  assert.ok(input.events.length < 1000 && input.events.length > 990, "the oldest tick read, possibly cut in half, is dropped");
  assert.ok(input.coveredFromMs > NOW - 86_400_000);
  const l = buildLedger(input.events, { ...input });
  assert.equal(l.truncated, true);
});

/* ---------- the API ---------- */

const ask = (routes: ReturnType<typeof ledgerRoutes>, q: Record<string, string>) => routes[0].handler({ query: new URLSearchParams(q), body: undefined });

test("the endpoint refuses anything but a 60-letter uppercase identity and a sensible number of days", async () => {
  const routes = ledgerRoutes({ rpc: fakeArchive({ lastTick: 1 }), priceOf: () => null });
  assert.equal(routes[0].path, "/v1/ledger");
  const bad: Record<string, string>[] = [{}, { identity: CUVB.toLowerCase() }, { identity: CUVB.slice(1) }, { identity: `${CUVB}A` }, { identity: CUVB.replace("C", "1") }];
  for (const q of bad) await assert.rejects(Promise.resolve(ask(routes, q)), (e: unknown) => e instanceof RouteError && e.status === 400);
  for (const days of ["0", "366", "1.5", "abc", "-3"]) await assert.rejects(Promise.resolve(ask(routes, { identity: CUVB, days })), (e: unknown) => e instanceof RouteError && e.status === 400 && /days/.test(e.message));
  await assert.rejects(Promise.resolve(ask(routes, { identity: CUVB, format: "xml" })), (e: unknown) => e instanceof RouteError && e.status === 400);
});

test("the endpoint answers JSON by default and a named CSV download on request", async () => {
  const routes = ledgerRoutes({ rpc: fakeArchive({ lastTick: 83_200_000, events: QX_FILL, txs: [{ ...QX_FILL_TX, timestamp: "1791156484000" }] }), priceOf: (k) => (k === `QMINE|${QMINE}` ? 4200 : null), now: () => 1791160000000 });
  const json = (await ask(routes, { identity: TNYY })) as Ledger;
  assert.equal(json.identity, TNYY);
  assert.equal(json.totals.trades, 1);
  assert.equal(json.positions[0].unrealizedQu, (4200 - 4154) * 44_993);
  const csv = await ask(routes, { identity: TNYY, format: "csv", days: "30" });
  assert.ok(csv instanceof Raw);
  assert.equal(csv.contentType, "text/csv; charset=utf-8");
  assert.equal(csv.filename, "qmax-ledger-TNYYHTXO.csv");
  assert.ok(csv.body.startsWith("date_utc,tx_hash,"));
  assert.ok(csv.body.includes(QX_FILL_H));
});

test("a ledger is reused for 60 seconds, then rebuilt; the same wallet asked twice at once is built once", async () => {
  let clock = 1791160000000;
  const archive = fakeArchive({ lastTick: 83_200_000, events: QX_FILL, delayMs: 5 });
  const routes = ledgerRoutes({ rpc: archive, priceOf: () => null, now: () => clock });
  await Promise.all([ask(routes, { identity: HCFQ }), ask(routes, { identity: HCFQ })]);
  const first = archive.calls.length;
  assert.equal(first, 3, "one build: last tick, own transactions, events");
  clock += 59_000;
  await ask(routes, { identity: HCFQ, format: "csv" });
  assert.equal(archive.calls.length, first, "the CSV comes from the same cached ledger");
  await ask(routes, { identity: HCFQ, days: "30" });
  assert.equal(archive.calls.length, first * 2, "another window is another ledger");
  clock += 2_000;
  await ask(routes, { identity: HCFQ });
  assert.equal(archive.calls.length, first * 3, "older than 60 s: rebuilt");
});

test("only a few ledgers are built at once; more are told to retry", async () => {
  const routes = ledgerRoutes({ rpc: fakeArchive({ lastTick: 1, delayMs: 30 }), priceOf: () => null, maxConcurrent: 1 });
  const running = ask(routes, { identity: HCFQ });
  await assert.rejects(Promise.resolve(ask(routes, { identity: TNYY })), (e: unknown) => e instanceof RouteError && e.status === 503 && e.extra.retryAfterSec === 5);
  await running;
  await ask(routes, { identity: TNYY });
});

test("an archive failure is a 502 and is not cached", async () => {
  const archive = fakeArchive({ lastTick: 1, fail: true });
  const routes = ledgerRoutes({ rpc: archive, priceOf: () => null });
  await assert.rejects(Promise.resolve(ask(routes, { identity: HCFQ })), (e: unknown) => e instanceof RouteError && e.status === 502 && /archive down/.test(e.message));
  await assert.rejects(Promise.resolve(ask(routes, { identity: HCFQ })), (e: unknown) => e instanceof RouteError && e.status === 502);
  assert.equal(archive.calls.length, 2, "asked again, not served from cache");
});

test("an archive that is rate limited or timing out is a 503 that says when to ask again, not a failure", async () => {
  for (const why of ["Qubic RPC unavailable: RPC 429", "Qubic RPC unavailable: The operation timed out", "rate limit reached"]) {
    const routes = ledgerRoutes({ rpc: fakeArchive({ lastTick: 1, fail: why }), priceOf: () => null });
    await assert.rejects(Promise.resolve(ask(routes, { identity: HCFQ })), (e: unknown) => e instanceof RouteError && e.status === 503 && e.extra.retryAfterSec === 30 && /busy/.test(e.message), why);
  }
});

test("after the archive says it is rate limiting, no new ledger is started for 30 seconds, then it is tried again", async () => {
  let clock = 1791160000000;
  const archive = fakeArchive({ lastTick: 1, fail: "Qubic RPC unavailable: RPC 429" });
  const routes = ledgerRoutes({ rpc: archive, priceOf: () => null, now: () => clock });
  await assert.rejects(Promise.resolve(ask(routes, { identity: HCFQ })), (e: unknown) => e instanceof RouteError && e.status === 503);
  const calls = archive.calls.length;
  // a different wallet, a moment later: refused without touching the archive
  clock += 5_000;
  await assert.rejects(Promise.resolve(ask(routes, { identity: TNYY })), (e: unknown) => e instanceof RouteError && e.status === 503 && (e.extra.retryAfterSec as number) >= 5 && (e.extra.retryAfterSec as number) <= 30);
  assert.equal(archive.calls.length, calls);
  clock += 26_000;
  await assert.rejects(Promise.resolve(ask(routes, { identity: TNYY })), RouteError);
  assert.ok(archive.calls.length > calls, "tried again once the pause was over");
});
