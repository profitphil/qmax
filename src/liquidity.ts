/**
 * Adding liquidity to an existing QSwap pool and taking it out again: what the contract will do, the transactions to sign,
 * and limits that make a price move refuse instead of trade badly. Nothing here signs or sends anything; it plans, and the
 * web app runs the steps through the user's own wallet. Browser-safe on purpose (no node imports): the modal plans with it.
 *
 * Everything below was read from the contract, https://github.com/qubic/core/blob/main/src/contracts/Qswap.h (line numbers
 * from the main branch as read on 2026-10-04), and Qx.h for share management, then checked against the live contract and
 * the archive (scripts/liquidity-check.ts). Creating a pool (the first deposit) is out of scope and refused.
 *
 * AddLiquidity (procedure 4, L1057-1355). The QU attached is `invocationReward`: QSWAP_ADDITIONAL_FEE (100,000 QU) is a flat
 * fee and the rest is `quAmountDesired` (L1070). With tokens worth `assetOptimal = floor(quAmountDesired x reserveAsset /
 * reserveQu)` (L1106):
 *  - "QU-side path" (assetOptimal <= assetAmountDesired, L1119-1128): it takes ALL of quAmountDesired and assetOptimal tokens,
 *    checking only assetAmountMin.
 *  - "token-side path" (otherwise, L1129-1155): it takes exactly assetAmountDesired tokens and
 *    floor(assetAmountDesired x reserveQu / reserveAsset) QU, checking quAmountMin, and refunds the unused QU (L1351-1353).
 *  It mints min(QU x total / reserveQu, tokens x total / reserveAsset) liquidity, each rounded down (L1237-1260).
 *  Every refusal refunds the WHOLE attachment, the 100,000 QU fee included (L1066, 1077, 1091, 1115, 1123, 1140, 1145, 1150,
 *  1161, 1175, 1186, 1217, 1243, 1252, 1265, 1274, 1307), and no refusal comes after the tokens have moved, so there is no
 *  path that keeps tokens and refunds QU or the other way round. The fee is kept only when liquidity was minted (L1311).
 *
 * Traps found in AddLiquidity, and what the planner does about each:
 *  - TOKEN ROUNDING ON THE QU-SIDE PATH. The fraction of a token rounded away by floor() is not handed back as QU: the pool
 *    keeps it, and the liquidity minted follows the (smaller) token side. For QCAP at about 270,000 QU per token that is up to
 *    270,000 QU given to the other liquidity providers. Worse, that path never checks quAmountMin, so a price FALL does not
 *    refuse. The archive shows real deposits that hit it (QCAP: 6,000,000 QU put in for 21 QCAP; PORTAL: 1,421,706 QU for 9).
 *    Planner: it always fixes the token side (assetAmountDesired = assetAmountMin = the tokens shown) and attaches enough QU
 *    that at today's price the contract takes the token-side path, which rounds by under 1 QU. The QU-side path can then only
 *    happen if the price RISES (inside the user's limit), and costs at most `worstRoundingQu` (about one token's worth). A
 *    deposit whose slippage room is smaller than one token would take the QU-side path at today's price: it is refused, with
 *    the smallest deposit (or slippage) that works.
 *  - Too little to mint one liquidity unit (L1263): refunded in full; the planner refuses it first.
 *  - Tokens must be owned and possessed under QSwap's management (L1166-1177, SELF_INDEX twice), or the call refunds in full.
 *    Shares under QX are moved first (see below).
 *  - First deposit into an empty pool (totalLiquidity 0, L1099-1103 and L1180-1234): QSWAP_MIN_LIQUIDITY = 1,000 units are
 *    locked to the contract for ever (L1224-1226). Out of scope: refused. Because of it every pool's totalLiquidity includes
 *    1,000 units nobody can withdraw; shares here are always worked out over the total, those units included.
 *  - Overflow guards (L1113, 1138, 1241, 1250) refund in full; the amounts here are far below them, and a plan near them is refused.
 *  - L1159 (QU short) cannot trigger: the QU taken is never more than what was attached less the fee.
 *
 * RemoveLiquidity (procedure 5, L1375-1500). Below 100,000 attached everything is refunded (L1380-1384); above it the excess
 * is refunded at once (L1385-1388). Every later refusal refunds the 100,000 (L1393, 1408, 1418, 1427, 1433, 1452). It pays
 * floor(burn x reserveQu / total) QU and floor(burn x reserveAsset / total) tokens (L1438-1447).
 *  - ZERO PAYOUT. There is no check that either amount is above zero: with zero minimums, burning a little liquidity can pay
 *    0 QU and/or 0 tokens while the fee is kept and the liquidity is gone. Planner: a removal that pays 0 on a side is refused
 *    (a whole position may still leave the token fraction behind, with a warning), and every minimum it signs is at least 1, so
 *    the contract refuses (and refunds the fee) rather than pay nothing.
 *  - The token fraction rounded away (worth up to one token) stays in the pool. For part of a position the planner burns the
 *    least liquidity that pays the same whole number of tokens, so the rest stays in the position instead of being lost.
 *  - The token transfer back (L1461-1468) is not checked. It can only fail if the contract's own records are short, which the
 *    rest of the code prevents; this cannot be verified from outside.
 *  - Returned tokens stay managed by QSwap (the contract transfers them under its own index). Selling them on QX needs a share move.
 *  - Swaps can leave reservedQuAmount at 0 (L2003-2006, L2216-2219). A pool empty on either side is refused for both actions.
 *
 * Share management (Qx.h L1084-1114): QX's TransferShareManagementRights refunds whatever QU is attached straight away ("no fee")
 * and hands the shares to QSwap, which asks no fee (Qswap.h L2488-2491). It moves nothing if the wallet's QX-managed shares,
 * less those in its own resting QX asks, are short (the attachment is still refunded). `rightsStep` attaches the receiving
 * contract's transfer fee anyway (100 QU), so the wallet must hold it; it comes straight back.
 */
import { QSWAP_OPERATION_FEE_QU, rightsStep } from "./exec.ts";
import type { Holdings, TxStep } from "./exec.ts";
import { assetNameToU64, identityToBytes } from "./identity.ts";
import { RouteError, required } from "./routes.ts";
import type { Route } from "./routes.ts";
import { QSWAP_INDEX, QX_INDEX, structWriter } from "./rpc.ts";

/** Qswap.h REGISTER_USER_FUNCTIONS_AND_PROCEDURES (L2364-2388). */
export const QSWAP_FN = { fees: 1, poolState: 2, liquidityOf: 3 } as const;
export const QSWAP_PROC = { addLiquidity: 4, removeLiquidity: 5 } as const;
/** QSWAP_ADDITIONAL_FEE: attached to every AddLiquidity and RemoveLiquidity, kept only when it goes through. */
export const LIQUIDITY_FEE_QU = QSWAP_OPERATION_FEE_QU;
/** QSWAP_MIN_LIQUIDITY: units locked to the contract at a pool's first deposit, in every pool's total for ever. */
export const QSWAP_MIN_LIQUIDITY = 1000;
/** The contract's event types for liquidity changes (QSWAPLogInfo, L4-5). */
export const QSWAP_LOG = { addLiquidity: 4, removeLiquidity: 5 } as const;

/** QPI MAX_AMOUNT: no transaction moves more QU than this. */
const MAX_AMOUNT = 1_000_000_000_000_000n;
const I64_MAX = (1n << 63n) - 1n;
const BPS = 10_000n;
/** Rounding (the pool's liquidity units and token fractions) above this share of a deposit is refused. Judgement call. */
export const MAX_ROUNDING_SHARE = 0.01;
/** Rounding above this share of a deposit or removal gets a warning. Judgement call. */
const WARN_ROUNDING_SHARE = 0.002;
/** Flat fees (add + remove) above this share of a deposit get a warning. Judgement call. */
const WARN_FEE_SHARE = 0.05;
/** A deposit above this share of the pool (QU side, after it) gets a warning that the pool's price is easy to move. Judgement call. */
const THIN_POOL_SHARE = 0.2;
/** The most price movement a plan may allow (10%), as in the swap planner. */
export const MAX_SLIPPAGE_BPS = 1000;

const money = (n: number | bigint) => (typeof n === "bigint" ? n : Math.round(n)).toLocaleString("en-US");
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
/** BigInt division rounded down, 0 for a zero divisor (QPI's div does the same: `b ? a / b : 0`). */
const div = (a: bigint, b: bigint) => (b === 0n ? 0n : a / b);
const ceilDiv = (a: bigint, b: bigint) => (b === 0n ? 0n : (a + b - 1n) / b);
/** A bigint as a JS number, or null if it is not exactly representable. */
const safe = (v: bigint) => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null);

// ---------------------------------------------------------------------------------------------------------------
// Reading the contract

/** One pool as GetPoolBasicState reports it (function 2, L583-614). Amounts are whole QU, token units and liquidity units. */
export interface PoolState {
  exists: boolean;
  reserveQu: number;
  reserveAsset: number;
  /** All liquidity units, the 1,000 locked to the contract included. */
  totalLiquidity: number;
}

export interface AssetRef {
  /** What to call it in messages and step descriptions. */
  symbol: string;
  issuer: string;
  /** The on-chain name. */
  assetName: string;
}

/** GetPoolBasicState_input / GetLiquidityOf_input start with the asset: issuer (32 bytes) and name (u64). */
export function encodePoolQuery(issuer: string, assetName: string): Uint8Array {
  return structWriter(40).id(identityToBytes(issuer)).u64(assetNameToU64(assetName)).bytes;
}

/** GetLiquidityOf_input (L183-188): the asset, then the account. */
export function encodeLiquidityQuery(issuer: string, assetName: string, account: string | Uint8Array): Uint8Array {
  const id = typeof account === "string" ? identityToBytes(account) : account;
  if (id.length !== 32) throw new Error("An account is 32 bytes");
  return structWriter(72).id(identityToBytes(issuer)).u64(assetNameToU64(assetName)).id(id).bytes;
}

function i64At(bytes: Uint8Array, off: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(off, true);
}
function u64At(bytes: Uint8Array, off: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(off, true);
}
function exact(v: bigint, what: string): number {
  const n = safe(v);
  if (n === null) throw new Error(`${what} is too large to handle exactly (${v})`);
  return n;
}

/**
 * GetPoolBasicState_output (L174-181): sint64 poolExists, reservedQuAmount, reservedAssetAmount, totalLiquidity, then
 * uint64 accFeePerLP (not used here). A pool that does not exist (or an asset that was never issued) comes back as
 * poolExists 0 with -1 in the amounts (L585-604). An empty answer (the node did not run the function) throws.
 */
export function decodePoolState(bytes: Uint8Array): PoolState {
  if (bytes.length < 32) throw new Error(`Unexpected GetPoolBasicState answer (${bytes.length} bytes)`);
  if (i64At(bytes, 0) !== 1n) return { exists: false, reserveQu: 0, reserveAsset: 0, totalLiquidity: 0 };
  const reserveQu = exact(i64At(bytes, 8), "reserveQu");
  const reserveAsset = exact(i64At(bytes, 16), "reserveAsset");
  const totalLiquidity = exact(i64At(bytes, 24), "totalLiquidity");
  if (reserveQu < 0 || reserveAsset < 0 || totalLiquidity < 0) throw new Error("GetPoolBasicState returned a negative amount for an existing pool");
  return { exists: true, reserveQu, reserveAsset, totalLiquidity };
}

export interface LiquidityOf {
  /** The account's liquidity units in the pool (0 when it has none). */
  liquidity: number;
  /**
   * `earnedFees` as GetLiquidityOf reports it (L649-656): the pool's fee income attributed to this position since it was
   * opened. Bookkeeping only: nothing pays it out separately. The fees are part of the pool's reserves, so they are already
   * inside what a removal pays.
   */
  earnedFeesQu: number;
}

/**
 * GetLiquidityOf_output (L189-193): sint64 liquidity, uint64 earnedFees. earnedFees is bookkeeping only (it is computed from
 * uint128 products the contract never checks), so a value too large to hold exactly is reported approximately rather than
 * making the position unreadable: liquidity is what adding and removing depend on.
 */
export function decodeLiquidityOf(bytes: Uint8Array): LiquidityOf {
  if (bytes.length < 16) throw new Error(`Unexpected GetLiquidityOf answer (${bytes.length} bytes)`);
  const liquidity = exact(i64At(bytes, 0), "liquidity");
  if (liquidity < 0) throw new Error("GetLiquidityOf returned negative liquidity");
  return { liquidity, earnedFeesQu: Number(u64At(bytes, 8)) };
}

/** What every reader needs: one contract function call returning the raw output (`QubicRpc.query`). */
export type QueryFn = (contractIndex: number, functionId: number, input: Uint8Array) => Promise<Uint8Array>;

export async function readPool(query: QueryFn, asset: Pick<AssetRef, "issuer" | "assetName">): Promise<PoolState> {
  return decodePoolState(await query(QSWAP_INDEX, QSWAP_FN.poolState, encodePoolQuery(asset.issuer, asset.assetName)));
}

export async function readLiquidity(query: QueryFn, asset: Pick<AssetRef, "issuer" | "assetName">, account: string): Promise<LiquidityOf> {
  return decodeLiquidityOf(await query(QSWAP_INDEX, QSWAP_FN.liquidityOf, encodeLiquidityQuery(asset.issuer, asset.assetName, account)));
}

/** AddLiquidityMessage (L31-41) as the archive serves it (`rawPayload`, the 8-byte header left out). */
export function decodeAddLiquidityEvent(body: Uint8Array): { liquidity: number; quAmount: number; assetAmount: number } | null {
  if (body.length < 64) return null;
  return { liquidity: exact(i64At(body, 40), "liquidity"), quAmount: exact(i64At(body, 48), "quAmount"), assetAmount: exact(i64At(body, 56), "assetAmount") };
}

/** RemoveLiquidityMessage (L43-50): QU and token amounts paid out. It does not name the asset; the transaction does. */
export function decodeRemoveLiquidityEvent(body: Uint8Array): { quAmount: number; assetAmount: number } | null {
  if (body.length < 16) return null;
  return { quAmount: exact(i64At(body, 0), "quAmount"), assetAmount: exact(i64At(body, 8), "assetAmount") };
}

// ---------------------------------------------------------------------------------------------------------------
// The contract's own arithmetic

/** A call as it is signed: the QU attached and the input struct. */
export interface AddCall {
  amountQu: number;
  assetAmountDesired: number;
  quAmountMin: number;
  assetAmountMin: number;
}
export interface RemoveCall {
  amountQu: number;
  burnLiquidity: number;
  quAmountMin: number;
  assetAmountMin: number;
}

export type AddRefusalCode =
  | "fee-only"
  | "bad-input"
  | "no-pool"
  | "overflow"
  | "asset-min"
  | "qu-over"
  | "qu-min"
  | "asset-short"
  | "first-too-small"
  | "zero-liquidity";

export type AddPrediction =
  | {
      ok: true;
      /** "qu-side": all of quAmountDesired went in (L1119-1128). "token-side": exactly assetAmountDesired (L1129-1155). "first": an empty pool's first deposit. */
      path: "qu-side" | "token-side" | "first";
      quUsed: number;
      assetUsed: number;
      /** Liquidity units credited to the caller. */
      liquidity: number;
      /** QU sent back by the contract (attached less quUsed less the fee, L1351-1353). */
      refundQu: number;
      feeQu: number;
      poolAfter: PoolState;
    }
  /** Refused: the whole attachment comes back, the flat fee included. */
  | { ok: false; code: AddRefusalCode; line: number; refundQu: number };

const big = (n: number) => BigInt(n);

/**
 * floor(amountA x reserveB / reserveA), or -1 when it does not fit an int64: quoteEquivalentAmountB (L419-432).
 * A zero reserveA gives 0, as QPI's division by zero does.
 */
export function quoteEquivalent(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  const r = div(amountA * reserveB, reserveA);
  return r > I64_MAX ? -1n : r;
}

/** Integer square root rounded down (the contract's `sqrt`, L385-417). Only the first deposit uses it. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * What AddLiquidity does with `call` on `pool`, line by line (L1057-1355), for a caller holding `possessedUnderQswap` tokens
 * under QSwap management (leave it out to assume enough). The collection-full refusal (L1272) and a failing token transfer
 * (L1305) cannot be seen from outside and are not modelled; both refund in full.
 */
export function predictAdd(pool: PoolState, call: AddCall, possessedUnderQswap = Number.MAX_SAFE_INTEGER): AddPrediction {
  const reward = big(call.amountQu);
  const refuse = (code: AddRefusalCode, line: number): AddPrediction => ({ ok: false, code, line, refundQu: call.amountQu });
  const fee = big(LIQUIDITY_FEE_QU);
  if (reward <= fee) return refuse("fee-only", 1064);
  const quDesired = reward - fee;
  const aDesired = big(call.assetAmountDesired);
  const quMin = big(call.quAmountMin);
  const aMin = big(call.assetAmountMin);
  if (aDesired <= 0n || quMin < 0n || aMin < 0n) return refuse("bad-input", 1073);
  if (!pool.exists) return refuse("no-pool", 1089);
  const rQu = big(pool.reserveQu);
  const rAsset = big(pool.reserveAsset);
  const total = big(pool.totalLiquidity);

  let quT: bigint;
  let aT: bigint;
  let path: "qu-side" | "token-side" | "first";
  if (total === 0n) {
    quT = quDesired;
    aT = aDesired;
    path = "first";
  } else {
    const aOpt = quoteEquivalent(quDesired, rQu, rAsset);
    if (aOpt === -1n) return refuse("overflow", 1113);
    if (aOpt <= aDesired) {
      if (aOpt < aMin) return refuse("asset-min", 1121);
      quT = quDesired;
      aT = aOpt;
      path = "qu-side";
    } else {
      const qOpt = quoteEquivalent(aDesired, rAsset, rQu);
      if (qOpt === -1n) return refuse("overflow", 1138);
      if (qOpt > quDesired) return refuse("qu-over", 1143);
      if (qOpt < quMin) return refuse("qu-min", 1148);
      quT = qOpt;
      aT = aDesired;
      path = "token-side";
    }
  }
  if (big(possessedUnderQswap) < aT) return refuse("asset-short", 1166);

  let minted: bigint;
  let credited: bigint;
  if (total === 0n) {
    minted = quT === aT ? quT : isqrt(quT * aT);
    if (minted < big(QSWAP_MIN_LIQUIDITY)) return refuse("first-too-small", 1184);
    credited = minted - big(QSWAP_MIN_LIQUIDITY);
  } else {
    const byQu = div(quT * total, rQu);
    const byAsset = div(aT * total, rAsset);
    if (byQu > I64_MAX || byAsset > I64_MAX) return refuse("overflow", 1241);
    minted = byQu < byAsset ? byQu : byAsset;
    if (minted === 0n) return refuse("zero-liquidity", 1263);
    credited = minted;
  }
  const refund = reward - fee > quT ? reward - quT - fee : 0n;
  return {
    ok: true,
    path,
    quUsed: Number(quT),
    assetUsed: Number(aT),
    liquidity: Number(credited),
    refundQu: Number(refund),
    feeQu: LIQUIDITY_FEE_QU,
    poolAfter: { exists: true, reserveQu: Number(rQu + quT), reserveAsset: Number(rAsset + aT), totalLiquidity: Number(total + minted) },
  };
}

export type RemoveRefusalCode = "fee-short" | "bad-input" | "no-pool" | "no-position" | "too-much" | "over-total" | "mins";

export type RemovePrediction =
  | { ok: true; quOut: number; assetOut: number; /** Excess over the fee, sent back at once (L1385-1388). */ refundQu: number; feeQu: number; poolAfter: PoolState }
  /** Refused: everything attached comes back, the flat fee included. */
  | { ok: false; code: RemoveRefusalCode; line: number; refundQu: number };

/** What RemoveLiquidity does with `call` on `pool` for a caller holding `userLiquidity` units (L1375-1500). */
export function predictRemove(pool: PoolState, call: RemoveCall, userLiquidity: number): RemovePrediction {
  const refuse = (code: RemoveRefusalCode, line: number): RemovePrediction => ({ ok: false, code, line, refundQu: call.amountQu });
  if (call.amountQu < LIQUIDITY_FEE_QU) return refuse("fee-short", 1380);
  const burn = big(call.burnLiquidity);
  if (call.quAmountMin < 0 || call.assetAmountMin < 0 || burn <= 0n) return refuse("bad-input", 1391);
  if (!pool.exists) return refuse("no-pool", 1406);
  if (userLiquidity <= 0) return refuse("no-position", 1416);
  if (big(userLiquidity) < burn) return refuse("too-much", 1425);
  const total = big(pool.totalLiquidity);
  if (total < burn) return refuse("over-total", 1431);
  const quOut = div(burn * big(pool.reserveQu), total);
  const assetOut = div(burn * big(pool.reserveAsset), total);
  if (quOut < big(call.quAmountMin) || assetOut < big(call.assetAmountMin)) return refuse("mins", 1450);
  return {
    ok: true,
    quOut: Number(quOut),
    assetOut: Number(assetOut),
    refundQu: call.amountQu - LIQUIDITY_FEE_QU,
    feeQu: LIQUIDITY_FEE_QU,
    poolAfter: { exists: true, reserveQu: pool.reserveQu - Number(quOut), reserveAsset: pool.reserveAsset - Number(assetOut), totalLiquidity: pool.totalLiquidity - call.burnLiquidity },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What a position is worth

export interface PositionValue {
  /** liquidity / totalLiquidity, in percent (the 1,000 locked units are part of the total). */
  sharePct: number;
  /** What removing all of it would pay before the 100,000 QU fee, rounded down as the contract does (L1438-1447). */
  quOut: number;
  assetOut: number;
  /** quOut + assetOut x (reserveQu / reserveAsset): the tokens valued at the pool's own price. An estimate of value, not a sale price. */
  valueQu: number;
}

export function positionValue(pool: PoolState, liquidity: number): PositionValue {
  if (!pool.exists || pool.totalLiquidity <= 0 || liquidity <= 0) return { sharePct: 0, quOut: 0, assetOut: 0, valueQu: 0 };
  const l = big(liquidity);
  const total = big(pool.totalLiquidity);
  const quOut = Number(div(l * big(pool.reserveQu), total));
  const assetOut = Number(div(l * big(pool.reserveAsset), total));
  const price = pool.reserveAsset > 0 ? pool.reserveQu / pool.reserveAsset : 0;
  return { sharePct: (liquidity / pool.totalLiquidity) * 100, quOut, assetOut, valueQu: Math.floor(quOut + assetOut * price) };
}

/** QU per token at the pool's reserves, or null when either side is empty. */
export const poolPriceQu = (pool: PoolState) => (pool.exists && pool.reserveQu > 0 && pool.reserveAsset > 0 ? pool.reserveQu / pool.reserveAsset : null);

// ---------------------------------------------------------------------------------------------------------------
// Steps

export type LiquidityStepKind = "transfer-rights" | "add-liquidity" | "remove-liquidity";
/** A `TxStep` with the two liquidity kinds `TxStep["kind"]` does not list yet. */
export interface LiquidityStep extends Omit<TxStep, "kind"> {
  kind: LiquidityStepKind;
}
/** `runSteps` takes `TxStep[]` and reads only id, to, inputType, amountQu and payload, so a liquidity step is passed as one. */
export const asTxSteps = (steps: LiquidityStep[]) => steps as unknown as TxStep[];

/** AddLiquidity_input (L278-285) and RemoveLiquidity_input (L293-300): the asset, then three sint64. 64 bytes. */
function liquidityPayload(asset: Pick<AssetRef, "issuer" | "assetName">, a: number, b: number, c: number) {
  return structWriter(64).id(identityToBytes(asset.issuer)).u64(assetNameToU64(asset.assetName)).i64(a).i64(b).i64(c).bytes;
}

export function addLiquidityStep(asset: AssetRef, call: AddCall, expectedQu: number): LiquidityStep {
  return {
    id: `add-liquidity-${asset.assetName}`,
    kind: "add-liquidity",
    description: `QSwap: add ${money(call.assetAmountDesired)} ${asset.symbol} and about ${money(expectedQu)} QU (at most ${money(call.amountQu - LIQUIDITY_FEE_QU)}) to the pool, plus the 100,000 QU fee`,
    to: { contractIndex: QSWAP_INDEX },
    inputType: QSWAP_PROC.addLiquidity,
    amountQu: call.amountQu,
    payload: liquidityPayload(asset, call.assetAmountDesired, call.quAmountMin, call.assetAmountMin),
  };
}

export function removeLiquidityStep(asset: AssetRef, call: RemoveCall): LiquidityStep {
  return {
    id: `remove-liquidity-${asset.assetName}`,
    kind: "remove-liquidity",
    description: `QSwap: remove ${money(call.burnLiquidity)} liquidity units for at least ${money(call.quAmountMin)} QU and ${money(call.assetAmountMin)} ${asset.symbol}, paying the 100,000 QU fee`,
    to: { contractIndex: QSWAP_INDEX },
    inputType: QSWAP_PROC.removeLiquidity,
    amountQu: call.amountQu,
    payload: liquidityPayload(asset, call.burnLiquidity, call.quAmountMin, call.assetAmountMin),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Planning a deposit

export type LiquidityRefusalCode =
  | "bad-input"
  | "no-pool"
  | "empty-pool"
  | "pool-one-sided"
  | "too-small"
  | "too-small-for-slippage"
  | "zero-liquidity"
  | "rounding"
  | "fees-exceed-deposit"
  | "insufficient-asset"
  | "insufficient-qu"
  | "too-large"
  | "no-position"
  | "more-than-owned"
  | "zero-payout"
  | "fees-exceed-removal"
  | "fee-unaffordable";

export interface Refusal {
  code: LiquidityRefusalCode;
  /** One or two plain sentences for the person: what is wrong and what would work. */
  message: string;
}

export interface AddPlanInput {
  asset: AssetRef;
  /** The pool as read live (GetPoolBasicState). */
  pool: PoolState;
  /** QU the person wants to put in on the QU side. The token side follows the pool's ratio, as the contract computes it. */
  quAmount: number;
  /** Wallet QU. */
  balanceQu: number;
  /** The wallet's shares of the asset per managing contract, LESS any shares in its resting QX asks (QX will not move those). */
  holdings: Holdings;
  /** How far the price may move between signing and execution before the contract refuses, in basis points (0-1000). */
  slippageBps: number;
  /** What QX and QSwap charge to take over shares (`fetchTransferFees`): what a share move attaches. */
  transferFeeQu: { qx: number; qswap: number };
  /** Liquidity the wallet already has in this pool, for the share it will own afterwards. */
  currentLiquidity?: number;
}

export interface AddPlan {
  ok: boolean;
  refusal: Refusal | null;
  asset: AssetRef;
  pool: PoolState;
  slippageBps: number;
  /** QU per token at the planned reserves. */
  priceQu: number | null;
  /** Exactly the tokens that go in (the call's assetAmountDesired and assetAmountMin). */
  assetAmount: number;
  /** QU that goes in at the planned reserves (the token-side path: floor(tokens x reserveQu / reserveAsset)). */
  expectedQu: number;
  /** The call's quAmountDesired: the most QU that can go in. */
  maxQu: number;
  /** The call's quAmountMin: less QU than this (the token got cheaper past the limit) and the contract refuses. */
  minQu: number;
  /** Liquidity units minted at the planned reserves. */
  expectedLiquidity: number;
  /** The wallet's share of the pool afterwards (its liquidity over all units), in percent. */
  shareAfterPct: number;
  /** What the deposit is worth at the pool's price (QU side plus tokens at the pool price). */
  depositValueQu: number;
  /** What the new liquidity is worth right after, the same way. The difference is rounding (`roundingLossQu`). */
  liquidityValueQu: number;
  /** Lost to rounding at the planned reserves (the pool's liquidity units are whole numbers). Never negative. */
  roundingLossQu: number;
  /**
   * The most the deposit can lose to the contract's token rounding if the price rises inside the limit (the QU-side path puts in
   * all of `maxQu` for the same tokens): about one token's worth. Zero at today's price.
   */
  worstRoundingQu: number;
  /** Flat fees: 100,000 QU now, 100,000 QU again when removing. */
  addFeeQu: number;
  removeFeeQu: number;
  /** QU a share move attaches (0 when none is needed). QX sends it straight back (Qx.h L1086-1090). */
  moveAttachQu: number;
  /** Tokens moved from QX to QSwap management first (0 when none). */
  moveQty: number;
  /** The call as it will be signed. */
  call: AddCall | null;
  /** The transactions, in order. Empty when refused: there is nothing to sign. */
  steps: LiquidityStep[];
  /** Every QU the steps attach together: what must be in the wallet. */
  maxOutlayQu: number;
  /** QU expected back at the planned reserves: the unused QU and the share move's attachment. */
  expectedRefundQu: number;
  /** QU that leaves the wallet for good at the planned reserves: the QU side plus the 100,000 QU fee. */
  expectedSpendQu: number;
  /** Plain-language lines on what comes back on each path. */
  refunds: string[];
  warnings: string[];
}

function emptyAddPlan(input: AddPlanInput): AddPlan {
  return {
    ok: false,
    refusal: null,
    asset: input.asset,
    pool: input.pool,
    slippageBps: input.slippageBps,
    priceQu: poolPriceQu(input.pool),
    assetAmount: 0,
    expectedQu: 0,
    maxQu: 0,
    minQu: 0,
    expectedLiquidity: 0,
    shareAfterPct: 0,
    depositValueQu: 0,
    liquidityValueQu: 0,
    roundingLossQu: 0,
    worstRoundingQu: 0,
    addFeeQu: LIQUIDITY_FEE_QU,
    removeFeeQu: LIQUIDITY_FEE_QU,
    moveAttachQu: 0,
    moveQty: 0,
    call: null,
    steps: [],
    maxOutlayQu: 0,
    expectedRefundQu: 0,
    expectedSpendQu: 0,
    refunds: [],
    warnings: [],
  };
}

/** Why the pool cannot take a deposit or pay a removal, or null. */
function poolProblem(pool: PoolState, symbol: string): Refusal | null {
  if (!pool.exists) return { code: "no-pool", message: `${symbol} has no QSwap pool. Creating a pool is not something QMax does.` };
  if (pool.totalLiquidity <= 0)
    return { code: "empty-pool", message: `The ${symbol} pool has no liquidity. The first deposit sets the pool's price and locks 1,000 liquidity units for ever; QMax does not make it.` };
  if (pool.reserveQu <= 0 || pool.reserveAsset <= 0)
    return { code: "pool-one-sided", message: `The ${symbol} pool is empty on one side, so it has no price to deposit or withdraw at. Try again once it has been refilled.` };
  if (![pool.reserveQu, pool.reserveAsset, pool.totalLiquidity].every(isCount)) return { code: "bad-input", message: "The pool's amounts could not be read exactly." };
  return null;
}

/** The QU limits for depositing exactly `a` tokens: [quMin, quMax] around floor(a x price), and the QU at today's price. */
function quLimits(a: bigint, rQu: bigint, rAsset: bigint, s: bigint) {
  return {
    expected: div(a * rQu, rAsset),
    max: div(a * rQu * (BPS + s), rAsset * BPS),
    min: div(a * rQu * (BPS - s), rAsset * BPS),
  };
}

/** True when depositing `a` tokens with quMax as above makes the contract take the token-side path at today's price (L1119: assetOptimal > a). */
function tokenSideAtPlannedPrice(a: bigint, rQu: bigint, rAsset: bigint, s: bigint) {
  const { max } = quLimits(a, rQu, rAsset, s);
  return div(max * rAsset, rQu) > a;
}

/**
 * A small token amount for which the slippage room covers a whole token, so today's price takes the token-side path. Nothing
 * below 10,000 / slippageBps tokens can (the room is tokens x slippage); every amount from (1 + 1/price) x 10,000 / slippageBps
 * up can (the room then also covers the QU lost to rounding Qmax down). In between it depends on rounding, so the first
 * 2,000 amounts from the lower bound are tried before the upper one is returned. Null for a 0% limit.
 */
export function minTokensForSlippage(pool: PoolState, slippageBps: number): number | null {
  if (!(slippageBps > 0) || poolProblem(pool, "")) return null;
  const rQu = big(pool.reserveQu);
  const rAsset = big(pool.reserveAsset);
  const s = big(Math.floor(slippageBps));
  const low = ceilDiv(BPS, s);
  const sure = ceilDiv((rQu + rAsset) * BPS, rQu * s);
  for (let a = low; a < sure && a < low + 2000n; a++) if (tokenSideAtPlannedPrice(a, rQu, rAsset, s)) return Number(a);
  for (let a = sure; a < sure + 64n; a++) if (tokenSideAtPlannedPrice(a, rQu, rAsset, s)) return safe(a);
  return null;
}

/**
 * The smallest price limit (in basis points, at most 10%) at which depositing `tokens` takes the token-side path at today's
 * price, or null if even 10% is not enough. A larger limit only raises the most QU attached, so the search can halve.
 */
export function minSlippageBpsFor(pool: PoolState, tokens: number): number | null {
  if (poolProblem(pool, "") || !isCount(tokens) || tokens < 1) return null;
  const rQu = big(pool.reserveQu);
  const rAsset = big(pool.reserveAsset);
  const a = big(tokens);
  if (!tokenSideAtPlannedPrice(a, rQu, rAsset, big(MAX_SLIPPAGE_BPS))) return null;
  let lo = 0;
  let hi = MAX_SLIPPAGE_BPS;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tokenSideAtPlannedPrice(a, rQu, rAsset, big(mid))) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Plans adding `quAmount` QU (and the tokens the pool's ratio asks for) to an existing pool. Pure. A refused plan has a plain
 * reason and no steps. The plan deposits EXACTLY `assetAmount` tokens and between `minQu` and `maxQu` QU (about `expectedQu`
 * at today's price); if the price moves past the limit either way the contract refuses and refunds everything, the fee
 * included. See the notes at the top of this file for why the token side, not the QU side, is the fixed one.
 */
export function planAddLiquidity(input: AddPlanInput): AddPlan {
  const plan = emptyAddPlan(input);
  const { asset, pool } = input;
  const sym = asset.symbol;
  const stop = (code: LiquidityRefusalCode, message: string) => {
    plan.ok = false;
    plan.refusal = { code, message };
    plan.steps = [];
    plan.call = null;
    plan.maxOutlayQu = 0;
    return plan;
  };
  if (!isCount(input.quAmount) || input.quAmount <= 0) return stop("bad-input", "Enter a whole number of QU above 0.");
  if (!isCount(input.balanceQu)) return stop("bad-input", "The wallet's QU balance could not be read.");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > MAX_SLIPPAGE_BPS) return stop("bad-input", "The price limit must be between 0% and 10%.");
  const fees = input.transferFeeQu;
  if (!fees || !isCount(fees.qx) || !isCount(fees.qswap)) return stop("bad-input", "The share move fee could not be read.");
  const current = input.currentLiquidity ?? 0;
  if (!isCount(current)) return stop("bad-input", "The current position could not be read.");
  const problem = poolProblem(pool, sym);
  if (problem) return stop(problem.code, problem.message);

  const rQu = big(pool.reserveQu);
  const rAsset = big(pool.reserveAsset);
  const total = big(pool.totalLiquidity);
  const s = big(input.slippageBps);
  const price = pool.reserveQu / pool.reserveAsset;

  // The tokens the contract's own formula pairs with this much QU (quoteEquivalentAmountB, L1106).
  const a = quoteEquivalent(big(input.quAmount), rQu, rAsset);
  if (a < 0n || a > big(Number.MAX_SAFE_INTEGER)) return stop("too-large", "That amount is larger than the contract can work with.");
  if (a < 1n)
    return stop("too-small", `That is less than one ${sym}'s worth (${money(Math.ceil(price))} QU each at the pool's price). A deposit must include at least 1 ${sym}.`);
  const lim = quLimits(a, rQu, rAsset, s);
  if (lim.max + big(LIQUIDITY_FEE_QU) > MAX_AMOUNT || lim.max > I64_MAX) return stop("too-large", "That amount is larger than one transaction can carry.");
  plan.assetAmount = Number(a);
  plan.expectedQu = Number(lim.expected);
  plan.maxQu = Number(lim.max);
  plan.minQu = Number(lim.min);
  const roughValue = plan.expectedQu + plan.assetAmount * price;
  if (roughValue < 2 * LIQUIDITY_FEE_QU)
    return stop("fees-exceed-deposit", `Adding and later removing liquidity cost 100,000 QU each, more than this whole deposit (about ${money(roughValue)} QU). Deposit more.`);

  if (!tokenSideAtPlannedPrice(a, rQu, rAsset, s)) {
    const need = minTokensForSlippage(pool, input.slippageBps);
    const room = minSlippageBpsFor(pool, Number(a));
    const orRoom = room === null ? "" : ` For this amount, a limit of ${(room / 100).toFixed(2)}% would work.`;
    const tail =
      need === null
        ? `Allow some price movement (the limit cannot be 0%).${orRoom}`
        : `Deposit at least ${money(need)} ${sym} (about ${money(Math.ceil(need * price))} QU), or allow more price movement.${orRoom}`;
    return stop(
      "too-small-for-slippage",
      `One ${sym} is worth about ${money(Math.round(price))} QU, more than this deposit's ${(input.slippageBps / 100).toFixed(2)}% price room. QSwap would then take all the QU for a rounded-down number of tokens and keep the difference, and a falling price would not stop it. ${tail}`,
    );
  }

  const call: AddCall = { amountQu: plan.maxQu + LIQUIDITY_FEE_QU, assetAmountDesired: plan.assetAmount, quAmountMin: plan.minQu, assetAmountMin: plan.assetAmount };
  const at = predictAdd(pool, call);
  // By construction the token-side path, with exactly the planned amounts. Anything else means the arithmetic above is off: refuse.
  if (!at.ok) return stop(at.code === "zero-liquidity" ? "zero-liquidity" : "bad-input", at.code === "zero-liquidity" ? `That deposit is too small to earn even one liquidity unit in this pool (one unit is worth about ${money(Math.ceil((2 * pool.reserveQu) / pool.totalLiquidity))} QU). QSwap would refund it; deposit more.` : `The deposit would be refused by QSwap (${at.code}).`);
  if (at.path !== "token-side" || at.assetUsed !== plan.assetAmount || at.quUsed !== plan.expectedQu)
    return stop("bad-input", "The deposit did not plan out as expected, so nothing is offered for signing.");
  plan.expectedLiquidity = at.liquidity;
  const after = at.poolAfter;
  const mine = current + at.liquidity;
  plan.shareAfterPct = (mine / after.totalLiquidity) * 100;
  const priceAfter = after.reserveQu / after.reserveAsset;
  plan.depositValueQu = plan.expectedQu + plan.assetAmount * priceAfter;
  plan.liquidityValueQu = (2 * at.liquidity * after.reserveQu) / after.totalLiquidity;
  plan.roundingLossQu = Math.max(0, plan.depositValueQu - plan.liquidityValueQu);
  // The QU-side path can only start above Qmax / (a + 1) per token; there it puts in all of Qmax for `a` tokens.
  plan.worstRoundingQu = Number(ceilDiv(lim.max, a + 1n));

  if (plan.roundingLossQu > plan.depositValueQu * MAX_ROUNDING_SHARE)
    return stop(
      "rounding",
      `This pool's liquidity units are worth about ${money(Math.ceil((2 * pool.reserveQu) / pool.totalLiquidity))} QU each and are whole numbers, so ${money(Math.ceil(plan.roundingLossQu))} QU of this deposit would be lost to rounding. Deposit more.`,
    );
  // Tokens: QSwap only takes shares it manages (L1166). Move any shortfall from QX first.
  const underQswap = input.holdings[QSWAP_INDEX] ?? 0;
  const underQx = input.holdings[QX_INDEX] ?? 0;
  if (!isCount(underQswap) || !isCount(underQx)) return stop("bad-input", `The wallet's ${sym} could not be read.`);
  const shortfall = Math.max(0, plan.assetAmount - underQswap);
  if (shortfall > underQx)
    return stop(
      "insufficient-asset",
      `This needs ${money(plan.assetAmount)} ${sym}; the wallet has ${money(underQswap + underQx)} ${sym} that QX or QSwap can use${underQx + underQswap > 0 ? " (shares in your open QX sell orders are not counted)" : ""}.`,
    );
  const steps: LiquidityStep[] = [];
  if (shortfall > 0) {
    const move = rightsStep({ symbol: sym, issuer: asset.issuer, assetName: asset.assetName, qty: shortfall, from: QX_INDEX, to: QSWAP_INDEX, fees, reason: "so QSwap can take them into the pool" });
    steps.push({ ...move, kind: "transfer-rights" });
    plan.moveQty = shortfall;
    plan.moveAttachQu = move.amountQu;
  }
  steps.push(addLiquidityStep(asset, call, plan.expectedQu));
  plan.maxOutlayQu = steps.reduce((t, x) => t + x.amountQu, 0);
  if (plan.maxOutlayQu > input.balanceQu)
    return stop(
      "insufficient-qu",
      `This needs up to ${money(plan.maxOutlayQu)} QU in the wallet (${money(plan.maxQu)} QU for the pool at most, the 100,000 QU fee${plan.moveAttachQu ? `, ${money(plan.moveAttachQu)} QU for the share move` : ""}); the wallet has ${money(input.balanceQu)} QU.`,
    );

  plan.ok = true;
  plan.call = call;
  plan.steps = steps;
  plan.expectedRefundQu = at.refundQu + plan.moveAttachQu;
  plan.expectedSpendQu = plan.expectedQu + LIQUIDITY_FEE_QU;
  plan.refunds = [
    `At today's price QSwap uses ${money(plan.expectedQu)} QU and sends back the other ${money(at.refundQu)} QU in the same transaction.`,
    `If the price moves past your ${(input.slippageBps / 100).toFixed(2)}% limit either way, QSwap refuses the deposit and sends back everything, the 100,000 QU fee included (Qswap.h L1123, L1150).`,
  ];
  if (plan.moveAttachQu) plan.refunds.push(`The share move attaches ${money(plan.moveAttachQu)} QU, which QX sends straight back: moving shares to QSwap costs nothing.`);
  const roundTrip = 2 * LIQUIDITY_FEE_QU;
  if (roundTrip > plan.depositValueQu * WARN_FEE_SHARE)
    plan.warnings.push(`Adding and removing cost 100,000 QU each: ${money(roundTrip)} QU, ${((roundTrip / plan.depositValueQu) * 100).toFixed(1)}% of this deposit. The pool's fees have to earn that back first.`);
  if (plan.roundingLossQu > plan.depositValueQu * WARN_ROUNDING_SHARE)
    plan.warnings.push(`About ${money(Math.ceil(plan.roundingLossQu))} QU is lost to rounding: liquidity units are whole numbers.`);
  // A deposit that is a large part of the pool is made at a price that small trades set: the limit only protects against
  // moves away from the price shown, not against that price itself being off (QVERSAL's pool held 129,242 QU on 2026-10-04).
  const partOfPool = plan.expectedQu / (pool.reserveQu + plan.expectedQu);
  if (partOfPool > THIN_POOL_SHARE)
    plan.warnings.push(
      `This deposit would be ${Math.round(partOfPool * 100)}% of the ${sym} pool. In a pool this small one trade moves the price a lot, and you deposit at whatever price it shows; your limit only guards against moves after this. Compare the price with QX first.`,
    );
  if (plan.worstRoundingQu > plan.depositValueQu * WARN_ROUNDING_SHARE)
    plan.warnings.push(
      `If ${sym}'s price rises before this lands (inside your limit), QSwap may take all ${money(plan.maxQu)} QU for the same ${money(plan.assetAmount)} ${sym}; up to about ${money(plan.worstRoundingQu)} QU of that would go to the pool, not to your share.`,
    );
  return plan;
}

/**
 * The largest QU amount `planAddLiquidity` can take for this wallet: as many tokens as it holds under QX and QSwap, and no more
 * QU attached than it holds, fees and the share move included. Null when even the smallest deposit does not fit or works.
 */
export function maxAddQu(input: Omit<AddPlanInput, "quAmount">): number | null {
  const pool = input.pool;
  if (poolProblem(pool, input.asset.symbol) || !isCount(input.balanceQu)) return null;
  const rQu = big(pool.reserveQu);
  const rAsset = big(pool.reserveAsset);
  const s = big(Math.max(0, Math.min(MAX_SLIPPAGE_BPS, Math.floor(input.slippageBps))));
  const underQswap = input.holdings[QSWAP_INDEX] ?? 0;
  const tokens = big(underQswap + (input.holdings[QX_INDEX] ?? 0));
  const attach = (a: bigint) => quLimits(a, rQu, rAsset, s).max + big(LIQUIDITY_FEE_QU) + (a > big(underQswap) ? big(input.transferFeeQu.qswap) : 0n);
  // The most tokens whose attachment fits the balance (attach grows with a), capped by what the wallet holds.
  let lo = 0n;
  let hi = tokens;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (attach(mid) <= big(input.balanceQu)) lo = mid;
    else hi = mid - 1n;
  }
  // The largest QU amount the contract pairs with at most `lo` tokens: floor(q x rAsset / rQu) <= lo.
  for (let a = lo; a >= 1n && lo - a < 4n; a--) {
    const q = ceilDiv((a + 1n) * rQu, rAsset) - 1n;
    if (q < 1n) break;
    const n = safe(q);
    if (n !== null && planAddLiquidity({ ...input, quAmount: n }).ok) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Planning a removal

export interface RemovePlanInput {
  asset: AssetRef;
  pool: PoolState;
  /** The wallet's liquidity in this pool (GetLiquidityOf). */
  liquidity: number;
  /** Either a percentage of the position (1-100) or an exact number of liquidity units. */
  amount: { percent: number } | { units: number };
  balanceQu: number;
  slippageBps: number;
}

export interface RemovePlan {
  ok: boolean;
  refusal: Refusal | null;
  asset: AssetRef;
  pool: PoolState;
  slippageBps: number;
  priceQu: number | null;
  /** Units asked for. */
  requestedLiquidity: number;
  /** Units burned: the request, or a little less when that pays the same whole number of tokens (the rest stays in the position). */
  burnLiquidity: number;
  /** True when the whole position is removed. */
  all: boolean;
  /** Paid at the planned reserves, before the fee. */
  expectedQu: number;
  expectedAsset: number;
  /** The call's minimums: past them (the price moved) QSwap refuses and refunds the fee. */
  minQu: number;
  minAsset: number;
  feeQu: number;
  /** Share of the pool before and after, in percent. */
  shareBeforePct: number;
  shareAfterPct: number;
  /** Lost to rounding at the planned reserves (QU plus token fractions at the pool's price). */
  roundingLossQu: number;
  /** The QU change in the wallet at the planned reserves: expectedQu less the fee. */
  netQu: number;
  call: RemoveCall | null;
  steps: LiquidityStep[];
  maxOutlayQu: number;
  refunds: string[];
  warnings: string[];
}

/**
 * Plans burning some of the wallet's liquidity. Pure. The tokens come back managed by QSwap. A refused plan has a plain reason
 * and no steps.
 */
export function planRemoveLiquidity(input: RemovePlanInput): RemovePlan {
  const { asset, pool } = input;
  const sym = asset.symbol;
  const plan: RemovePlan = {
    ok: false,
    refusal: null,
    asset,
    pool,
    slippageBps: input.slippageBps,
    priceQu: poolPriceQu(pool),
    requestedLiquidity: 0,
    burnLiquidity: 0,
    all: false,
    expectedQu: 0,
    expectedAsset: 0,
    minQu: 0,
    minAsset: 0,
    feeQu: LIQUIDITY_FEE_QU,
    shareBeforePct: 0,
    shareAfterPct: 0,
    roundingLossQu: 0,
    netQu: 0,
    call: null,
    steps: [],
    maxOutlayQu: 0,
    refunds: [],
    warnings: [],
  };
  const stop = (code: LiquidityRefusalCode, message: string) => {
    plan.ok = false;
    plan.refusal = { code, message };
    plan.steps = [];
    plan.call = null;
    plan.maxOutlayQu = 0;
    return plan;
  };
  if (!isCount(input.balanceQu)) return stop("bad-input", "The wallet's QU balance could not be read.");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > MAX_SLIPPAGE_BPS) return stop("bad-input", "The price limit must be between 0% and 10%.");
  if (!isCount(input.liquidity)) return stop("bad-input", "Your position could not be read.");
  const problem = poolProblem(pool, sym);
  if (problem) return stop(problem.code, problem.message);
  if (input.liquidity === 0) return stop("no-position", `You have no liquidity in the ${sym} pool.`);
  if (input.liquidity > pool.totalLiquidity) return stop("bad-input", "Your position reads larger than the whole pool; read it again.");

  let requested: number;
  if ("percent" in input.amount) {
    const pct = input.amount.percent;
    if (!(typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct <= 100)) return stop("bad-input", "Choose a share between 1% and 100%.");
    requested = pct === 100 ? input.liquidity : Number((big(input.liquidity) * big(Math.round(pct * 100))) / 10_000n);
  } else {
    requested = input.amount.units;
    if (!isCount(requested) || requested <= 0) return stop("bad-input", "Enter a whole number of liquidity units above 0.");
  }
  if (requested > input.liquidity) return stop("more-than-owned", `You have ${money(input.liquidity)} liquidity units in this pool; you cannot remove ${money(requested)}.`);
  if (requested < 1) return stop("zero-payout", "That share of your position is less than one liquidity unit.");
  plan.requestedLiquidity = requested;
  plan.all = requested === input.liquidity;

  const rQu = big(pool.reserveQu);
  const rAsset = big(pool.reserveAsset);
  const total = big(pool.totalLiquidity);
  let burn = big(requested);
  const tokensFor = (l: bigint) => div(l * rAsset, total);
  if (!plan.all) {
    // Burn the least liquidity that still pays the same whole number of tokens: the fraction would otherwise stay in the pool.
    const tokens = tokensFor(burn);
    if (tokens >= 1n) {
      const least = ceilDiv(tokens * total, rAsset);
      if (least >= 1n && least < burn && tokensFor(least) === tokens) burn = least;
    }
  }
  plan.burnLiquidity = Number(burn);
  const qu = div(burn * rQu, total);
  const tokens = tokensFor(burn);
  plan.expectedQu = Number(qu);
  plan.expectedAsset = Number(tokens);
  const price = pool.reserveQu / pool.reserveAsset;
  plan.roundingLossQu = Math.max(0, (Number(burn) * pool.reserveQu) / pool.totalLiquidity - plan.expectedQu + ((Number(burn) * pool.reserveAsset) / pool.totalLiquidity - plan.expectedAsset) * price);
  plan.shareBeforePct = (input.liquidity / pool.totalLiquidity) * 100;
  plan.shareAfterPct = ((input.liquidity - plan.burnLiquidity) / (pool.totalLiquidity - plan.burnLiquidity)) * 100;
  const valueOut = plan.expectedQu + plan.expectedAsset * price;

  if (qu < 1n || (tokens < 1n && !plan.all)) {
    const need = Math.ceil(pool.totalLiquidity / (qu < 1n ? pool.reserveQu : pool.reserveAsset));
    const what = qu < 1n ? "no QU" : `no ${sym}`;
    return stop(
      "zero-payout",
      plan.all
        ? `Your whole position pays ${money(plan.expectedQu)} QU and ${money(plan.expectedAsset)} ${sym}: QSwap rounds down, so it would keep the 100,000 QU fee for ${what}.`
        : `Removing ${money(plan.burnLiquidity)} units pays ${money(plan.expectedQu)} QU and ${money(plan.expectedAsset)} ${sym}: QSwap rounds down and would keep the 100,000 QU fee for ${what}. ${need >= input.liquidity ? "Remove all of it instead." : `Remove at least ${money(need)} units.`}`,
    );
  }
  if (valueOut < LIQUIDITY_FEE_QU)
    return stop("fees-exceed-removal", `This pays back about ${money(valueOut)} QU in value and removing costs a flat 100,000 QU, so removing would cost you more than it returns. QMax does not offer it. The position stays in the pool and keeps earning fees; it becomes worth removing once it is worth clearly more than the fee, for example after it grows or if you add to it.`);
  if (!plan.all && plan.roundingLossQu > valueOut * MAX_ROUNDING_SHARE)
    return stop("rounding", `About ${money(Math.ceil(plan.roundingLossQu))} QU of this would be lost to rounding (QSwap pays whole ${sym} only). Remove a larger share.`);
  if (input.balanceQu < LIQUIDITY_FEE_QU)
    return stop("fee-unaffordable", `Removing costs a flat 100,000 QU, paid from the wallet before anything comes back; the wallet has ${money(input.balanceQu)} QU.`);

  // Minimums at least 1 on each side that pays anything, so a price move refuses (fee refunded) rather than pay nothing.
  const s = big(input.slippageBps);
  const floorMin = (x: bigint) => {
    const m = div(x * (BPS - s), BPS);
    return x >= 1n && m < 1n ? 1n : m;
  };
  plan.minQu = Number(floorMin(qu));
  plan.minAsset = Number(floorMin(tokens));
  const call: RemoveCall = { amountQu: LIQUIDITY_FEE_QU, burnLiquidity: plan.burnLiquidity, quAmountMin: plan.minQu, assetAmountMin: plan.minAsset };
  const at = predictRemove(pool, call, input.liquidity);
  if (!at.ok || at.quOut !== plan.expectedQu || at.assetOut !== plan.expectedAsset) return stop("bad-input", "The removal did not plan out as expected, so nothing is offered for signing.");

  plan.ok = true;
  plan.call = call;
  plan.steps = [removeLiquidityStep(asset, call)];
  plan.maxOutlayQu = LIQUIDITY_FEE_QU;
  plan.netQu = plan.expectedQu - LIQUIDITY_FEE_QU;
  plan.refunds = [
    `If the price moves past your ${(input.slippageBps / 100).toFixed(2)}% limit, QSwap refuses and sends the 100,000 QU fee back (Qswap.h L1452). Your liquidity stays where it is.`,
  ];
  if (burn < big(requested))
    plan.warnings.push(`It burns ${money(plan.burnLiquidity)} units instead of ${money(requested)}: that pays the same ${money(plan.expectedAsset)} ${sym}, and the other ${money(requested - plan.burnLiquidity)} units stay in your position instead of being lost to rounding.`);
  // What stays behind must still be worth taking out: below the flat fee, removing it later pays back less than it costs
  // (and this planner refuses that removal), so the rest would be stuck in the pool.
  const left = input.liquidity - plan.burnLiquidity;
  if (left > 0) {
    const rest = positionValue(at.poolAfter, left);
    if (rest.valueQu < LIQUIDITY_FEE_QU)
      plan.warnings.push(
        `The ${money(left)} units you keep would be worth only about ${money(rest.valueQu)} QU, less than the 100,000 QU fee to remove them later, so taking them out would never pay. Remove all of it now instead.`,
      );
  }
  if (plan.all && tokens < 1n)
    plan.warnings.push(`Your whole position is worth less than one ${sym} on the token side, so it pays only QU; the token fraction (about ${money(Math.ceil(plan.roundingLossQu))} QU) stays in the pool.`);
  else if (plan.roundingLossQu > valueOut * WARN_ROUNDING_SHARE)
    plan.warnings.push(`About ${money(Math.ceil(plan.roundingLossQu))} QU stays in the pool as rounding: QSwap pays whole ${sym} only.`);
  plan.warnings.push(`The ${sym} comes back managed by QSwap. To sell it on QX it needs a share move first (QMax does that for you when you sell).`);
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// The moment before signing

/**
 * `quSide` (deposits only): at the fresh price QSwap would take the QU-side path, i.e. ALL of the attached QU for the same
 * tokens, the part above the pool's ratio going to the other liquidity providers. The contract accepts that, but nothing is
 * gained by signing it: the same deposit planned again at the new price takes the token-side path. Callers stop on it.
 */
export type Recheck = { ok: true; warnings: string[]; quSide?: boolean } | { ok: false; reason: string };

/**
 * Checks a reviewed deposit against a FRESH read of the pool right before signing, without changing it: the same call must
 * still go through, for the same tokens, inside the reviewed QU limits. Refuses with a reason otherwise.
 */
export function recheckAdd(plan: AddPlan, fresh: PoolState): Recheck {
  if (!plan.ok || !plan.call) return { ok: false, reason: plan.refusal?.message ?? "This deposit was not ready to sign." };
  const problem = poolProblem(fresh, plan.asset.symbol);
  if (problem) return { ok: false, reason: problem.message };
  const p = predictAdd(fresh, plan.call);
  const before = poolPriceQu(plan.pool) ?? 0;
  const now = poolPriceQu(fresh) ?? 0;
  const move = before > 0 ? ((now / before - 1) * 100).toFixed(2) : "?";
  if (!p.ok) {
    if (p.code === "asset-min" || p.code === "qu-min")
      return {
        ok: false,
        reason: `${plan.asset.symbol}'s pool price moved ${move}% since you reviewed this (now about ${money(Math.round(now))} QU), past your ${(plan.slippageBps / 100).toFixed(2)}% limit. QSwap would refuse it, so it was not sent. Review it again at the new price.`,
      };
    if (p.code === "zero-liquidity") return { ok: false, reason: "At the pool's new state this deposit would not earn a liquidity unit, so it was not sent." };
    return { ok: false, reason: `QSwap would refuse this deposit now (${p.code}), so it was not sent.` };
  }
  if (p.assetUsed !== plan.assetAmount || p.quUsed > plan.maxQu || p.liquidity < 1) return { ok: false, reason: "The pool changed in a way the reviewed deposit does not cover, so it was not sent." };
  const warnings: string[] = [];
  if (p.path === "qu-side")
    warnings.push(`The price rose ${move}% (inside your limit): QSwap will take all ${money(plan.maxQu)} QU for the ${money(plan.assetAmount)} ${plan.asset.symbol}, and the part above the pool's ratio goes to the pool.`);
  else if (p.quUsed !== plan.expectedQu) warnings.push(`The price moved ${move}% (inside your limit): about ${money(p.quUsed)} QU will go in instead of ${money(plan.expectedQu)}.`);
  return { ok: true, warnings, quSide: p.path === "qu-side" };
}

/** The same for a removal: a fresh pool and a fresh read of the wallet's liquidity. */
export function recheckRemove(plan: RemovePlan, fresh: PoolState, freshLiquidity: number): Recheck {
  if (!plan.ok || !plan.call) return { ok: false, reason: plan.refusal?.message ?? "This removal was not ready to sign." };
  const problem = poolProblem(fresh, plan.asset.symbol);
  if (problem) return { ok: false, reason: problem.message };
  if (freshLiquidity < plan.call.burnLiquidity) return { ok: false, reason: `Your position is now ${money(freshLiquidity)} units, less than the ${money(plan.call.burnLiquidity)} this removes. Nothing was sent.` };
  const p = predictRemove(fresh, plan.call, freshLiquidity);
  if (!p.ok) {
    const before = poolPriceQu(plan.pool) ?? 0;
    const now = poolPriceQu(fresh) ?? 0;
    return {
      ok: false,
      reason:
        p.code === "mins"
          ? `${plan.asset.symbol}'s pool price moved ${before > 0 ? ((now / before - 1) * 100).toFixed(2) : "?"}% since you reviewed this, past your ${(plan.slippageBps / 100).toFixed(2)}% limit. QSwap would refuse it, so it was not sent.`
          : `QSwap would refuse this removal now (${p.code}), so it was not sent.`,
    };
  }
  const warnings: string[] = [];
  if (p.quOut !== plan.expectedQu || p.assetOut !== plan.expectedAsset)
    warnings.push(`The pool moved (inside your limit): it now pays about ${money(p.quOut)} QU and ${money(p.assetOut)} ${plan.asset.symbol}.`);
  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// After the run: what to tell the person

/**
 * What became of one transaction of a run: never broadcast (the run stopped before it, or the wallet declined to sign),
 * broadcast but not seen in a processed tick, or included in one (which says nothing yet about what the contract did).
 */
export type TxFate = "not-sent" | "unconfirmed" | "included";

export interface RunFacts {
  mode: "add" | "remove";
  symbol: string;
  /** The AddLiquidity or RemoveLiquidity transaction. */
  liquidityTx: TxFate;
  /** The share move before a deposit, when the plan had one. */
  moveTx?: TxFate;
  /** Read back from the wallet and the contract, after against before. */
  dLiquidity: number;
  dQu: number;
  underQswapBefore: number;
  underQswapAfter: number;
}

/**
 * The plain notes for a run that changed no liquidity, chosen from what was really SENT, so the page never says QSwap refused
 * (and refunded) something that never reached it, or that shares moved when they did not. `quCaption` explains the QU line.
 */
export function noChangeNotes(f: RunFacts): { quCaption: string; notes: string[] } {
  const sym = f.symbol;
  const what = f.mode === "add" ? "deposit" : "removal";
  const notes: string[] = [];
  let quCaption: string;
  if (f.liquidityTx === "not-sent") {
    quCaption = "nothing was charged";
    notes.push(
      f.mode === "add"
        ? "The deposit was never sent (the run stopped before it), so QSwap took nothing and you still have all your QU and " + sym + "."
        : "The removal was never sent (the run stopped before it), so no fee was paid and your liquidity is where it was.",
    );
  } else if (f.liquidityTx === "unconfirmed") {
    quCaption = "not settled yet";
    notes.push(
      `The ${what} was broadcast but QMax did not see it confirmed in time. If it lands it ${f.mode === "add" ? "either adds liquidity or is refunded in full" : "either pays out or refunds the fee"}; check it on the explorer (link above) before trying again.`,
    );
  } else if (f.dQu === 0) {
    quCaption = f.mode === "add" ? "unchanged means QSwap refunded it all" : "unchanged means the fee came back";
    notes.push(
      f.mode === "add"
        ? "Your QU is back where it was: QSwap refused the deposit and refunded everything, its fee included (usually because the price moved past your limit before it landed)."
        : "QSwap refused the removal (usually because the price moved past your limit) and sent the fee back. Your liquidity is where it was.",
    );
  } else {
    quCaption = "changed, but no liquidity moved";
    notes.push(`Your QU changed by ${f.dQu > 0 ? "+" : "−"}${money(Math.abs(f.dQu))} QU although no liquidity ${f.mode === "add" ? "was added" : "was removed"}: other activity in the wallet, or a balance that has not caught up yet. Check the explorer before trying again.`);
  }
  if (f.mode === "add" && f.moveTx && f.moveTx !== "not-sent") {
    const moved = f.underQswapAfter - f.underQswapBefore;
    if (moved > 0)
      notes.push(`${money(moved)} ${sym} moved from QX to QSwap's management and stay there; the move cost nothing. To sell them on QX they need a share move back (QMax does that for you when you sell).`);
    else if (f.moveTx === "included")
      notes.push(`The share move did not change which contract manages your ${sym} (QX moves nothing while shares are offered in your own open sell orders).`);
    else notes.push(`The share move was broadcast but not confirmed; check it on the explorer.`);
  }
  return { quCaption, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP

export interface LiquidityPoolRef {
  id: string;
  symbol: string;
  issuer: string;
  assetName: string;
}

export interface LiquidityDeps {
  /** One contract function call (QubicRpc.query). */
  query(contractIndex: number, functionId: number, input: Uint8Array): Promise<Uint8Array>;
  /** The assets that have a QSwap pool. */
  pools(): LiquidityPoolRef[];
}

export interface LiquidityPosition {
  asset: string;
  symbol: string;
  issuer: string;
  assetName: string;
  liquidity: number;
  totalLiquidity: number;
  reserveQu: number;
  reserveAsset: number;
  priceQu: number | null;
  sharePct: number;
  /** What removing all of it pays before the 100,000 QU fee (rounded down as QSwap does). */
  quOut: number;
  assetOut: number;
  /** quOut + assetOut x pool price. */
  valueQu: number;
  /** GetLiquidityOf's earnedFees. Already inside quOut/assetOut: nothing pays it separately. */
  earnedFeesQu: number;
}

export interface PositionsResponse {
  identity: string;
  positions: LiquidityPosition[];
  /** Pools read, and pools that could not be read (their positions, if any, are missing). */
  poolsChecked: number;
  failed: { asset: string; error: string }[];
  complete: boolean;
  readAt: string;
  note: string;
}

export interface PoolResponse extends PoolState {
  asset: string;
  symbol: string;
  issuer: string;
  assetName: string;
  priceQu: number | null;
  lockedLiquidity: number;
  flatFeeQu: number;
  readAt: string;
  note: string;
}

export const POSITIONS_NOTE =
  "Read live from the QSwap contract (GetLiquidityOf, GetPoolBasicState). valueQu = quOut + assetOut x (reserveQu / reserveAsset), where quOut = floor(liquidity x reserveQu / totalLiquidity) and assetOut = floor(liquidity x reserveAsset / totalLiquidity) are what removing everything pays before QSwap's flat 100,000 QU fee; the tokens are valued at the pool's own price, an estimate. earnedFees is the contract's own figure: the fees are already inside what you get when you remove, nothing pays them separately.";
const POOL_NOTE = "Read live from QSwap's GetPoolBasicState. totalLiquidity includes the 1,000 units locked to the contract when the pool was created. Adding and removing liquidity each cost a flat 100,000 QU.";

const IDENTITY = /^[A-Z]{60}$/;

/**
 * The positions and pool endpoints. Contract reads are spaced to at most `maxRps` per second (default 3) across all callers,
 * pools are cached for `poolCacheMs` and a wallet's positions for `positionsCacheMs`, a scan reads at most `maxPools` pools, and
 * at most `maxScans` different wallets are scanned at once (more get a 503 asking to retry). `fresh=1` (asked for right after
 * the wallet added or removed liquidity) skips a cached answer older than `minFreshMs`, so it cannot be used to force a scan on
 * every request.
 */
export function liquidityRoutes(
  deps: LiquidityDeps,
  opts: { maxRps?: number; poolCacheMs?: number; positionsCacheMs?: number; minFreshMs?: number; maxPools?: number; maxScans?: number; now?: () => number } = {},
): Route[] {
  const clock = opts.now ?? Date.now;
  const gapMs = 1000 / (opts.maxRps ?? 3);
  const poolCacheMs = opts.poolCacheMs ?? 10_000;
  const positionsCacheMs = opts.positionsCacheMs ?? 30_000;
  const minFreshMs = opts.minFreshMs ?? 5_000;
  const maxPools = opts.maxPools ?? 64;
  const maxScans = opts.maxScans ?? 3;

  // One queue for every read this module makes, so a scan of 16 pools cannot burst.
  let nextAt = 0;
  const spaced = async (contractIndex: number, fn: number, input: Uint8Array) => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    return deps.query(contractIndex, fn, input);
  };

  const poolCache = new Map<string, { at: number; state: Promise<PoolState> }>();
  const poolOf = (p: LiquidityPoolRef) => {
    const hit = poolCache.get(p.id);
    if (hit && clock() - hit.at < poolCacheMs) return hit.state;
    const state = readPool(spaced, p);
    poolCache.set(p.id, { at: clock(), state });
    state.catch(() => poolCache.delete(p.id));
    return state;
  };

  const positionsCache = new Map<string, { at: number; result: Promise<PositionsResponse> }>();
  let scanning = 0;
  const scan = async (identity: string): Promise<PositionsResponse> => {
    const pools = deps.pools().slice(0, maxPools);
    const positions: LiquidityPosition[] = [];
    const failed: { asset: string; error: string }[] = [];
    for (const p of pools) {
      try {
        const mine = await readLiquidity(spaced, p, identity);
        if (mine.liquidity <= 0) continue;
        const pool = await poolOf(p);
        const v = positionValue(pool, mine.liquidity);
        positions.push({
          asset: p.id,
          symbol: p.symbol,
          issuer: p.issuer,
          assetName: p.assetName,
          liquidity: mine.liquidity,
          totalLiquidity: pool.totalLiquidity,
          reserveQu: pool.reserveQu,
          reserveAsset: pool.reserveAsset,
          priceQu: poolPriceQu(pool),
          sharePct: v.sharePct,
          quOut: v.quOut,
          assetOut: v.assetOut,
          valueQu: v.valueQu,
          earnedFeesQu: mine.earnedFeesQu,
        });
      } catch (e) {
        failed.push({ asset: p.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    positions.sort((a, b) => b.valueQu - a.valueQu);
    return { identity, positions, poolsChecked: pools.length, failed, complete: failed.length === 0, readAt: new Date(clock()).toISOString(), note: POSITIONS_NOTE };
  };

  const findPool = (id: string) => {
    const all = deps.pools();
    return all.find((p) => p.id === id) ?? all.find((p) => p.id.toLowerCase() === id.toLowerCase()) ?? null;
  };

  return [
    {
      method: "GET",
      path: "/v1/liquidity/positions",
      // A scan is up to 64 contract reads: per address, a few a minute (the app asks once when the page opens and once after each change).
      limited: false,
      rate: { perMin: 10 },
      doc: {
        summary: "A wallet's QSwap liquidity positions",
        description: `Every QSwap pool the wallet has liquidity in: its units, share of the pool, what removing it all would pay and its value in QU. ${POSITIONS_NOTE} Cached for ${positionsCacheMs / 1000} seconds per wallet.`,
        parameters: [
          { name: "identity", in: "query", required: true, schema: { type: "string" }, description: "The wallet's 60-letter identity." },
          { name: "fresh", in: "query", required: false, schema: { type: "string", enum: ["1"] }, description: `1 to skip a cached answer older than ${minFreshMs / 1000} seconds (after adding or removing liquidity).` },
        ],
        responses: { "200": { description: "The positions (complete is false when a pool could not be read)." }, "400": { description: "Not a Qubic identity." }, "503": { description: "Too many wallets being read at once; retry shortly." } },
      },
      handler: async ({ query }) => {
        const identity = required(query, "identity");
        if (!IDENTITY.test(identity)) throw new RouteError(400, "identity must be a 60-letter Qubic identity (A-Z)");
        // Only the first 56 letters are the wallet (the last four are a checksum), so every spelling shares one cache entry and one scan.
        const wallet = identity.slice(0, 56);
        const hit = positionsCache.get(wallet);
        if (hit && clock() - hit.at < (query.get("fresh") === "1" ? minFreshMs : positionsCacheMs)) return hit.result;
        if (scanning >= maxScans) throw new RouteError(503, "Busy reading other wallets' positions; try again in a few seconds.", { retryAfterSec: 10 });
        scanning++;
        const result = scan(identity).finally(() => scanning--);
        positionsCache.set(wallet, { at: clock(), result });
        result.catch(() => positionsCache.delete(wallet));
        // Keep the cache bounded: drop the oldest entries past 500 wallets.
        if (positionsCache.size > 500) for (const k of [...positionsCache.keys()].slice(0, positionsCache.size - 500)) positionsCache.delete(k);
        return result;
      },
    },
    {
      method: "GET",
      path: "/v1/liquidity/pool",
      doc: {
        summary: "One QSwap pool's live state, for adding or removing liquidity",
        description: `${POOL_NOTE} Cached for ${poolCacheMs / 1000} seconds; read the contract directly right before signing.`,
        parameters: [{ name: "asset", in: "query", required: true, schema: { type: "string" }, description: "The asset id, as in /v1/assets." }],
        responses: { "200": { description: "The pool's reserves and total liquidity." }, "400": { description: "asset is missing." }, "404": { description: "That asset has no QSwap pool." } },
      },
      handler: async ({ query }): Promise<PoolResponse> => {
        const id = required(query, "asset");
        const p = findPool(id);
        if (!p) throw new RouteError(404, `No QSwap pool for '${id}'`);
        const state = await poolOf(p);
        return {
          asset: p.id,
          symbol: p.symbol,
          issuer: p.issuer,
          assetName: p.assetName,
          ...state,
          priceQu: poolPriceQu(state),
          lockedLiquidity: QSWAP_MIN_LIQUIDITY,
          flatFeeQu: LIQUIDITY_FEE_QU,
          readAt: new Date(clock()).toISOString(),
          note: POOL_NOTE,
        };
      },
    },
  ];
}
