import { test } from "node:test";
import assert from "node:assert/strict";
import type { TxStep } from "../src/exec.ts";
import { assetNameToU64, bytesToHex, identityToBytes } from "../src/identity.ts";
import {
  LIQUIDITY_FEE_QU,
  QSWAP_FN,
  addLiquidityStep,
  decodeAddLiquidityEvent,
  decodeLiquidityOf,
  decodePoolState,
  decodeRemoveLiquidityEvent,
  encodeLiquidityQuery,
  encodePoolQuery,
  liquidityRoutes,
  maxAddQu,
  minSlippageBpsFor,
  minTokensForSlippage,
  noChangeNotes,
  planAddLiquidity,
  planRemoveLiquidity,
  positionValue,
  predictAdd,
  predictRemove,
  recheckAdd,
  recheckRemove,
  removeLiquidityStep,
} from "../src/liquidity.ts";
import type { AddPlan, AddPlanInput, AssetRef, LiquidityDeps, LiquidityStep, PoolState, PositionsResponse } from "../src/liquidity.ts";
import { RouteError } from "../src/routes.ts";

/* =================================================================================================================
 * An independent simulation of the two contracts, written from Qswap.h and Qx.h (main branch, read 2026-10-04), NOT from
 * src/liquidity.ts. Line numbers refer to Qswap.h unless they say Qx.h. It keeps QU balances, shares per owner and managing
 * contract, the pool, every liquidity provider's record (with the fee bookkeeping) and what the contract kept, and it runs
 * the planner's real steps from their payload BYTES, so the encoding is tested too.
 * ================================================================================================================= */

const QX = 1;
const QSWAP = 13;
const FEE = 100_000n; // QSWAP_ADDITIONAL_FEE (L19)
const MIN_LIQ = 1000n; // QSWAP_MIN_LIQUIDITY (L18)
const I64_MAX = (1n << 63n) - 1n;
const QX_TRANSFER_FEE = 100n; // Qx.h state _transferFee since epoch 138 (Qx.h L1148); QX asks it for taking shares over (Qx.h L1183)
const SWAP_FEE_RATE = 30n; // L2392
const qdiv = (a: bigint, b: bigint) => (b === 0n ? 0n : a / b); // QPI div: 0 for a zero divisor

const USER = "USER";
const TRADER = "TRADER";
const ISSUER = "QCAPWMYRSHLBJHSTTZQVCIBARVOASKDENASAKNOBRGPFWWKRCUVUAXYEZVOG";
const ASSET: AssetRef = { symbol: "QCAP", issuer: ISSUER, assetName: "QCAP" };

interface LpRecord {
  liquidity: bigint;
  feeDebtX64: bigint;
  accumulatedFee: bigint;
}

class Sim {
  qu = new Map<string, bigint>();
  /** Shares of the one asset in play, keyed `${owner}|${managingContract}` (ownership and possession move together here). */
  shares = new Map<string, bigint>();
  /** QX: shares in each owner's resting asks, which QX will not release (Qx.h L1095). */
  reservedInAsks = new Map<string, bigint>();
  pool: { exists: boolean; rQu: bigint; rAsset: bigint; total: bigint; accFeePerLPX64: bigint };
  lp = new Map<string, LpRecord>();
  /** Every attachment a step carried, with the wallet's balance at that moment (to prove no step attached more than it held). */
  attachments: { amount: bigint; balance: bigint }[] = [];
  /** Shareholder and burn bookkeeping of the flat fee (L1221-1222, L1311-1312, L1456-1457). */
  feesKept = 0n;
  /** What third parties' swaps paid the contract (flat fee and the protocol's part of the swap fee); not the user's. */
  tradeFees = 0n;
  /** The pool's price at each third-party swap: a fee added at price p is worth sqrt(final / p) times as much later. */
  swapPrices: number[] = [];
  issuerBytes = identityToBytes(ISSUER);
  nameU64 = assetNameToU64("QCAP");

  constructor(pool: { rQu: bigint; rAsset: bigint; total: bigint }, exists = true) {
    this.pool = { exists, ...pool, accFeePerLPX64: 0n };
    this.qu.set("QSWAP", pool.rQu);
    this.shares.set("QSWAP|13", pool.rAsset);
    if (pool.total > 0n) this.lp.set("QSWAP", { liquidity: MIN_LIQ, feeDebtX64: 0n, accumulatedFee: 0n });
    // Everyone else's liquidity, so the records add up to the total.
    if (pool.total > MIN_LIQ) this.lp.set("OTHERS", { liquidity: pool.total - MIN_LIQ, feeDebtX64: 0n, accumulatedFee: 0n });
  }

  balance = (id: string) => this.qu.get(id) ?? 0n;
  possessed = (owner: string, manager: number) => this.shares.get(`${owner}|${manager}`) ?? 0n;
  tokens = (owner: string) => this.possessed(owner, QX) + this.possessed(owner, QSWAP);
  liquidityOf = (owner: string) => this.lp.get(owner)?.liquidity ?? 0n;

  private transfer(from: string, to: string, amount: bigint) {
    if (amount <= 0n) return;
    assert.ok(this.balance(from) >= amount, `${from} cannot pay ${amount}`);
    this.qu.set(from, this.balance(from) - amount);
    this.qu.set(to, this.balance(to) + amount);
  }
  private moveShares(fromOwner: string, toOwner: string, manager: number, n: bigint): boolean {
    if (n <= 0n || this.possessed(fromOwner, manager) < n) return false; // QPI rejects 0 and short transfers
    this.shares.set(`${fromOwner}|${manager}`, this.possessed(fromOwner, manager) - n);
    this.shares.set(`${toOwner}|${manager}`, this.possessed(toOwner, manager) + n);
    return true;
  }
  private rightsMove(owner: string, from: number, to: number, n: bigint) {
    this.shares.set(`${owner}|${from}`, this.possessed(owner, from) - n);
    this.shares.set(`${owner}|${to}`, this.possessed(owner, to) + n);
  }

  /**
   * One transaction. Qubic runs it only if the source holds the amount; the amount then moves to the contract and the
   * procedure runs with it as `invocationReward`.
   */
  send(from: string, step: Pick<TxStep, "to" | "inputType" | "amountQu" | "payload">): { executed: boolean; result?: unknown } {
    const amount = BigInt(step.amountQu);
    const contract = "contractIndex" in step.to ? step.to.contractIndex : -1;
    this.attachments.push({ amount, balance: this.balance(from) });
    if (this.balance(from) < amount) return { executed: false };
    const name = contract === QX ? "QX" : "QSWAP";
    this.transfer(from, name, amount);
    const v = new DataView(step.payload.buffer, step.payload.byteOffset, step.payload.byteLength);
    const sameAsset = bytesToHex(step.payload.subarray(0, 32)) === bytesToHex(this.issuerBytes) && v.getBigUint64(32, true) === this.nameU64;
    if (contract === QX && step.inputType === 9) return { executed: true, result: this.qxTransferRights(from, amount, v.getBigInt64(40, true), v.getUint32(48, true)) };
    if (contract === QSWAP && step.inputType === 4)
      return { executed: true, result: this.addLiquidity(from, amount, sameAsset, v.getBigInt64(40, true), v.getBigInt64(48, true), v.getBigInt64(56, true)) };
    if (contract === QSWAP && step.inputType === 5)
      return { executed: true, result: this.removeLiquidity(from, amount, sameAsset, v.getBigInt64(40, true), v.getBigInt64(48, true), v.getBigInt64(56, true)) };
    if (contract === QSWAP && step.inputType === 11) return { executed: true, result: this.qswapTransferRights(from, amount, v.getBigInt64(40, true), v.getUint32(48, true)) };
    throw new Error(`The simulation does not know contract ${contract} procedure ${step.inputType}`);
  }

  /** Qx.h TransferShareManagementRights (L1084-1114). QSwap accepts management for no fee (Qswap.h PRE_ACQUIRE_SHARES, L2488-2491). */
  qxTransferRights(user: string, reward: bigint, n: bigint, newIndex: number): bigint {
    if (reward > 0n) this.transfer("QX", user, reward); // L1087-1090: "no fee"
    const available = this.possessed(user, QX) - (this.reservedInAsks.get(user) ?? 0n);
    if (available < n) return 0n; // L1095-1099
    // L1102: releaseShares with no fee offered. It fails for n <= 0 and for a contract that wants a fee; QSwap asks none.
    if (n <= 0n || newIndex !== QSWAP) return 0n;
    this.rightsMove(user, QX, QSWAP, n);
    return n;
  }

  /** Qswap.h TransferShareManagementRights (L2319-2362), to QX, which asks its transfer fee (Qx.h L1178-1185). */
  qswapTransferRights(user: string, reward: bigint, n: bigint, newIndex: number): bigint {
    let refund = reward;
    let moved = 0n;
    if (this.possessed(user, QSWAP) >= n && n > 0n && newIndex === QX && reward >= QX_TRANSFER_FEE) {
      this.rightsMove(user, QSWAP, QX, n);
      this.transfer("QSWAP", "QX", QX_TRANSFER_FEE); // the fee goes to the receiving contract
      refund = reward - QX_TRANSFER_FEE;
      moved = n;
    }
    if (refund > 0n) this.transfer("QSWAP", user, refund);
    return moved;
  }

  /** AddLiquidity, L1057-1355, line by line. Returns the procedure's output. */
  addLiquidity(user: string, reward: bigint, poolFound: boolean, assetAmountDesired: bigint, quAmountMin: bigint, assetAmountMin: bigint) {
    const out = { userIncreaseLiquidity: 0n, quAmount: 0n, assetAmount: 0n };
    const refundAll = () => {
      this.transfer("QSWAP", user, reward);
      return out;
    };
    if (reward <= FEE) return refundAll(); // L1064-1068
    const quAmountDesired = reward - FEE; // L1070
    if (assetAmountDesired <= 0n || quAmountMin < 0n || assetAmountMin < 0n) return refundAll(); // L1073-1079
    if (!poolFound || !this.pool.exists) return refundAll(); // L1089-1093
    const p = this.pool;
    let quTransferAmount: bigint;
    let assetTransferAmount: bigint;
    if (p.total === 0n) {
      quTransferAmount = quAmountDesired; // L1101-1102
      assetTransferAmount = assetAmountDesired;
    } else {
      let assetOptimalAmount = qdiv(quAmountDesired * p.rAsset, p.rQu); // L1106-1111, quoteEquivalentAmountB (L419-432)
      if (assetOptimalAmount > I64_MAX) assetOptimalAmount = -1n;
      if (assetOptimalAmount === -1n) return refundAll(); // L1113-1117
      if (assetOptimalAmount <= assetAmountDesired) {
        if (assetOptimalAmount < assetAmountMin) return refundAll(); // L1121-1125
        quTransferAmount = quAmountDesired; // L1126-1127
        assetTransferAmount = assetOptimalAmount;
      } else {
        let quOptimalAmount = qdiv(assetAmountDesired * p.rQu, p.rAsset); // L1131-1136
        if (quOptimalAmount > I64_MAX) quOptimalAmount = -1n;
        if (quOptimalAmount === -1n) return refundAll(); // L1138-1142
        if (quOptimalAmount > quAmountDesired) return refundAll(); // L1143-1147
        if (quOptimalAmount < quAmountMin) return refundAll(); // L1148-1152
        quTransferAmount = quOptimalAmount; // L1153-1154
        assetTransferAmount = assetAmountDesired;
      }
    }
    if (reward < quTransferAmount) return refundAll(); // L1159-1163
    if (this.possessed(user, QSWAP) < assetTransferAmount) return refundAll(); // L1166-1177 (owned and possessed under SELF_INDEX)

    let increaseLiquidity: bigint;
    if (p.total === 0n) {
      // L1182: sqrt(a x b), rounded down
      const prod = quTransferAmount * assetTransferAmount;
      let x = prod;
      let y = (x + 1n) / 2n;
      while (y < x) {
        x = y;
        y = (x + prod / x) / 2n;
      }
      increaseLiquidity = quTransferAmount === assetTransferAmount ? quTransferAmount : prod < 2n ? prod : x;
      if (increaseLiquidity < MIN_LIQ) return refundAll(); // L1184-1188
      if (!this.moveShares(user, "QSWAP", QSWAP, assetTransferAmount)) return refundAll(); // L1190-1219
      this.feesKept += FEE; // L1221-1222
      this.lp.set("QSWAP", { liquidity: MIN_LIQ, feeDebtX64: 0n, accumulatedFee: 0n }); // L1225-1226
      this.lp.set(user, { liquidity: increaseLiquidity - MIN_LIQ, feeDebtX64: 0n, accumulatedFee: 0n }); // L1228-1229
      out.userIncreaseLiquidity = increaseLiquidity - MIN_LIQ;
    } else {
      const tmpIncLiq0 = qdiv(quTransferAmount * p.total, p.rQu); // L1237-1240
      if (tmpIncLiq0 > I64_MAX) return refundAll(); // L1241-1245
      const tmpIncLiq1 = qdiv(assetTransferAmount * p.total, p.rAsset); // L1246-1249
      if (tmpIncLiq1 > I64_MAX) return refundAll(); // L1250-1254
      increaseLiquidity = tmpIncLiq0 < tmpIncLiq1 ? tmpIncLiq0 : tmpIncLiq1; // L1260
      if (increaseLiquidity === 0n) return refundAll(); // L1263-1267
      // L1272 (collection full) is not modelled: the real one has room for 8,192 x 256 positions.
      if (!this.moveShares(user, "QSWAP", QSWAP, assetTransferAmount)) return refundAll(); // L1279-1309
      this.feesKept += FEE; // L1311-1312
      const rec = this.lp.get(user);
      if (!rec) this.lp.set(user, { liquidity: increaseLiquidity, feeDebtX64: p.accFeePerLPX64, accumulatedFee: 0n }); // L1314-1319
      else {
        const pending = rec.liquidity * (p.accFeePerLPX64 - rec.feeDebtX64); // L1323-1324
        rec.accumulatedFee += pending >> 64n;
        rec.liquidity += increaseLiquidity;
        rec.feeDebtX64 = p.accFeePerLPX64;
      }
      out.userIncreaseLiquidity = increaseLiquidity;
    }
    out.quAmount = quTransferAmount; // L1231-1232, L1330-1331
    out.assetAmount = assetTransferAmount;
    p.rQu += quTransferAmount; // L1335-1337
    p.rAsset += assetTransferAmount;
    p.total += increaseLiquidity;
    if (reward - FEE > quTransferAmount) this.transfer("QSWAP", user, reward - quTransferAmount - FEE); // L1351-1354
    return out;
  }

  /** RemoveLiquidity, L1375-1500, line by line. */
  removeLiquidity(user: string, reward: bigint, poolFound: boolean, burnLiquidity: bigint, quAmountMin: bigint, assetAmountMin: bigint) {
    const out = { quAmount: 0n, assetAmount: 0n };
    if (reward < FEE) {
      this.transfer("QSWAP", user, reward); // L1380-1384
      return out;
    } else if (reward > FEE) this.transfer("QSWAP", user, reward - FEE); // L1385-1388
    const refundFee = () => {
      this.transfer("QSWAP", user, FEE);
      return out;
    };
    if (quAmountMin < 0n || assetAmountMin < 0n || burnLiquidity <= 0n) return refundFee(); // L1391-1395
    if (!poolFound || !this.pool.exists) return refundFee(); // L1406-1410
    const p = this.pool;
    const rec = this.lp.get(user);
    if (!rec) return refundFee(); // L1416-1420
    if (rec.liquidity < burnLiquidity) return refundFee(); // L1425-1429
    if (p.total < burnLiquidity) return refundFee(); // L1431-1435
    const burnQuAmount = qdiv(burnLiquidity * p.rQu, p.total); // L1438-1441
    const burnAssetAmount = qdiv(burnLiquidity * p.rAsset, p.total); // L1444-1447
    if (burnQuAmount < quAmountMin || burnAssetAmount < assetAmountMin) return refundFee(); // L1450-1454
    this.feesKept += FEE; // L1456-1457
    this.transfer("QSWAP", user, burnQuAmount); // L1460
    this.moveShares("QSWAP", user, QSWAP, burnAssetAmount); // L1461-1468: result not checked; stays under QSwap management
    out.quAmount = burnQuAmount;
    out.assetAmount = burnAssetAmount;
    const pending = rec.liquidity * (p.accFeePerLPX64 - rec.feeDebtX64); // L1474
    rec.liquidity -= burnLiquidity; // L1475
    if (rec.liquidity === 0n) this.lp.delete(user); // L1476-1479
    else {
      rec.accumulatedFee += pending >> 64n; // L1482-1484
      rec.feeDebtX64 = p.accFeePerLPX64;
    }
    p.total -= burnLiquidity; // L1488-1490
    p.rQu -= burnQuAmount;
    p.rAsset -= burnAssetAmount;
    return out;
  }

  /** The protocol's share of a swap fee (27 + 5 + 3 + 1 percent, each rounded down) and the fee itself (L1589-1599). */
  private feeParts(base: bigint, divisor = 10_000n) {
    let swapFee = (base * SWAP_FEE_RATE) / divisor;
    if (swapFee === 0n) swapFee = 100n;
    const parts = (swapFee * 27n) / 100n + (swapFee * 5n) / 100n + (swapFee * 3n) / 100n + (swapFee * 1n) / 100n;
    return { swapFee, parts };
  }

  /** A third party buying tokens with exactly `quIn` QU: SwapExactQuForAsset (L1527-1651), no minimum. */
  swapQuIn(quIn: bigint) {
    const p = this.pool;
    if (quIn <= 0n || p.total === 0n) return;
    const w = quIn * (10_000n - SWAP_FEE_RATE);
    const out = (p.rAsset * w) / (p.rQu * 10_000n + w);
    const { swapFee, parts } = this.feeParts(quIn);
    if (out <= 0n || quIn < parts || out >= p.rAsset) return; // the transfer of 0 fails (L1621); never empty the pool here
    this.swapPrices.push(Number(p.rQu) / Number(p.rAsset));
    this.qu.set(TRADER, this.balance(TRADER) + quIn + FEE);
    this.transfer(TRADER, "QSWAP", quIn + FEE);
    this.moveShares("QSWAP", TRADER, QSWAP, out);
    this.tradeFees += FEE + parts;
    this.transfer("QSWAP", "PROTOCOL", parts); // what leaves for shareholders, QX, Invest & Rewards and burning
    p.rQu += quIn - parts; // L1636
    p.rAsset -= out;
    p.accFeePerLPX64 += ((swapFee - parts) << 64n) / p.total; // L1638-1640
  }

  /** A third party selling exactly `assetIn` tokens: SwapExactAssetForQu (L1835-2024), no minimum. */
  swapAssetIn(assetIn: bigint) {
    const p = this.pool;
    if (assetIn <= 0n || p.total === 0n) return;
    const gross = (p.rQu * assetIn) / (p.rAsset + assetIn); // getAmountOutTakeFeeFromOutToken (L494-510)
    const quOut = (gross * (10_000n - SWAP_FEE_RATE)) / 10_000n; // L1911-1914
    const { swapFee, parts } = this.feeParts(gross);
    if (quOut + parts >= p.rQu) return; // keep this simple: never drain the QU side (L2003-2006 would zero it)
    this.swapPrices.push(Number(p.rQu) / Number(p.rAsset));
    this.shares.set(`${TRADER}|13`, this.possessed(TRADER, QSWAP) + assetIn);
    this.qu.set(TRADER, this.balance(TRADER) + FEE);
    this.transfer(TRADER, "QSWAP", FEE);
    this.moveShares(TRADER, "QSWAP", QSWAP, assetIn);
    this.tradeFees += FEE + parts;
    this.transfer("QSWAP", TRADER, quOut);
    this.transfer("QSWAP", "PROTOCOL", parts);
    p.rAsset += assetIn; // L2001
    p.rQu -= quOut + parts; // L2002-2009
    p.accFeePerLPX64 += ((swapFee - parts) << 64n) / p.total; // L2010-2012
  }

  /** Another liquidity provider joins in proportion (the price stays, the pool grows): what AddLiquidity's token-side path does. */
  othersJoin(fraction: number) {
    const p = this.pool;
    const add = BigInt(Math.floor(Number(p.total) * fraction));
    if (add <= 0n) return;
    const q = (add * p.rQu) / p.total;
    const a = (add * p.rAsset) / p.total;
    this.qu.set("QSWAP", this.balance("QSWAP") + q);
    this.shares.set("QSWAP|13", this.possessed("QSWAP", QSWAP) + a);
    p.rQu += q;
    p.rAsset += a;
    p.total += add;
    this.lp.get("OTHERS")!.liquidity += add;
  }

  /** GetLiquidityOf's earnedFees (L649-656). */
  earnedFees(owner: string) {
    const r = this.lp.get(owner);
    return r ? r.accumulatedFee + ((r.liquidity * (this.pool.accFeePerLPX64 - r.feeDebtX64)) >> 64n) : 0n;
  }

  state(): PoolState {
    return { exists: this.pool.exists, reserveQu: Number(this.pool.rQu), reserveAsset: Number(this.pool.rAsset), totalLiquidity: Number(this.pool.total) };
  }

  /** The pool's books balance: the contract holds the reserves (plus fees not yet distributed), and the records add up. */
  assertSolvent() {
    const p = this.pool;
    assert.ok(this.possessed("QSWAP", QSWAP) >= p.rAsset, "the contract holds the tokens the pool counts");
    let sum = 0n;
    for (const r of this.lp.values()) sum += r.liquidity;
    assert.equal(sum, p.total, "liquidity records add up to the pool's total");
  }
}

/* ---------- helpers ---------- */

/** A seeded random generator (mulberry32), so a failure can be reproduced. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    /** Log-uniform between lo and hi. */
    log: (lo: number, hi: number) => Math.floor(Math.exp(Math.log(lo) + next() * (Math.log(hi) - Math.log(lo)))),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
  };
}

const FEES = { qx: 100, qswap: 100 };
const pool = (rQu: number, rAsset: number, total: number, exists = true): PoolState => ({ exists, reserveQu: rQu, reserveAsset: rAsset, totalLiquidity: total });
const simOf = (p: PoolState) => new Sim({ rQu: BigInt(p.reserveQu), rAsset: BigInt(p.reserveAsset), total: BigInt(p.totalLiquidity) }, p.exists);
const addInput = (over: Partial<AddPlanInput> = {}): AddPlanInput => ({
  asset: ASSET,
  pool: pool(1_930_194_478, 7_127, 3_694_927),
  quAmount: 100_000_000,
  balanceQu: 1e12,
  holdings: { [QX]: 0, [QSWAP]: 1_000_000 },
  slippageBps: 100,
  transferFeeQu: FEES,
  ...over,
});
/** Gives the wallet in `sim` the plan input's QU and tokens (shares under QX and QSwap). */
function fund(sim: Sim, balanceQu: number, holdings: Record<number, number>, reservedInAsks = 0) {
  sim.qu.set(USER, BigInt(balanceQu));
  sim.shares.set(`${USER}|1`, BigInt(holdings[QX] ?? 0) + BigInt(reservedInAsks));
  sim.shares.set(`${USER}|13`, BigInt(holdings[QSWAP] ?? 0));
  sim.reservedInAsks.set(USER, BigInt(reservedInAsks));
}
const run = (sim: Sim, steps: LiquidityStep[]) => steps.map((s) => sim.send(USER, s));

/* =================================================================================================================
 * The simulator is faithful: it reproduces real executions read from the archive
 * ================================================================================================================= */

/** Pool states just before real liquidity changes, rebuilt by walking the live state back through every logged event (scripts/liquidity-check.ts). */
const REAL = [
  { kind: "add", symbol: "QMINE", tick: 82945332, pool: pool(292996220, 71048, 4388028), call: { amountQu: 4141441, assetAmountDesired: 980, quAmountMin: 4021233, assetAmountMin: 975 }, logged: { liquidity: 60526, quAmount: 4041441, assetAmount: 980 } },
  { kind: "add", symbol: "QMINE", tick: 82920357, pool: pool(188679042, 47023, 2864894), call: { amountQu: 100416116, assetAmountDesired: 25001, quAmountMin: 99814535, assetAmountMin: 24875 }, logged: { liquidity: 1523134, quAmount: 100316116, assetAmount: 25000 } },
  { kind: "add", symbol: "QMINE", tick: 82849995, pool: pool(129073007, 31601, 1942738), call: { amountQu: 61370978, assetAmountDesired: 15001, quAmountMin: 60964623, assetAmountMin: 14925 }, logged: { liquidity: 922156, quAmount: 61270978, assetAmount: 15000 } },
  { kind: "add", symbol: "QMINE", tick: 82840657, pool: pool(88229704, 21602, 1328029), call: { amountQu: 40943303, assetAmountDesired: 10000, quAmountMin: 40639086, assetAmountMin: 9950 }, logged: { liquidity: 614709, quAmount: 40843303, assetAmount: 9999 } },
  { kind: "add", symbol: "QCAP", tick: 82907843, pool: pool(1951609246, 7006, 3683885), call: { amountQu: 6100000, assetAmountDesired: 21, quAmountMin: 5970000, assetAmountMin: 20 }, logged: { liquidity: 11042, quAmount: 6000000, assetAmount: 21 } },
  { kind: "add", symbol: "QDOGE", tick: 82948125, pool: pool(1785527320, 84480859, 377528185), call: { amountQu: 4364128, assetAmountDesired: 201754, quAmountMin: 4242807, assetAmountMin: 200745 }, logged: { liquidity: 901594, quAmount: 4264128, assetAmount: 201753 } },
  { kind: "add", symbol: "GARTH", tick: 82941369, pool: pool(9250189968, 960455596, 2948720524), call: { amountQu: 4577576, assetAmountDesired: 465959, quAmountMin: 4455188, assetAmountMin: 463629 }, logged: { liquidity: 1427332, quAmount: 4477576, assetAmount: 464910 } },
] as const;
const REAL_REMOVE = { symbol: "PORTAL", tick: 83077553, pool: pool(6983845359, 57465, 19925900), call: { amountQu: 100000, burnLiquidity: 1268437, quAmountMin: 442352667, assetAmountMin: 3639 }, logged: { quAmount: 444575545, assetAmount: 3658 } };

test("the simulator and predictAdd both reproduce every real AddLiquidity of this epoch exactly", () => {
  for (const r of REAL) {
    const sim = simOf(r.pool);
    fund(sim, r.call.amountQu, { [QSWAP]: r.call.assetAmountDesired });
    const step = addLiquidityStep(ASSET, r.call, 0);
    const res = sim.send(USER, step).result as { userIncreaseLiquidity: bigint; quAmount: bigint; assetAmount: bigint };
    assert.deepEqual(
      { liquidity: Number(res.userIncreaseLiquidity), quAmount: Number(res.quAmount), assetAmount: Number(res.assetAmount) },
      r.logged,
      `${r.symbol} at tick ${r.tick}`,
    );
    const p = predictAdd(r.pool, r.call);
    assert.ok(p.ok);
    assert.deepEqual({ liquidity: p.liquidity, quAmount: p.quUsed, assetAmount: p.assetUsed }, r.logged);
    // The archive shows no refund for these: all of the QU went in (the QU-side path).
    assert.equal(p.refundQu, 0);
    assert.equal(p.path, "qu-side");
    assert.equal(sim.balance(USER), 0n);
  }
});

test("a real QCAP deposit lost 150,186 QU to the token rounding trap, and the planner's call for the same tokens would not have", () => {
  const r = REAL[4];
  const p = predictAdd(r.pool, r.call);
  assert.ok(p.ok && p.path === "qu-side");
  const worth = (21 * r.pool.reserveQu) / r.pool.reserveAsset; // what 21 QCAP were worth in QU at the pool's price
  assert.equal(Math.round(r.logged.quAmount - worth), 150_186);
  // The same 21 tokens planned by QMax with a 5% limit: the token-side path, QU rounded by under 1 QU.
  const plan = planAddLiquidity(addInput({ pool: r.pool, quAmount: 6_000_000, slippageBps: 500 }));
  assert.ok(plan.ok, plan.refusal?.message);
  assert.equal(plan.assetAmount, 21);
  const q = predictAdd(r.pool, plan.call!);
  assert.ok(q.ok && q.path === "token-side");
  assert.ok(q.quUsed <= worth && worth - q.quUsed < 1);
  // With the default 1% limit it is refused, and says what would work.
  const tight = planAddLiquidity(addInput({ pool: r.pool, quAmount: 6_000_000, slippageBps: 100 }));
  assert.equal(tight.refusal?.code, "too-small-for-slippage");
  assert.match(tight.refusal!.message, /at least 101 QCAP/);
  assert.match(tight.refusal!.message, /a limit of 4\.\d\d% would work/);
});

test("the simulator and predictRemove reproduce the real PORTAL removal", () => {
  const sim = simOf(REAL_REMOVE.pool);
  sim.lp.set(USER, { liquidity: 1_268_437n, feeDebtX64: 0n, accumulatedFee: 0n });
  sim.lp.get("OTHERS")!.liquidity -= 1_268_437n;
  sim.qu.set(USER, 100_000n);
  const res = sim.send(USER, removeLiquidityStep({ ...ASSET }, REAL_REMOVE.call)).result as { quAmount: bigint; assetAmount: bigint };
  assert.deepEqual({ quAmount: Number(res.quAmount), assetAmount: Number(res.assetAmount) }, REAL_REMOVE.logged);
  const p = predictRemove(REAL_REMOVE.pool, REAL_REMOVE.call, 1_268_437);
  assert.ok(p.ok);
  assert.deepEqual({ quAmount: p.quOut, assetAmount: p.assetOut }, REAL_REMOVE.logged);
  assert.equal(sim.balance(USER), 444_575_545n); // the fee kept, the QU paid
  assert.equal(sim.possessed(USER, QSWAP), 3658n); // the tokens come back under QSwap management
});

/* =================================================================================================================
 * Bytes: payloads and decoders against what the live contract and the archive returned
 * ================================================================================================================= */

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

test("decodes GetPoolBasicState answers read from the live contract", () => {
  assert.deepEqual(decodePoolState(hexBytes("0100000000000000dcd6016d0100000079e0000000000000b7b01c01000000000000000000000000")), pool(6_123_804_380, 57_465, 18_657_463));
  assert.deepEqual(decodePoolState(hexBytes("01000000000000002e6e0c7300000000d71b0000000000004f613800000000000200000000000000")), pool(1_930_194_478, 7_127, 3_694_927));
  // A missing pool: poolExists 0 and -1 in the amounts (L585-588).
  const missing = new Uint8Array(40);
  const v = new DataView(missing.buffer);
  for (const off of [8, 16, 24]) v.setBigInt64(off, -1n, true);
  assert.deepEqual(decodePoolState(missing), pool(0, 0, 0, false));
  assert.throws(() => decodePoolState(new Uint8Array(0)), /Unexpected GetPoolBasicState/);
});

test("decodes GetLiquidityOf: QSwap's own 1,000 locked units in PORTAL, as the live contract reported them", () => {
  assert.deepEqual(decodeLiquidityOf(hexBytes("e8030000000000003c01000000000000")), { liquidity: 1000, earnedFeesQu: 316 });
  assert.deepEqual(decodeLiquidityOf(new Uint8Array(16)), { liquidity: 0, earnedFeesQu: 0 });
  assert.throws(() => decodeLiquidityOf(new Uint8Array(8)));
});

test("query inputs: 40 bytes for a pool, 72 for a position", () => {
  const q = encodePoolQuery(ISSUER, "QCAP");
  assert.equal(q.length, 40);
  assert.equal(bytesToHex(q.subarray(0, 32)), bytesToHex(identityToBytes(ISSUER)));
  assert.equal(new DataView(q.buffer).getBigUint64(32, true), assetNameToU64("QCAP"));
  const l = encodeLiquidityQuery(ISSUER, "QCAP", "TYNJTYBLIZGGYEHBGORBXYHFYQRAPJCVPKJYENZWICECLYUIWWBDKUYDTQBK");
  assert.equal(l.length, 72);
  assert.equal(bytesToHex(l.subarray(40)), bytesToHex(identityToBytes("TYNJTYBLIZGGYEHBGORBXYHFYQRAPJCVPKJYENZWICECLYUIWWBDKUYDTQBK")));
  assert.equal(QSWAP_FN.poolState, 2);
  assert.equal(QSWAP_FN.liquidityOf, 3);
});

test("step payloads are byte for byte what real wallets sent (an AddLiquidity and a RemoveLiquidity from the archive)", () => {
  const qdoge: AssetRef = { symbol: "QDOGE", issuer: "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE", assetName: "QDOGE" };
  const add = addLiquidityStep(qdoge, { amountQu: 4_364_128, assetAmountDesired: 201_754, quAmountMin: 4_242_807, assetAmountMin: 200_745 }, 0);
  assert.equal(Buffer.from(add.payload).toString("base64"), "BrDwcDzmfU+0yq8Ni4TEEumR61o2TI/+i07nqpaWpTJRRE9HRQAAABoUAwAAAAAAd71AAAAAAAApEAMAAAAAAA==");
  assert.deepEqual(add.to, { contractIndex: 13 });
  assert.equal(add.inputType, 4);
  assert.equal(add.amountQu, 4_364_128);
  const portal: AssetRef = { symbol: "PORTAL", issuer: "IQUGNVFDQSLTXFJSIOPPNPZINSCDQTJVJWGRPWRTFFXMXSJIAASXOBFFBERK", assetName: "PORTAL" };
  const rem = removeLiquidityStep(portal, REAL_REMOVE.call);
  assert.equal(Buffer.from(rem.payload).toString("base64"), "GCNQYTp9ncs92oZnvvLjatrju4njAMqza6igKz3O3bJQT1JUQUwAANVaEwAAAAAAG8RdGgAAAAA3DgAAAAAAAA==");
  assert.equal(rem.inputType, 5);
  assert.equal(rem.amountQu, 100_000);
});

test("decodes the archive's AddLiquidity and RemoveLiquidity events", () => {
  assert.deepEqual(decodeAddLiquidityEvent(b64("sIDhGBAYq/Jp2R/RLXMGWuearj4mBsUxy2MEmL3KGd1RTUlORQAAADVhCQAAAAAAJzhvAgAAAAAPJwAAAAAAAA==")), { liquidity: 614_709, quAmount: 40_843_303, assetAmount: 9_999 });
  assert.deepEqual(decodeRemoveLiquidityEvent(b64("Oa9/GgAAAABKDgAAAAAAAA==")), { quAmount: 444_575_545, assetAmount: 3_658 });
  assert.equal(decodeAddLiquidityEvent(new Uint8Array(10)), null);
});

/* =================================================================================================================
 * predictAdd / predictRemove agree with the simulator on any call, including bad ones
 * ================================================================================================================= */

function randomPool(r: ReturnType<typeof rng>): PoolState {
  const kind = r.int(0, 5);
  if (kind === 0) return pool(r.int(1, 2000), r.int(1, 300), r.int(1000, 5000)); // nearly empty
  if (kind === 1) return pool(r.log(1e3, 1e8), r.log(1, 1e4), r.log(1001, 1e6)); // expensive token, small pool
  if (kind === 2) return pool(r.log(1e8, 1e13), r.log(1e8, 1e13), r.log(1e6, 1e12)); // cheap token, big pool
  const rQu = r.log(1e4, 1e13);
  const rAsset = r.log(1, 1e13);
  const k = Math.sqrt(rQu) * Math.sqrt(rAsset);
  return pool(rQu, rAsset, Math.max(1001, Math.floor(k * Math.exp((r.next() - 0.5) * 6)))); // lopsided, any price
}

test("predictAdd matches the simulator on 4,000 random calls, refusals and refunds included", () => {
  const r = rng(11);
  for (let i = 0; i < 4000; i++) {
    const p = r.next() < 0.05 ? pool(0, 0, 0, r.next() < 0.5) : randomPool(r);
    const amountQu = r.pick([0, 1, 99_999, 100_000, 100_001]) * (r.next() < 0.15 ? 1 : 0) || r.log(100_001, 2e12);
    const aD = r.next() < 0.05 ? r.int(-5, 0) : r.log(1, 1e12);
    const call = { amountQu, assetAmountDesired: aD, quAmountMin: r.next() < 0.03 ? -1 : r.next() < 0.5 ? 0 : r.log(1, 2e12), assetAmountMin: r.next() < 0.03 ? -1 : r.next() < 0.5 ? 0 : r.log(1, 1e12) };
    const held = r.next() < 0.2 ? r.log(1, 1e6) : 1e15;
    const sim = simOf(p);
    sim.qu.set(USER, BigInt(amountQu));
    sim.shares.set(`${USER}|13`, BigInt(held));
    const res = sim.send(USER, addLiquidityStep(ASSET, call, 0)).result as { userIncreaseLiquidity: bigint; quAmount: bigint; assetAmount: bigint };
    const pred = predictAdd(p, call, held);
    const ctx = JSON.stringify({ p, call, held });
    if (pred.ok) {
      assert.equal(Number(res.userIncreaseLiquidity), pred.liquidity, ctx);
      assert.equal(Number(res.quAmount), pred.quUsed, ctx);
      assert.equal(Number(res.assetAmount), pred.assetUsed, ctx);
      assert.equal(Number(sim.balance(USER)), pred.refundQu, ctx);
      assert.equal(sim.feesKept, FEE, ctx);
      assert.deepEqual(sim.state(), pred.poolAfter, ctx);
    } else {
      // Every refusal: the whole attachment back, fee included, nothing else moved.
      assert.equal(res.userIncreaseLiquidity, 0n, ctx);
      assert.equal(Number(sim.balance(USER)), amountQu, ctx);
      assert.equal(sim.feesKept, 0n, ctx);
      assert.equal(sim.possessed(USER, QSWAP), BigInt(held), ctx);
      assert.deepEqual(sim.state(), p.exists ? p : { ...p }, ctx);
    }
  }
});

test("predictRemove matches the simulator on 3,000 random calls; every refusal refunds the fee", () => {
  const r = rng(12);
  for (let i = 0; i < 3000; i++) {
    const p = randomPool(r);
    const mine = r.int(0, Math.max(0, p.totalLiquidity - 1000));
    const sim = simOf(p);
    if (mine > 0) {
      sim.lp.set(USER, { liquidity: BigInt(mine), feeDebtX64: 0n, accumulatedFee: 0n });
      sim.lp.get("OTHERS")!.liquidity -= BigInt(mine);
    }
    const call = {
      amountQu: r.next() < 0.1 ? r.int(0, 100_000) : r.log(100_000, 1e7),
      burnLiquidity: r.next() < 0.05 ? r.int(-3, 0) : r.int(1, Math.max(1, Math.ceil(mine * 1.2))),
      quAmountMin: r.next() < 0.03 ? -1 : r.next() < 0.5 ? 0 : r.log(1, 1e13),
      assetAmountMin: r.next() < 0.03 ? -1 : r.next() < 0.5 ? 0 : r.log(1, 1e13),
    };
    sim.qu.set(USER, BigInt(call.amountQu));
    sim.send(USER, removeLiquidityStep(ASSET, call));
    const pred = predictRemove(p, call, mine);
    const ctx = JSON.stringify({ p, call, mine });
    if (pred.ok) {
      assert.equal(Number(sim.balance(USER)), pred.refundQu + pred.quOut, ctx);
      assert.equal(Number(sim.possessed(USER, QSWAP)), pred.assetOut, ctx);
      assert.deepEqual(sim.state(), pred.poolAfter, ctx);
      assert.equal(sim.feesKept, FEE, ctx);
    } else {
      assert.equal(Number(sim.balance(USER)), call.amountQu, ctx);
      assert.equal(sim.feesKept, 0n, ctx);
      assert.deepEqual(sim.state(), p, ctx);
    }
    sim.assertSolvent();
  }
});

test("the contract trap the planner avoids: RemoveLiquidity keeps the fee and burns liquidity for 0 QU and 0 tokens when the minimums are 0", () => {
  const p = pool(1_930_194_478, 7_127, 3_694_927); // QCAP: one unit is about 0.0019 QCAP and 522 QU
  const sim = simOf(p);
  sim.lp.set(USER, { liquidity: 10n, feeDebtX64: 0n, accumulatedFee: 0n });
  sim.lp.get("OTHERS")!.liquidity -= 10n;
  sim.qu.set(USER, 100_000n);
  sim.send(USER, removeLiquidityStep(ASSET, { amountQu: 100_000, burnLiquidity: 1, quAmountMin: 0, assetAmountMin: 0 }));
  assert.equal(sim.feesKept, FEE);
  assert.equal(sim.balance(USER), 522n); // 100,000 QU paid for 522 QU and no token
  assert.equal(sim.possessed(USER, QSWAP), 0n);
  // The planner refuses that, and a minimum of 1 makes the contract refund instead.
  const plan = planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 10, amount: { units: 1 }, balanceQu: 1e9, slippageBps: 100 });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal?.code, "zero-payout");
  assert.deepEqual(plan.steps, []);
  const guarded = predictRemove(p, { amountQu: 100_000, burnLiquidity: 1, quAmountMin: 1, assetAmountMin: 1 }, 10);
  assert.equal(guarded.ok, false);
  assert.equal(guarded.refundQu, 100_000);
});

/* =================================================================================================================
 * The planner's steps, run through the simulator: the money invariants
 * ================================================================================================================= */

/** Moves the simulated pool's price to about `ratio` times where it is, the way a real trader would: one swap. */
function movePrice(sim: Sim, ratio: number) {
  const p = sim.pool;
  if (ratio > 1) sim.swapQuIn(BigInt(Math.floor(Number(p.rQu) * (Math.sqrt(ratio) - 1) / 0.997)));
  else if (ratio < 1) sim.swapAssetIn(BigInt(Math.floor(Number(p.rAsset) * (1 / Math.sqrt(ratio) - 1) / 0.997)));
}

/** Sets the pool straight to a price (another depositor and traders together could get it anywhere), keeping its size. */
function jumpPrice(sim: Sim, num: bigint, den: bigint) {
  const p = sim.pool;
  // reserveQu / reserveAsset = num / den, as close as integers allow, with reserveAsset kept.
  const rQu = (p.rAsset * num) / den;
  if (rQu < 1n) return;
  sim.qu.set("QSWAP", sim.balance("QSWAP") + (rQu - p.rQu));
  p.rQu = rQu;
}

test("add: 3,000 random pools, wallets and price moves; every invariant holds", () => {
  const r = rng(2026);
  let executed = 0;
  let refusedByContract = 0;
  let quSidePath = 0;
  let withMove = 0;
  let refusedOutside = 0;
  for (let i = 0; i < 3000; i++) {
    const p0 = randomPool(r);
    const slippageBps = r.pick([0, 1, 10, 50, 100, 100, 300, 500, 1000]);
    const price = p0.reserveQu / p0.reserveAsset;
    // Mostly deposits worth more than the fees, as many tokens as a real wallet might add; some anything at all.
    const qu = r.next() < 0.2 ? r.log(1, 1e12) : Math.min(1e13, Math.max(r.log(100_000, 1e10), Math.floor(price * r.log(1, 1e7))));
    // What this deposit needs, worked out with a rich wallet; the real wallet is then drawn around it: short, exact or plenty.
    const probe = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: qu, balanceQu: 1e15, holdings: { [QSWAP]: 1e15 }, slippageBps, transferFeeQu: FEES });
    const needTokens = probe.assetAmount || r.log(1, 1e9);
    const needQu = probe.maxOutlayQu || r.log(1, 1e12);
    const around = (x: number) => r.pick([Math.floor(x * r.next()), x, x + 99, x + 100, x + r.log(1, 1e12)]);
    const split = r.pick([0, 1, r.next()]);
    const tokens = around(needTokens);
    const underQswap = Math.floor(tokens * split);
    const underQx = tokens - underQswap;
    const reserved = r.next() < 0.2 ? r.log(1, 1e9) : 0;
    const balanceQu = around(needQu);
    const holdings = { [QX]: underQx, [QSWAP]: underQswap }; // free: shares in resting asks already left out
    const plan = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: qu, balanceQu, holdings, slippageBps, transferFeeQu: FEES });
    const ctx = () => JSON.stringify({ i, p0, slippageBps, qu, holdings, balanceQu, plan: { ...plan, steps: plan.steps.length } });
    if (!plan.ok) {
      assert.deepEqual(plan.steps, [], ctx());
      assert.equal(plan.call, null);
      assert.ok(plan.refusal && plan.refusal.message.length > 10, ctx());
      continue;
    }
    // The plan itself.
    assert.ok(plan.maxOutlayQu <= balanceQu, ctx());
    assert.equal(plan.maxOutlayQu, plan.steps.reduce((s, x) => s + x.amountQu, 0));
    assert.ok(plan.minQu <= plan.expectedQu && plan.expectedQu <= plan.maxQu, ctx());
    assert.ok(plan.assetAmount >= 1 && plan.expectedLiquidity >= 1, ctx());
    assert.equal(plan.call!.assetAmountDesired, plan.assetAmount);
    assert.equal(plan.call!.assetAmountMin, plan.assetAmount);
    // The limits never allow more than the chosen slippage (QU per token, as rationals: QU x 10,000 x reserveAsset vs tokens x reserveQu x (10,000 +- s)).
    const A = BigInt(plan.assetAmount);
    const rQ0 = BigInt(p0.reserveQu);
    const rA0 = BigInt(p0.reserveAsset);
    const s = BigInt(slippageBps);
    assert.ok(BigInt(plan.maxQu) * 10_000n * rA0 <= A * rQ0 * (10_000n + s), ctx());
    assert.ok(BigInt(plan.minQu) * 10_000n * rA0 <= A * rQ0 * (10_000n - s) && (BigInt(plan.minQu) + 1n) * 10_000n * rA0 > A * rQ0 * (10_000n - s), ctx());
    if (plan.moveQty) withMove++;

    // The world: the wallet as described, the pool, then (often) a price move before the steps land.
    const sim = simOf(p0);
    fund(sim, balanceQu, holdings, reserved);
    const tokens0 = sim.tokens(USER);
    const qu0 = sim.balance(USER);
    const move = r.next();
    let edge = "";
    if (move < 0.35) {
      // nothing moves
    } else if (move < 0.7) movePrice(sim, Math.exp((r.next() - 0.5) * 0.25)); // up to about +-12%
    else if (move < 0.8) sim.othersJoin(r.next());
    else {
      // Exactly on, or one QU past, each edge of the limits.
      const e = r.int(0, 5);
      edge = ["at max", "past max", "at min", "under min", "at qu-side start", "in qu-side band"][e];
      const maxQ = BigInt(plan.maxQu);
      const minQ = BigInt(plan.minQu);
      if (e === 0) jumpPrice(sim, maxQ, A);
      if (e === 1) jumpPrice(sim, maxQ * 1000n + 1n, A * 1000n);
      if (e === 2) jumpPrice(sim, minQ, A);
      if (e === 3) jumpPrice(sim, minQ * 1000n - 1n, A * 1000n);
      if (e === 4) jumpPrice(sim, maxQ, A + 1n);
      if (e === 5) jumpPrice(sim, maxQ * 2n + 1n, A * 2n + 1n);
    }
    const p1 = sim.state();
    const rQ1 = BigInt(p1.reserveQu);
    const rA1 = BigInt(p1.reserveAsset);
    const check = recheckAdd(plan, p1);
    const liq0 = sim.liquidityOf(USER);
    run(sim, plan.steps);

    // No step ever attached more QU than the wallet held at that moment.
    for (const a of sim.attachments) assert.ok(a.amount <= a.balance, ctx());
    const dQu = sim.balance(USER) - qu0;
    const dTokens = sim.tokens(USER) - tokens0;
    const minted = sim.liquidityOf(USER) - liq0;
    // A share move, if any, cost nothing (QX refunds it) and only changed which contract manages the shares.
    if (minted === 0n) {
      refusedByContract++;
      // Refused: everything came back, the 100,000 QU fee included. The only trace is the share move, if one was made.
      assert.equal(dQu, 0n, ctx() + edge);
      assert.equal(dTokens, 0n, ctx());
      assert.equal(sim.feesKept, 0n, ctx());
      assert.equal(check.ok, false, `recheck said ok but the contract refused: ${ctx()}`);
      // The contract refused for a reason the limits name: the price left [minQu / tokens, maxQu / tokens], or the pool
      // changed so that the deposit would mint nothing. Never because the planned tokens or QU were missing.
      const outside = A * rQ1 > BigInt(plan.maxQu) * rA1 || A * rQ1 < BigInt(plan.minQu) * rA1;
      const why = predictAdd(p1, plan.call!);
      assert.ok(outside || (!why.ok && why.code === "zero-liquidity"), `refused inside the limits: ${ctx()} ${edge} ${JSON.stringify(why)}`);
      if (outside) refusedOutside++;
      continue;
    }
    executed++;
    assert.equal(check.ok, true, `recheck refused but the contract accepted: ${ctx()} ${edge}`);
    const quUsed = -dQu - FEE;
    // Exactly the reviewed tokens; QU between the reviewed min and max; the fee kept once; the move fee refunded.
    assert.equal(dTokens, -A, ctx());
    assert.ok(quUsed >= BigInt(plan.minQu) && quUsed <= BigInt(plan.maxQu), ctx());
    assert.equal(sim.feesKept, FEE, ctx());
    // Only executed inside the limits: maxQu / A >= price >= minQu / A at execution.
    assert.ok(A * rQ1 <= BigInt(plan.maxQu) * rA1 && A * rQ1 >= BigInt(plan.minQu) * rA1, ctx() + edge);
    if (move < 0.35) {
      // Unmoved: exactly what the plan said, and every promised refund arrived.
      assert.equal(quUsed, BigInt(plan.expectedQu), ctx());
      assert.equal(Number(minted), plan.expectedLiquidity, ctx());
      assert.equal(Number(sim.balance(USER)), balanceQu - plan.expectedSpendQu, ctx());
    }
    // The QU-side path can only happen above the planned price (the price rose, inside the limit).
    const viaQuSide = (BigInt(plan.maxQu) * rA1) / rQ1 === A;
    // The re-check flags exactly the cases where the contract took the QU-side path (the modal stops on it).
    assert.equal(check.ok && check.quSide === true, viaQuSide, `quSide flag: ${ctx()} ${edge}`);
    if (viaQuSide) {
      quSidePath++;
      assert.ok(rQ1 * rA0 > rQ0 * rA1, `QU-side path at or below the planned price: ${ctx()} ${edge}`);
      assert.equal(quUsed, BigInt(plan.maxQu));
    }
    // What the deposit lost against the liquidity it got, at the pool's price right after: at most the planned worst case,
    // plus a fraction of one liquidity unit and a QU.
    const st = sim.state();
    const priceAfter = st.reserveQu / st.reserveAsset;
    const deposit = Number(quUsed) + plan.assetAmount * priceAfter;
    const value = (2 * Number(minted) * st.reserveQu) / st.totalLiquidity;
    const unit = (2 * st.reserveQu) / st.totalLiquidity;
    assert.ok(deposit - value <= Math.max(plan.worstRoundingQu, 1) + unit + 2 + deposit * 1e-9, `lost ${deposit - value}: ${ctx()} ${edge}`);
    sim.assertSolvent();
  }
  // The random worlds really exercised every path.
  assert.ok(executed > 600, `executed ${executed}`);
  assert.ok(refusedByContract > 100, `refused ${refusedByContract}`);
  assert.ok(quSidePath > 10, `qu-side ${quSidePath}`);
  assert.ok(withMove > 100, `moves ${withMove}`);
  assert.ok(refusedOutside > 50, `refused outside the limits ${refusedOutside}`);
  if (process.env.LIQUIDITY_TEST_COUNTS) console.log({ executed, refusedByContract, refusedOutside, quSidePath, withMove });
});

test("a price move past the limit either way is refused by the contract and refunds everything, the fee included", () => {
  const r = rng(7);
  let checked = 0;
  for (let i = 0; i < 800; i++) {
    const p0 = randomPool(r);
    const slippageBps = r.pick([50, 100, 300, 1000]);
    const plan = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: Math.floor((p0.reserveQu / p0.reserveAsset) * r.log(100, 1e7)) + 1, balanceQu: 1e15, holdings: { [QSWAP]: 1e14 }, slippageBps, transferFeeQu: FEES });
    if (!plan.ok) continue;
    const s = slippageBps / 10_000;
    for (const ratio of [1 + s * 1.05 + 0.001, 1 + 2 * s, 1 - s * 1.05 - 0.001, 1 - 2 * s]) {
      const sim = simOf(p0);
      fund(sim, 1e15, { [QSWAP]: 1e14 });
      // Straight to the new price so the move is exactly past the limit (a swap would add its own rounding).
      jumpPrice(sim, BigInt(Math.round(p0.reserveQu * ratio * 1e6)), BigInt(p0.reserveAsset) * 1_000_000n);
      const moved = sim.state().reserveQu / sim.state().reserveAsset / (p0.reserveQu / p0.reserveAsset);
      if (Math.abs(moved - 1) <= s + 1 / plan.assetAmount) continue; // integer pools cannot always land past the edge
      const before = sim.balance(USER);
      assert.equal(recheckAdd(plan, sim.state()).ok, false);
      run(sim, plan.steps);
      assert.equal(sim.balance(USER), before, JSON.stringify({ p0, ratio, plan: plan.call }));
      assert.equal(sim.feesKept, 0n);
      assert.equal(sim.liquidityOf(USER), 0n);
      checked++;
    }
  }
  assert.ok(checked > 400, `checked ${checked}`);
});

test("add then remove gives back at most what went in, and the round trip costs the two flat fees", () => {
  const r = rng(99);
  let n = 0;
  for (let i = 0; i < 1500 && n < 800; i++) {
    const p0 = randomPool(r);
    const plan = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: Math.floor((p0.reserveQu / p0.reserveAsset) * r.log(200, 1e8)) + 1, balanceQu: 1e15, holdings: { [QX]: 1e14 }, slippageBps: r.pick([100, 300, 1000]), transferFeeQu: FEES });
    if (!plan.ok) continue;
    const sim = simOf(p0);
    fund(sim, 1e15, { [QX]: 1e14 });
    const qu0 = sim.balance(USER);
    const tokens0 = sim.tokens(USER);
    run(sim, plan.steps);
    const mine = Number(sim.liquidityOf(USER));
    assert.equal(mine, plan.expectedLiquidity);
    // Others trade in between half of the time.
    const traded = r.next() < 0.5;
    if (traded) for (let k = 0; k < 4; k++) movePrice(sim, Math.exp((r.next() - 0.5) * 0.2));
    const rem = planRemoveLiquidity({ asset: ASSET, pool: sim.state(), liquidity: mine, amount: { percent: 100 }, balanceQu: Number(sim.balance(USER)), slippageBps: 100 });
    if (!rem.ok) {
      // Only refused when it would not pay (a dust position after trading, say); never silently.
      assert.ok(["zero-payout", "fees-exceed-removal"].includes(rem.refusal!.code), rem.refusal!.message);
      continue;
    }
    const earned = sim.earnedFees(USER);
    run(sim, rem.steps);
    n++;
    assert.equal(sim.liquidityOf(USER), 0n);
    const dQu = sim.balance(USER) - qu0;
    const dTokens = sim.tokens(USER) - tokens0;
    // The tokens came back under QSwap management.
    assert.ok(sim.possessed(USER, QSWAP) >= BigInt(rem.expectedAsset));
    assert.equal(sim.feesKept, 2n * FEE);
    if (!traded) {
      // Nothing happened in between: each side back at most what went in, and the wallet is down at least the two fees.
      assert.ok(BigInt(rem.expectedQu) <= BigInt(plan.expectedQu));
      assert.ok(dTokens <= 0n && -dTokens <= BigInt(plan.assetAmount));
      assert.ok(dQu <= -2n * FEE);
      assert.equal(dQu, BigInt(rem.expectedQu - plan.expectedQu) - 2n * FEE);
    } else {
      // Others traded: at the final pool price, the position is worth at most holding what went in plus its share of the fees.
      const st = sim.state();
      const price = st.reserveQu / st.reserveAsset;
      const out = rem.expectedQu + rem.expectedAsset * price;
      const held = plan.expectedQu + plan.assetAmount * price;
      // Others traded: at the final pool price, the position is worth at most holding what went in, plus the fees it earned.
      // A fee stays in the pool, so one earned at price p is worth up to sqrt(final / p) times as much at the end; and each
      // swap rounds in the pool's favour (by under one token and one QU), which earnedFees does not count.
      const growth = Math.max(1, ...sim.swapPrices.map((p) => Math.sqrt(price / p)));
      assert.ok(out <= held + Number(earned) * growth * 1.001 + 5 * (price + 2), JSON.stringify({ out, held, earned: Number(earned), price, growth }));
    }
  }
  assert.ok(n > 300, `round trips ${n}`);
});

test("remove: 2,000 random positions and price moves; it pays what it says, minimums protect, refusals cost nothing", () => {
  const r = rng(4242);
  let done = 0;
  let refused = 0;
  for (let i = 0; i < 2000; i++) {
    const p0 = randomPool(r);
    const mine = r.int(1, Math.max(1, p0.totalLiquidity - 1000));
    if (mine > p0.totalLiquidity - 1000) continue;
    const amount = r.next() < 0.5 ? { percent: r.pick([25, 50, 75, 100]) } : { units: r.int(1, mine) };
    const balanceQu = r.next() < 0.1 ? r.int(0, 99_999) : r.log(100_000, 1e9);
    const slippageBps = r.pick([0, 50, 100, 300, 1000]);
    const plan = planRemoveLiquidity({ asset: ASSET, pool: p0, liquidity: mine, amount, balanceQu, slippageBps });
    const ctx = () => JSON.stringify({ p0, mine, amount, balanceQu, slippageBps, plan: { ...plan, steps: plan.steps.length } });
    if (!plan.ok) {
      assert.deepEqual(plan.steps, []);
      if (balanceQu < 100_000 && plan.refusal!.code === "fee-unaffordable") assert.match(plan.refusal!.message, /100,000 QU/);
      continue;
    }
    assert.ok(balanceQu >= 100_000, ctx());
    assert.ok(plan.burnLiquidity >= 1 && plan.burnLiquidity <= plan.requestedLiquidity && plan.requestedLiquidity <= mine, ctx());
    assert.ok(plan.expectedQu >= 1 && (plan.expectedAsset >= 1 || plan.all), ctx());
    assert.ok(plan.minQu >= 1 && plan.minQu <= plan.expectedQu && plan.minAsset <= plan.expectedAsset, ctx());
    if (plan.expectedAsset >= 1) assert.ok(plan.minAsset >= 1, ctx());
    if (plan.burnLiquidity < plan.requestedLiquidity) {
      // The smaller burn pays the same whole tokens: nothing lost by burning less.
      const full = predictRemove(p0, { ...plan.call!, burnLiquidity: plan.requestedLiquidity, quAmountMin: 0, assetAmountMin: 0 }, mine);
      assert.ok(full.ok && full.assetOut === plan.expectedAsset, ctx());
    }
    const sim = simOf(p0);
    sim.lp.set(USER, { liquidity: BigInt(mine), feeDebtX64: 0n, accumulatedFee: 0n });
    sim.lp.get("OTHERS")!.liquidity -= BigInt(mine);
    sim.qu.set(USER, BigInt(balanceQu));
    const moved = r.next() < 0.5;
    if (moved) movePrice(sim, Math.exp((r.next() - 0.5) * 0.3));
    const p1 = sim.state();
    const check = recheckRemove(plan, p1, mine);
    run(sim, plan.steps);
    for (const a of sim.attachments) assert.ok(a.amount <= a.balance);
    const dQu = Number(sim.balance(USER)) - balanceQu;
    const got = Number(sim.possessed(USER, QSWAP));
    if (sim.liquidityOf(USER) === BigInt(mine)) {
      refused++;
      assert.equal(dQu, 0, ctx()); // the fee came back
      assert.equal(got, 0);
      assert.equal(check.ok, false, ctx());
      continue;
    }
    done++;
    assert.equal(check.ok, true, ctx());
    assert.equal(sim.liquidityOf(USER), BigInt(mine - plan.burnLiquidity));
    assert.ok(dQu + 100_000 >= plan.minQu && got >= plan.minAsset, ctx());
    // Nothing kept for nothing: the fee was kept only with QU (and tokens, unless the whole position held under one) paid out.
    assert.ok(dQu + 100_000 >= 1 && (got >= 1 || plan.all), ctx());
    if (!moved) {
      assert.equal(dQu, plan.netQu, ctx());
      assert.equal(got, plan.expectedAsset, ctx());
    }
    sim.assertSolvent();
  }
  assert.ok(done > 300 && refused > 20, `done ${done}, refused ${refused}`);
});

test("shares under QX: the move goes first; if the move fails (shares tied up in an ask), the deposit is refunded in full", () => {
  const p0 = pool(1_000_000_000, 10_000_000, 100_000_000); // 100 QU per token
  const plan = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: 50_000_000, balanceQu: 1e9, holdings: { [QX]: 600_000, [QSWAP]: 200_000 }, slippageBps: 100, transferFeeQu: FEES });
  assert.ok(plan.ok, plan.refusal?.message);
  assert.equal(plan.assetAmount, 500_000);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "add-liquidity"]);
  assert.equal(plan.moveQty, 300_000); // only the shortfall
  assert.deepEqual(plan.steps[0].to, { contractIndex: QX }); // called on the contract that manages them now
  assert.equal(plan.steps[0].inputType, 9);
  assert.equal(plan.moveAttachQu, 100);
  assert.equal(plan.maxOutlayQu, 100 + plan.maxQu + 100_000);

  // It works: the move is free, the deposit takes exactly the tokens.
  const ok = simOf(p0);
  fund(ok, 1e9, { [QX]: 600_000, [QSWAP]: 200_000 });
  run(ok, plan.steps);
  assert.equal(ok.balance(USER), BigInt(1e9 - plan.expectedQu - 100_000));
  assert.equal(ok.possessed(USER, QX), 300_000n);
  assert.equal(ok.possessed(USER, QSWAP), 0n);

  // The caller forgot the shares in a resting QX ask: QX moves nothing (and refunds), and AddLiquidity refunds everything.
  const stuck = simOf(p0);
  fund(stuck, 1e9, { [QX]: 600_000, [QSWAP]: 200_000 }, 0);
  stuck.reservedInAsks.set(USER, 500_000n);
  const [moveRes, addRes] = run(stuck, plan.steps);
  assert.equal(moveRes.result, 0n);
  assert.equal((addRes.result as { userIncreaseLiquidity: bigint }).userIncreaseLiquidity, 0n);
  assert.equal(stuck.balance(USER), BigInt(1e9));
  assert.equal(stuck.tokens(USER), 800_000n);
  assert.equal(stuck.feesKept, 0n);
});

test("the move done but AddLiquidity refused (price moved): no QU lost, the shares simply stay under QSwap", () => {
  const p0 = pool(1_000_000_000, 10_000_000, 100_000_000);
  const plan = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: 50_000_000, balanceQu: 1e9, holdings: { [QX]: 600_000 }, slippageBps: 100, transferFeeQu: FEES });
  const sim = simOf(p0);
  fund(sim, 1e9, { [QX]: 600_000 });
  sim.send(USER, plan.steps[0]);
  movePrice(sim, 1.05);
  assert.equal(recheckAdd(plan, sim.state()).ok, false);
  sim.send(USER, plan.steps[1]);
  assert.equal(sim.balance(USER), BigInt(1e9));
  assert.equal(sim.possessed(USER, QSWAP), 500_000n);
  assert.equal(sim.possessed(USER, QX), 100_000n);
  // Moving them back to QX later costs QX's 100 QU transfer fee.
  const back = sim.send(USER, { to: { contractIndex: QSWAP }, inputType: 11, amountQu: 100, payload: (() => {
    const b = new Uint8Array(52);
    const v = new DataView(b.buffer);
    b.set(identityToBytes(ISSUER), 0);
    v.setBigUint64(32, assetNameToU64("QCAP"), true);
    v.setBigInt64(40, 500_000n, true);
    v.setUint32(48, QX, true);
    return b;
  })() });
  assert.equal(back.result, 500_000n);
  assert.equal(sim.balance(USER), BigInt(1e9 - 100));
});

/* =================================================================================================================
 * Refusals, one by one
 * ================================================================================================================= */

test("refuses a missing pool, an empty pool and a pool empty on one side, with no steps", () => {
  for (const [p, code] of [
    [pool(0, 0, 0, false), "no-pool"],
    [pool(0, 0, 0), "empty-pool"],
    [pool(0, 5_000, 2_000), "pool-one-sided"],
    [pool(5_000_000, 0, 2_000), "pool-one-sided"],
  ] as const) {
    const plan = planAddLiquidity(addInput({ pool: p }));
    assert.equal(plan.refusal?.code, code);
    assert.deepEqual(plan.steps, []);
    const rem = planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 10, amount: { percent: 100 }, balanceQu: 1e9, slippageBps: 100 });
    assert.equal(rem.ok, false);
    assert.deepEqual(rem.steps, []);
  }
  assert.match(planAddLiquidity(addInput({ pool: pool(0, 0, 0) })).refusal!.message, /first deposit/i);
});

test("refuses less than one token's worth, and deposits the flat fees would swallow", () => {
  const p = pool(1_930_194_478, 7_127, 3_694_927); // about 270,828 QU per QCAP
  const tiny = planAddLiquidity(addInput({ pool: p, quAmount: 200_000 }));
  assert.equal(tiny.refusal?.code, "too-small");
  assert.match(tiny.refusal!.message, /at least 1 QCAP/);
  const cheap = pool(1_000_000_000, 1_000_000_000, 1_000_000_000); // 1 QU per token
  const fees = planAddLiquidity(addInput({ pool: cheap, quAmount: 90_000 }));
  assert.equal(fees.refusal?.code, "fees-exceed-deposit");
  assert.match(fees.refusal!.message, /100,000 QU each/);
  const ok = planAddLiquidity(addInput({ pool: cheap, quAmount: 1_000_000 }));
  assert.ok(ok.ok);
  assert.ok(ok.warnings.some((w) => /cost 100,000 QU each/.test(w))); // 200,000 QU is 10% of a 2,000,000 QU deposit
});

test("refuses a deposit whose slippage room is under one token, and a 0% limit; says what would work", () => {
  const p = pool(6_123_804_380, 57_465, 18_657_463); // PORTAL, about 106,566 QU each
  assert.equal(minTokensForSlippage(p, 100), 101);
  assert.equal(minTokensForSlippage(p, 0), null);
  const portal: AssetRef = { symbol: "PORTAL", issuer: "IQUGNVFDQSLTXFJSIOPPNPZINSCDQTJVJWGRPWRTFFXMXSJIAASXOBFFBERK", assetName: "PORTAL" };
  const small = planAddLiquidity(addInput({ asset: portal, pool: p, quAmount: 2_000_000, holdings: { [QSWAP]: 1000 } }));
  assert.equal(small.refusal?.code, "too-small-for-slippage");
  assert.match(small.refusal!.message, /One PORTAL is worth about 106,566 QU/);
  assert.match(small.refusal!.message, /at least 101 PORTAL \(about 10,763,148 QU\)/);
  assert.match(small.refusal!.message, /a limit of 5\.56% would work/);
  const room = minSlippageBpsFor(p, 18)!;
  assert.ok(room > 500 && room <= 600, String(room));
  assert.ok(planAddLiquidity(addInput({ pool: p, quAmount: 2_000_000, holdings: { [QSWAP]: 1000 }, slippageBps: room })).ok);
  assert.equal(planAddLiquidity(addInput({ pool: p, quAmount: 2_000_000, holdings: { [QSWAP]: 1000 }, slippageBps: room - 1 })).ok, false);
  const zero = planAddLiquidity(addInput({ pool: p, quAmount: 100_000_000, holdings: { [QSWAP]: 1000 }, slippageBps: 0 }));
  assert.equal(zero.refusal?.code, "too-small-for-slippage");
  assert.match(zero.refusal!.message, /cannot be 0%/);
  // A cheap token needs only a little: the room must also cover the QU lost to rounding the maximum down.
  const qtc = pool(514_332_277, 7_232_459_178, 1_896_096_398);
  const need = minTokensForSlippage(qtc, 100)!;
  assert.ok(need > 100 && need < 2000, String(need));
});

test("refuses a deposit too small to mint one liquidity unit, and one mostly lost to rounding", () => {
  // Each unit is worth 2,000,000 QU here: a 1,500,000 QU-side deposit cannot earn one.
  const p = pool(1_000_000_000_000, 1_000_000_000, 1_000_000);
  const z = planAddLiquidity(addInput({ pool: p, quAmount: 600_000, slippageBps: 1000 }));
  assert.equal(z.refusal?.code, "zero-liquidity");
  assert.equal(predictAdd(p, { amountQu: 700_000, assetAmountDesired: 600, quAmountMin: 0, assetAmountMin: 600 }).ok, false);
  // 31,500,000 QU earns 31.5 units, rounded down to 31: half a unit (1,000,000 QU) of a 63,000,000 QU deposit is lost.
  const r = planAddLiquidity(addInput({ pool: p, quAmount: 31_500_000, slippageBps: 1000 }));
  assert.equal(r.refusal?.code, "rounding");
  assert.match(r.refusal!.message, /lost to rounding/);
});

test("refuses when the wallet lacks QU or tokens, counting only shares QX or QSwap manage", () => {
  const p = pool(1_000_000_000, 10_000_000, 100_000_000);
  const noQu = planAddLiquidity(addInput({ pool: p, quAmount: 50_000_000, balanceQu: 50_000_000 }));
  assert.equal(noQu.refusal?.code, "insufficient-qu");
  assert.match(noQu.refusal!.message, /up to 50,600,000 QU/);
  const noTokens = planAddLiquidity(addInput({ pool: p, quAmount: 50_000_000, holdings: { [QX]: 100, [QSWAP]: 100, 5: 1_000_000 } }));
  assert.equal(noTokens.refusal?.code, "insufficient-asset");
  assert.match(noTokens.refusal!.message, /needs 500,000 QCAP; the wallet has 200 QCAP/);
  // The share move's 100 QU counts: exactly enough without it is not enough with it.
  const plan = planAddLiquidity(addInput({ pool: p, quAmount: 50_000_000, holdings: { [QX]: 1e9 } }));
  assert.equal(planAddLiquidity(addInput({ pool: p, quAmount: 50_000_000, holdings: { [QX]: 1e9 }, balanceQu: plan.maxOutlayQu - 1 })).refusal?.code, "insufficient-qu");
  assert.ok(planAddLiquidity(addInput({ pool: p, quAmount: 50_000_000, holdings: { [QX]: 1e9 }, balanceQu: plan.maxOutlayQu })).ok);
});

test("refuses bad input", () => {
  for (const over of [{ quAmount: 0 }, { quAmount: -5 }, { quAmount: 1.5 }, { slippageBps: 1001 }, { slippageBps: -1 }, { balanceQu: Number.NaN }] as Partial<AddPlanInput>[])
    assert.equal(planAddLiquidity(addInput(over)).refusal?.code, "bad-input", JSON.stringify(over));
  const p = pool(1_000_000_000, 10_000_000, 100_000_000);
  for (const amount of [{ percent: 0 }, { percent: 101 }, { units: 0 }, { units: 1.5 }])
    assert.equal(planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 1000, amount, balanceQu: 1e9, slippageBps: 100 }).refusal?.code, "bad-input", JSON.stringify(amount));
});

test("remove: refuses more than owned, no position, an unaffordable fee and a removal worth less than the fee", () => {
  const p = pool(1_000_000_000, 10_000_000, 100_000_000); // one unit: 10 QU + 0.1 token
  const base = { asset: ASSET, pool: p, balanceQu: 1e9, slippageBps: 100 };
  assert.equal(planRemoveLiquidity({ ...base, liquidity: 5_000, amount: { units: 5_001 } }).refusal?.code, "more-than-owned");
  assert.equal(planRemoveLiquidity({ ...base, liquidity: 0, amount: { percent: 100 } }).refusal?.code, "no-position");
  assert.equal(planRemoveLiquidity({ ...base, liquidity: 50_000, amount: { percent: 100 }, balanceQu: 99_999 }).refusal?.code, "fee-unaffordable");
  const small = planRemoveLiquidity({ ...base, liquidity: 4_000, amount: { percent: 100 } });
  assert.equal(small.refusal?.code, "fees-exceed-removal");
  assert.match(small.refusal!.message, /keeps earning fees/);
  const ok = planRemoveLiquidity({ ...base, liquidity: 50_000, amount: { percent: 50 } });
  assert.ok(ok.ok);
  assert.equal(ok.expectedQu, 250_000);
  assert.equal(ok.expectedAsset, 2_500);
  assert.equal(ok.netQu, 150_000);
  assert.equal(ok.maxOutlayQu, 100_000);
  assert.ok(ok.warnings.some((w) => /managed by QSwap/.test(w)));
});

test("remove: burns less when that pays the same whole tokens, and refuses a part that would pay no token", () => {
  const p = pool(6_123_804_380, 57_465, 18_657_463); // PORTAL: about 325 units per token
  const plan = planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 1_001_000, amount: { percent: 25 }, balanceQu: 1e9, slippageBps: 100 });
  assert.ok(plan.ok);
  assert.equal(plan.requestedLiquidity, 250_250); // 770.77 tokens' worth: QSwap would pay 770 and keep the 0.77
  assert.equal(plan.expectedAsset, 770);
  assert.equal(plan.burnLiquidity, 250_000); // the least liquidity that still pays 770
  assert.equal(predictRemove(p, { amountQu: 100_000, burnLiquidity: 250_250, quAmountMin: 0, assetAmountMin: 0 }, 1_001_000).ok && 770, 770);
  assert.ok(plan.roundingLossQu < 400, String(plan.roundingLossQu));
  assert.ok(plan.warnings.some((w) => /stay in your position/.test(w)));
  const none = planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 1_000_000, amount: { units: 300 }, balanceQu: 1e9, slippageBps: 100 });
  assert.equal(none.refusal?.code, "zero-payout");
  assert.match(none.refusal!.message, /at least 325 units/);
  // A whole position under one token is allowed (the fraction is lost either way) with a plain warning and a 0 token minimum.
  const dust = planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 320, amount: { percent: 100 }, balanceQu: 1e9, slippageBps: 100 });
  assert.ok(dust.ok, dust.refusal?.message);
  assert.equal(dust.expectedAsset, 0);
  assert.equal(dust.minAsset, 0);
  assert.ok(dust.minQu >= 1);
  assert.ok(dust.warnings.some((w) => /less than one QCAP/.test(w)));
});

test("re-check before signing: the same plan passes inside the limits and is refused past them, never changed", () => {
  const p0 = pool(1_000_000_000, 10_000_000, 100_000_000);
  const plan = planAddLiquidity(addInput({ pool: p0, quAmount: 50_000_000 }));
  const call = JSON.stringify(plan.call);
  assert.deepEqual(recheckAdd(plan, p0), { ok: true, warnings: [], quSide: false });
  const up = recheckAdd(plan, pool(1_005_000_000, 10_000_000, 100_000_000));
  assert.ok(up.ok);
  const away = recheckAdd(plan, pool(1_020_000_000, 10_000_000, 100_000_000));
  assert.equal(away.ok, false);
  assert.match((away as { reason: string }).reason, /moved 2\.00%.*past your 1\.00% limit/);
  assert.equal(recheckAdd(plan, pool(980_000_000, 10_000_000, 100_000_000)).ok, false);
  assert.equal(recheckAdd(plan, pool(0, 0, 0, false)).ok, false);
  assert.equal(JSON.stringify(plan.call), call);
  const refused = planAddLiquidity(addInput({ pool: p0, quAmount: 0 }));
  assert.equal(recheckAdd(refused, p0).ok, false);

  const rem = planRemoveLiquidity({ asset: ASSET, pool: p0, liquidity: 50_000, amount: { percent: 50 }, balanceQu: 1e9, slippageBps: 100 });
  assert.ok(recheckRemove(rem, p0, 50_000).ok);
  assert.equal(recheckRemove(rem, p0, 20_000).ok, false);
  assert.equal(recheckRemove(rem, pool(1_100_000_000, 9_100_000, 100_000_000), 50_000).ok, false);
});

test("maxAddQu: the largest deposit the wallet can make, fees and the share move included", () => {
  const p = pool(1_000_000_000, 10_000_000, 100_000_000);
  const base = { asset: ASSET, pool: p, slippageBps: 100, transferFeeQu: FEES };
  // Limited by QU.
  const byQu = maxAddQu({ ...base, balanceQu: 10_000_000, holdings: { [QX]: 1e9 } })!;
  const plan = planAddLiquidity({ ...base, balanceQu: 10_000_000, holdings: { [QX]: 1e9 }, quAmount: byQu });
  assert.ok(plan.ok);
  assert.ok(plan.maxOutlayQu <= 10_000_000 && plan.maxOutlayQu > 10_000_000 - 300);
  assert.equal(planAddLiquidity({ ...base, balanceQu: 10_000_000, holdings: { [QX]: 1e9 }, quAmount: byQu + 200 }).ok, false);
  // Limited by tokens.
  const byTokens = maxAddQu({ ...base, balanceQu: 1e12, holdings: { [QSWAP]: 30_000 } })!;
  assert.equal(planAddLiquidity({ ...base, balanceQu: 1e12, holdings: { [QSWAP]: 30_000 }, quAmount: byTokens }).assetAmount, 30_000);
  // Nothing fits.
  assert.equal(maxAddQu({ ...base, balanceQu: 100_000, holdings: { [QX]: 1e9 } }), null);
  assert.equal(maxAddQu({ ...base, balanceQu: 1e12, holdings: {} }), null);
});

test("positionValue: share over all units (the locked 1,000 included), rounded down like a removal", () => {
  const p = pool(6_123_804_380, 57_465, 18_657_463);
  const v = positionValue(p, 1_000);
  assert.equal(v.quOut, Math.floor((1_000 * 6_123_804_380) / 18_657_463));
  assert.equal(v.quOut, 328_222);
  assert.equal(v.assetOut, 3);
  assert.ok(Math.abs(v.sharePct - 0.0053597) < 1e-6);
  assert.equal(v.valueQu, Math.floor(328_222 + (3 * 6_123_804_380) / 57_465));
  assert.deepEqual(positionValue(p, 0), { sharePct: 0, quOut: 0, assetOut: 0, valueQu: 0 });
});

/* =================================================================================================================
 * Routes
 * ================================================================================================================= */

const WALLET = "TYNJTYBLIZGGYEHBGORBXYHFYQRAPJCVPKJYENZWICECLYUIWWBDKUYDTQBK";

function fakeDeps(opts: { liquidity?: Record<string, number>; failPool?: string } = {}) {
  const pools = [
    { id: "QCAP", symbol: "QCAP", issuer: ISSUER, assetName: "QCAP" },
    { id: "PORTAL", symbol: "PORTAL", issuer: "IQUGNVFDQSLTXFJSIOPPNPZINSCDQTJVJWGRPWRTFFXMXSJIAASXOBFFBERK", assetName: "PORTAL" },
    { id: "QDOGE", symbol: "QDOGE", issuer: "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE", assetName: "QDOGE" },
  ];
  const states: Record<string, PoolState> = { QCAP: pool(1_930_194_478, 7_127, 3_694_927), PORTAL: pool(6_123_804_380, 57_465, 18_657_463), QDOGE: pool(1_801_152_230, 84_163_133, 378_429_779) };
  const calls: { fn: number; at: number; asset: string }[] = [];
  const nameOf = (input: Uint8Array) => pools.find((p) => new DataView(input.buffer, input.byteOffset).getBigUint64(32, true) === assetNameToU64(p.assetName))!.id;
  const deps: LiquidityDeps = {
    pools: () => pools,
    query: async (contract, fn, input) => {
      assert.equal(contract, 13);
      const asset = nameOf(input);
      calls.push({ fn, at: Date.now(), asset });
      if (asset === opts.failPool) throw new Error("RPC 500");
      const out = new Uint8Array(fn === 2 ? 40 : 16);
      const v = new DataView(out.buffer);
      if (fn === 2) {
        const s = states[asset];
        v.setBigInt64(0, 1n, true);
        v.setBigInt64(8, BigInt(s.reserveQu), true);
        v.setBigInt64(16, BigInt(s.reserveAsset), true);
        v.setBigInt64(24, BigInt(s.totalLiquidity), true);
      } else {
        v.setBigInt64(0, BigInt(opts.liquidity?.[asset] ?? 0), true);
        v.setBigUint64(8, 157n, true);
      }
      return out;
    },
  };
  return { deps, calls };
}
const handler = (routes: ReturnType<typeof liquidityRoutes>, path: string) => routes.find((r) => r.path === path)!.handler;
const get = (routes: ReturnType<typeof liquidityRoutes>, path: string, q: Record<string, string>) => handler(routes, path)({ query: new URLSearchParams(q), body: null });

test("GET /v1/liquidity/positions: every pool with liquidity, valued with the stated formula, spaced and cached", async () => {
  const { deps, calls } = fakeDeps({ liquidity: { QCAP: 11_042, QDOGE: 901_594 } });
  const routes = liquidityRoutes(deps, { maxRps: 20 });
  const res = (await get(routes, "/v1/liquidity/positions", { identity: WALLET })) as PositionsResponse;
  assert.equal(res.complete, true);
  assert.equal(res.poolsChecked, 3);
  assert.deepEqual(res.positions.map((p) => p.asset), ["QCAP", "QDOGE"]); // by value
  const qcap = res.positions[0];
  assert.equal(qcap.quOut, Math.floor((11_042 * 1_930_194_478) / 3_694_927));
  assert.equal(qcap.assetOut, 21);
  assert.equal(qcap.earnedFeesQu, 157);
  assert.ok(Math.abs(qcap.sharePct - (11_042 / 3_694_927) * 100) < 1e-9);
  assert.match(res.note, /valueQu = quOut \+ assetOut x \(reserveQu \/ reserveAsset\)/);
  assert.match(res.note, /already inside what you get when you remove/);
  // Three position reads and two pool reads, paced at 20 a second (50 ms slots). A timer can fire late, which squeezes one gap, so the pace is
  // checked over the whole run: each call has its own slot, so five calls cannot finish in under four slots.
  assert.equal(calls.length, 5);
  const span = calls[calls.length - 1].at - calls[0].at;
  assert.ok(span >= (calls.length - 1) * 45, `five calls took only ${span} ms`);
  // Cached: no more reads.
  await get(routes, "/v1/liquidity/positions", { identity: WALLET });
  assert.equal(calls.length, 5);
});

test("GET /v1/liquidity/positions: bad identity is a 400, an unreadable pool is reported, not hidden", async () => {
  const { deps } = fakeDeps({ liquidity: { QCAP: 5 }, failPool: "PORTAL" });
  const routes = liquidityRoutes(deps, { maxRps: 100 });
  await assert.rejects(() => Promise.resolve(get(routes, "/v1/liquidity/positions", { identity: "nope" })), (e: unknown) => e instanceof RouteError && e.status === 400);
  await assert.rejects(() => Promise.resolve(get(routes, "/v1/liquidity/positions", {})), (e: unknown) => e instanceof RouteError && e.status === 400);
  const res = (await get(routes, "/v1/liquidity/positions", { identity: WALLET })) as PositionsResponse;
  assert.equal(res.complete, false);
  assert.deepEqual(res.failed.map((f) => f.asset), ["PORTAL"]);
  assert.equal(res.positions.length, 1);
});

test("GET /v1/liquidity/positions: at most a few wallets are scanned at once", async () => {
  const { deps } = fakeDeps();
  const routes = liquidityRoutes(deps, { maxRps: 50, maxScans: 1 });
  const first = get(routes, "/v1/liquidity/positions", { identity: WALLET });
  await assert.rejects(() => Promise.resolve(get(routes, "/v1/liquidity/positions", { identity: "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL" })), (e: unknown) => e instanceof RouteError && e.status === 503);
  await first;
  await get(routes, "/v1/liquidity/positions", { identity: "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL" });
});

test("GET /v1/liquidity/pool: the live pool, 404 for an asset without one", async () => {
  const { deps } = fakeDeps();
  const routes = liquidityRoutes(deps, { maxRps: 100 });
  const res = (await get(routes, "/v1/liquidity/pool", { asset: "portal" })) as Record<string, unknown>;
  assert.equal(res.asset, "PORTAL");
  assert.equal(res.reserveQu, 6_123_804_380);
  assert.equal(res.totalLiquidity, 18_657_463);
  assert.equal(res.lockedLiquidity, 1000);
  assert.equal(res.flatFeeQu, LIQUIDITY_FEE_QU);
  assert.ok(Math.abs((res.priceQu as number) - 6_123_804_380 / 57_465) < 1e-6);
  await assert.rejects(() => Promise.resolve(get(routes, "/v1/liquidity/pool", { asset: "CFB" })), (e: unknown) => e instanceof RouteError && e.status === 404);
  await assert.rejects(() => Promise.resolve(get(routes, "/v1/liquidity/pool", {})), (e: unknown) => e instanceof RouteError && e.status === 400);
});

test("a refused plan never carries anything to sign", () => {
  const r = rng(5);
  for (let i = 0; i < 500; i++) {
    const p = randomPool(r);
    const plan: AddPlan = planAddLiquidity({ asset: ASSET, pool: p, quAmount: r.log(1, 1e12), balanceQu: r.log(1, 1e12), holdings: { [QX]: r.log(1, 1e9) }, slippageBps: r.pick([0, 100, 1000]), transferFeeQu: FEES });
    if (!plan.ok) assert.ok(plan.steps.length === 0 && plan.call === null && plan.maxOutlayQu === 0);
    else assert.ok(plan.steps.length >= 1 && plan.refusal === null);
  }
});

/* =================================================================================================================
 * Adversarial review: cases the first version got wrong or did not cover
 * ================================================================================================================= */

test("two signatures: a price rise between the share move and the deposit is caught by the re-check, not paid for", () => {
  // QCAP-like: about 270,000 QU per token, a 10% limit, so the QU-side band is about one token wide.
  const p0 = pool(1_930_194_478, 7_127, 3_694_927);
  const plan = planAddLiquidity({ asset: ASSET, pool: p0, quAmount: 30_000_000, balanceQu: 1e12, holdings: { [QX]: 1_000 }, slippageBps: 1000, transferFeeQu: FEES });
  assert.ok(plan.ok, plan.refusal?.message);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "add-liquidity"]);
  const A = BigInt(plan.assetAmount);
  const sim = simOf(p0);
  fund(sim, 1e12, { [QX]: 1_000 });
  sim.send(USER, plan.steps[0]); // the move lands
  // The price rises into the band where QSwap takes all of maxQu for the same tokens (still inside the 10% limit).
  jumpPrice(sim, BigInt(plan.maxQu) * 2n + 1n, A * 2n + 1n);
  const fresh = sim.state();
  const check = recheckAdd(plan, fresh);
  assert.ok(check.ok, "the contract would accept it");
  assert.equal(check.quSide, true, "and the re-check says it would take the QU-side path");
  // What signing anyway would have cost: all of maxQu went in, and the excess over the tokens' worth went to the pool.
  const before = sim.balance(USER);
  sim.send(USER, plan.steps[1]);
  const quIn = Number(before - sim.balance(USER)) - LIQUIDITY_FEE_QU;
  assert.equal(quIn, plan.maxQu);
  const over = quIn - plan.assetAmount * (fresh.reserveQu / fresh.reserveAsset);
  assert.ok(over > 100_000 && over <= plan.worstRoundingQu, `lost ${over}`);
  // Planned again at the new price, the same deposit takes the token-side path: nothing is given away.
  const again = planAddLiquidity({ asset: ASSET, pool: fresh, quAmount: 30_000_000, balanceQu: 1e12, holdings: { [QSWAP]: 1_000 }, slippageBps: 1000, transferFeeQu: FEES });
  assert.ok(again.ok);
  const q = predictAdd(fresh, again.call!);
  assert.ok(q.ok && q.path === "token-side");
});

test("remove: a partial removal that leaves a remainder worth less than the removal fee says so (it could never come out at a profit)", () => {
  const p = pool(1_000_000_000, 10_000_000, 100_000_000); // one unit is worth 20 QU
  const plan = planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 50_000, amount: { percent: 95 }, balanceQu: 1e9, slippageBps: 100 });
  assert.ok(plan.ok);
  assert.ok(plan.warnings.some((w) => /2,500 units you keep would be worth only about 50,000 QU.*Remove all of it now instead/.test(w)), plan.warnings.join(" | "));
  // And indeed: removing those 2,500 units later is refused by the planner's own rule.
  const after = { ...p, reserveQu: p.reserveQu - plan.expectedQu, reserveAsset: p.reserveAsset - plan.expectedAsset, totalLiquidity: p.totalLiquidity - plan.burnLiquidity };
  assert.equal(planRemoveLiquidity({ asset: ASSET, pool: after, liquidity: 50_000 - plan.burnLiquidity, amount: { percent: 100 }, balanceQu: 1e9, slippageBps: 100 }).refusal?.code, "fees-exceed-removal");
  // A remainder worth more than the fee, or removing everything, gets no such warning.
  assert.ok(!planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 50_000, amount: { percent: 50 }, balanceQu: 1e9, slippageBps: 100 }).warnings.some((w) => /you keep/.test(w)));
  assert.ok(!planRemoveLiquidity({ asset: ASSET, pool: p, liquidity: 50_000, amount: { percent: 100 }, balanceQu: 1e9, slippageBps: 100 }).warnings.some((w) => /you keep/.test(w)));
});

test("after a run that changed nothing, the page says what was really sent: never 'refused and refunded' for something QSwap never saw", () => {
  const base = { symbol: "QCAP", dLiquidity: 0, dQu: 0, underQswapBefore: 0, underQswapAfter: 0 };
  // The wallet declined the move: nothing reached QX or QSwap.
  const declined = noChangeNotes({ ...base, mode: "add", liquidityTx: "not-sent", moveTx: "not-sent" });
  assert.match(declined.notes.join(" "), /never sent/);
  assert.doesNotMatch(declined.notes.join(" "), /refused|refunded|moved/);
  assert.equal(declined.quCaption, "nothing was charged");
  // The move landed but QX moved nothing (shares in an ask), so the deposit was held back.
  const stuck = noChangeNotes({ ...base, mode: "add", liquidityTx: "not-sent", moveTx: "included" });
  assert.match(stuck.notes.join(" "), /never sent/);
  assert.match(stuck.notes.join(" "), /share move did not change/);
  assert.doesNotMatch(stuck.notes.join(" "), /stay there/);
  // The move worked, then the person declined to sign the deposit.
  const half = noChangeNotes({ ...base, mode: "add", liquidityTx: "not-sent", moveTx: "included", underQswapAfter: 21 });
  assert.match(half.notes.join(" "), /21 QCAP moved from QX to QSwap's management and stay there/);
  assert.doesNotMatch(half.notes.join(" "), /refused/);
  // Broadcast, not confirmed in time: it may still land.
  assert.match(noChangeNotes({ ...base, mode: "remove", liquidityTx: "unconfirmed" }).notes.join(" "), /broadcast but .* not see it confirmed/);
  // Included and the QU is back: that is a refusal with a refund.
  assert.match(noChangeNotes({ ...base, mode: "add", liquidityTx: "included" }).notes.join(" "), /refused the deposit and refunded everything/);
  assert.match(noChangeNotes({ ...base, mode: "remove", liquidityTx: "included" }).notes.join(" "), /refused the removal .* sent the fee back/);
  assert.match(noChangeNotes({ ...base, mode: "remove", liquidityTx: "not-sent" }).notes.join(" "), /no fee was paid/);
});

test("GET /v1/liquidity/positions?fresh=1 reads again after an add or remove, but not more often than every few seconds", async () => {
  let now = 1_000_000;
  const { deps, calls } = fakeDeps({ liquidity: { QCAP: 11_042 } });
  const routes = liquidityRoutes(deps, { maxRps: 1000, now: () => now });
  await get(routes, "/v1/liquidity/positions", { identity: WALLET });
  const first = calls.length;
  now += 2_000;
  await get(routes, "/v1/liquidity/positions", { identity: WALLET, fresh: "1" });
  assert.equal(calls.length, first, "a 2-second-old answer is fresh enough");
  now += 4_000;
  await get(routes, "/v1/liquidity/positions", { identity: WALLET });
  assert.equal(calls.length, first, "without fresh the 30-second cache holds");
  await get(routes, "/v1/liquidity/positions", { identity: WALLET, fresh: "1" });
  assert.ok(calls.length > first, "with fresh a 6-second-old answer is read again");
});

test("an absurd earnedFees figure does not make a position unreadable (it is bookkeeping; liquidity is what matters)", () => {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setBigInt64(0, 1_427_332n, true);
  v.setBigUint64(8, (1n << 64n) - 1n, true);
  const d = decodeLiquidityOf(b);
  assert.equal(d.liquidity, 1_427_332);
  assert.ok(d.earnedFeesQu > 1e19);
});

test("a deposit of more tokens than JavaScript counts exactly is refused plainly", () => {
  const p = pool(10_000, 9_000_000_000_000_000, 1e12); // a token worth about 1e-12 QU
  const plan = planAddLiquidity(addInput({ pool: p, quAmount: 2_000_000, holdings: { [QSWAP]: Number.MAX_SAFE_INTEGER, [QX]: Number.MAX_SAFE_INTEGER } }));
  assert.equal(plan.refusal?.code, "too-large");
  assert.deepEqual(plan.steps, []);
});

test("a deposit that would be a large part of a thin pool warns that its price is cheap to move (QVERSAL held 129,242 QU)", () => {
  const qversal = pool(129_242, 2_235_819, 537_000);
  const plan = planAddLiquidity(addInput({ pool: qversal, quAmount: 500_000, holdings: { [QSWAP]: 1e9 } }));
  assert.ok(plan.ok, plan.refusal?.message);
  assert.ok(plan.warnings.some((w) => /would be 79% of the QCAP pool.*Compare the price with QX first/.test(w)), plan.warnings.join(" | "));
  // A deposit that is a small part of a deep pool does not.
  assert.ok(!planAddLiquidity(addInput({ pool: pool(1_000_000_000, 10_000_000, 100_000_000), quAmount: 50_000_000 })).warnings.some((w) => /Compare the price with QX/.test(w)));
});
