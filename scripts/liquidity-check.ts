/**
 * Read-only check of src/liquidity.ts against the live QSwap contract and the archive. Run:
 *   node --experimental-strip-types --no-warnings scripts/liquidity-check.ts [fromTick]
 *
 * 1. Reads every pool (GetPoolBasicState) and the contract's own locked 1,000 units (GetLiquidityOf of QSwap itself).
 * 2. Reads every QSwap event of this epoch (or since `fromTick`) and the AddLiquidity / RemoveLiquidity transactions behind
 *    them, then walks each pool BACKWARDS from its live state through those events. At each step the state before the event
 *    is known exactly, so the script checks that predictAdd / predictRemove (and the swap formulas, as a check on the walk
 *    itself) give exactly what the contract logged.
 * 3. For each real deposit, says which path it took and how much QU went in beyond its tokens' worth (the rounding trap).
 * 4. Reads real liquidity providers' positions (GetLiquidityOf) and values them; plans adds and removes on the real pools.
 * Never signs or sends anything; stays at 2 requests per second.
 */
import { assetNameFromU64, bytesToHex, identityToBytes } from "../src/identity.ts";
import {
  LIQUIDITY_FEE_QU,
  QSWAP_MIN_LIQUIDITY,
  decodeAddLiquidityEvent,
  decodeRemoveLiquidityEvent,
  encodeLiquidityQuery,
  planAddLiquidity,
  planRemoveLiquidity,
  positionValue,
  predictAdd,
  predictRemove,
  readLiquidity,
  readPool,
} from "../src/liquidity.ts";
import type { PoolState } from "../src/liquidity.ts";
import { QubicRpc } from "../src/rpc.ts";

const QSWAP_ID = "NAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAML";
const rpc = new QubicRpc({ maxRps: 2 });
const query = (c: number, f: number, i: Uint8Array) => rpc.query(c, f, i);
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

interface Pool { symbol: string; issuer: string }
async function poolsList(): Promise<Pool[]> {
  try {
    const res = await fetch("http://localhost:8787/v1/assets");
    const body = (await res.json()) as { assets: { symbol: string; issuer: string; venues: string[] }[] };
    const list = body.assets.filter((a) => a.venues.includes("QSwap")).map((a) => ({ symbol: a.symbol, issuer: a.issuer }));
    if (list.length) return list;
  } catch {
    // fall through
  }
  return [
    { symbol: "PORTAL", issuer: "IQUGNVFDQSLTXFJSIOPPNPZINSCDQTJVJWGRPWRTFFXMXSJIAASXOBFFBERK" },
    { symbol: "QCAP", issuer: "QCAPWMYRSHLBJHSTTZQVCIBARVOASKDENASAKNOBRGPFWWKRCUVUAXYEZVOG" },
    { symbol: "CFB", issuer: "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL" },
  ];
}
const keyOf = (issuerHex: string, name: string) => `${name}|${issuerHex}`;

// ---- the archive -------------------------------------------------------------------------------------------------

interface Ev { tickNumber: number; logId: string; transactionHash?: string; rawPayload?: string; smartContractMessage?: { contractMessageType: string } }
interface Tx { hash: string; source: string; amount: string; inputType: number; inputData: string; tickNumber: number; moneyFlew?: boolean }

async function events(from: number, to: number): Promise<Ev[]> {
  const out: Ev[] = [];
  const q = (lo: number, hi: number, offset: number) =>
    rpc.post<{ hits: { total: number }; eventLogs?: Ev[] }>("/query/v1/getEventLogs", {
      filters: { logType: "6", contractIndex: "13" },
      ranges: { tickNumber: { gte: String(lo), lte: String(hi) } },
      pagination: { offset, size: 1000 },
    });
  const read = async (lo: number, hi: number): Promise<void> => {
    const first = await q(lo, hi, 0);
    if (first.hits.total >= 10_000 && hi > lo + 1) {
      const mid = Math.floor((lo + hi) / 2);
      await read(lo, mid);
      await read(mid + 1, hi);
      return;
    }
    out.push(...(first.eventLogs ?? []));
    for (let off = 1000; off < first.hits.total; off += 1000) out.push(...((await q(lo, hi, off)).eventLogs ?? []));
  };
  await read(from, to);
  return out;
}

async function txs(inputType: string, from: number, to: number): Promise<Tx[]> {
  const out: Tx[] = [];
  for (let off = 0; ; off += 1000) {
    const r = await rpc.post<{ hits: { total: number }; transactions: Tx[] }>("/query/v1/getTransactionsForIdentity", {
      identity: QSWAP_ID,
      filters: { destination: QSWAP_ID, inputType },
      ranges: { tickNumber: { gte: String(from), lte: String(to) } },
      pagination: { offset: off, size: 1000 },
    });
    out.push(...r.transactions);
    if (off + 1000 >= r.hits.total) break;
  }
  return out;
}

// ---- the swap formulas (Qswap.h L436-545, L1587-1640, L1734-1797, L1923-2013, L2137-2226), to walk back over swaps -----

const FEE = 30n, BASE = 10_000n;
const parts = (swapFee: bigint) => (swapFee * 27n) / 100n + (swapFee * 5n) / 100n + (swapFee * 3n) / 100n + (swapFee * 1n) / 100n;
const feeOn = (x: bigint, base = BASE) => {
  const f = (x * FEE) / base;
  return f === 0n ? 100n : f;
};

interface S { q: bigint; a: bigint; t: bigint }
type Undo = { ok: boolean; pre: S; detail?: string };

function undoSwap(type: number, x: bigint, y: bigint, post: S): Undo {
  if (type === 6 || type === 7) {
    // x = QU in, y = asset out. Post: q = pre.q + x - totalFee(x); a = pre.a - y.
    const pre = { q: post.q - (x - parts(feeOn(x))), a: post.a + y, t: post.t };
    if (type === 6) {
      const w = x * (BASE - FEE);
      const out = (pre.a * w) / (pre.q * BASE + w);
      return { ok: out === y, pre, detail: `assetOut ${out} vs logged ${y}` };
    }
    const qin = (pre.q * y * BASE) / ((pre.a - y) * (BASE - FEE)) + 1n;
    return { ok: qin === x, pre, detail: `quIn ${qin} vs logged ${x}` };
  }
  if (type === 9) {
    // x = asset in, y = QU out (exact).
    const pre = { q: post.q + y + parts(feeOn(y, BASE - FEE)), a: post.a - x, t: post.t };
    const num = pre.a * y * BASE;
    const den = pre.q * (BASE - FEE) - y * BASE;
    const ain = num / den + 1n;
    return { ok: ain === x, pre, detail: `assetIn ${ain} vs logged ${x}` };
  }
  // type 8: x = asset in, y = QU out = floor(W x 9970 / 10000) with W = floor(pre.q x x / (pre.a + x)) unknown: try the W that fit.
  const preA = post.a - x;
  const w0 = (y * BASE + (BASE - FEE) - 1n) / (BASE - FEE);
  for (let w = w0 - 1n; w <= w0 + 2n; w++) {
    if ((w * (BASE - FEE)) / BASE !== y) continue;
    const preQ = post.q + y + parts(feeOn(w));
    if ((preQ * x) / (preA + x) === w) return { ok: true, pre: { q: preQ, a: preA, t: post.t } };
  }
  return { ok: false, pre: { q: post.q + y + parts(feeOn(w0)), a: preA, t: post.t }, detail: "no gross amount fits" };
}

// ---- main ---------------------------------------------------------------------------------------------------------

const pools = await poolsList();
const t0 = (await rpc.get<{ tickInfo: { tick: number; initialTick: number } }>("/live/v1/tick-info")).tickInfo;
const live = new Map<string, { pool: Pool; state: PoolState }>();
for (const p of pools) live.set(keyOf(bytesToHex(identityToBytes(p.issuer)), p.symbol), { pool: p, state: await readPool(query, { issuer: p.issuer, assetName: p.symbol }) });
const t1 = (await rpc.get<{ tickInfo: { tick: number } }>("/live/v1/tick-info")).tickInfo.tick;
console.log(`Read ${live.size} pools between ticks ${t0.tick} and ${t1}.`);
for (const { pool, state } of live.values()) {
  const v = positionValue(state, QSWAP_MIN_LIQUIDITY);
  console.log(`  ${pool.symbol.padEnd(8)} reserves ${fmt(state.reserveQu)} QU / ${fmt(state.reserveAsset)}  total ${fmt(state.totalLiquidity)} units  price ${(state.reserveQu / state.reserveAsset).toPrecision(6)} QU  one unit ~${(2 * state.reserveQu / state.totalLiquidity).toPrecision(4)} QU  locked 1,000 = ${v.sharePct.toPrecision(3)}%`);
}
const selfKey = new Uint8Array(32);
selfKey[0] = 13;
const sample = [...live.values()][0];
const selfLiq = await rpc.query(13, 3, encodeLiquidityQuery(sample.pool.issuer, sample.pool.symbol, selfKey));
console.log(`QSwap's own liquidity in ${sample.pool.symbol}: ${new DataView(selfLiq.buffer).getBigInt64(0, true)} units (expected ${QSWAP_MIN_LIQUIDITY}).`);

// Wait until the archive has the ticks the pools were read at, then read the epoch's events and liquidity transactions.
let logTick = 0;
for (let i = 0; i < 20; i++) {
  logTick = (await rpc.get<{ logTickNumber: number }>("/query/v1/getLastProcessedTick")).logTickNumber;
  if (logTick >= t1 + 5) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const from = Number(process.argv[2] ?? t0.initialTick);
const evs = await events(from, logTick);
const adds = new Map((await txs("4", from, logTick)).map((t) => [t.hash, t]));
const removes = new Map((await txs("5", from, logTick)).map((t) => [t.hash, t]));
console.log(`\nTicks ${from}-${logTick}: ${evs.length} QSwap events, ${adds.size} AddLiquidity and ${removes.size} RemoveLiquidity transactions.`);

// Group the events by pool, newest first.
const byPool = new Map<string, { ev: Ev; type: number; body: Buffer }[]>();
let unknown = 0;
for (const ev of evs) {
  const type = Number(ev.smartContractMessage?.contractMessageType);
  if (!ev.rawPayload || ![4, 5, 6, 7, 8, 9].includes(type)) continue;
  const body = Buffer.from(ev.rawPayload, "base64");
  let key: string | null = null;
  if (type === 5) {
    const tx = ev.transactionHash ? removes.get(ev.transactionHash) : undefined;
    if (tx) {
      const b = Buffer.from(tx.inputData, "base64");
      key = keyOf(b.subarray(0, 32).toString("hex"), assetNameFromU64(b.readBigUInt64LE(32)));
    }
  } else key = keyOf(body.subarray(0, 32).toString("hex"), assetNameFromU64(body.readBigUInt64LE(32)));
  if (!key) {
    unknown++;
    continue;
  }
  (byPool.get(key) ?? byPool.set(key, []).get(key)!).push({ ev, type, body });
}
if (unknown) console.log(`(${unknown} remove events could not be tied to a transaction and are skipped with their pools.)`);

const tally = { add: [0, 0], remove: [0, 0], swap: [0, 0] };
const deposits: string[] = [];
for (const [key, list] of byPool) {
  const entry = live.get(key);
  if (!entry) continue;
  if (list.some((x) => x.ev.tickNumber >= t0.tick)) {
    console.log(`  ${entry.pool.symbol}: an event landed while the pools were being read; skipped.`);
    continue;
  }
  list.sort((x, y) => y.ev.tickNumber - x.ev.tickNumber || Number(BigInt(y.ev.logId) - BigInt(x.ev.logId)));
  let st: S = { q: BigInt(entry.state.reserveQu), a: BigInt(entry.state.reserveAsset), t: BigInt(entry.state.totalLiquidity) };
  let broken = false;
  for (const { ev, type, body } of list) {
    if (broken) break;
    if (type === 4) {
      const e = decodeAddLiquidityEvent(body)!;
      const first = st.q === BigInt(e.quAmount) && st.a === BigInt(e.assetAmount);
      const pre: S = { q: st.q - BigInt(e.quAmount), a: st.a - BigInt(e.assetAmount), t: st.t - BigInt(e.liquidity) - (first ? 1000n : 0n) };
      const tx = ev.transactionHash ? adds.get(ev.transactionHash) : undefined;
      if (!tx) { console.log(`  ${entry.pool.symbol}: add at tick ${ev.tickNumber} has no transaction; stopping this pool.`); broken = true; continue; }
      const b = Buffer.from(tx.inputData, "base64");
      const call = { amountQu: Number(tx.amount), assetAmountDesired: Number(b.readBigInt64LE(40)), quAmountMin: Number(b.readBigInt64LE(48)), assetAmountMin: Number(b.readBigInt64LE(56)) };
      const pool: PoolState = { exists: true, reserveQu: Number(pre.q), reserveAsset: Number(pre.a), totalLiquidity: Number(pre.t) };
      const p = predictAdd(pool, call);
      const ok = p.ok && p.quUsed === e.quAmount && p.assetUsed === e.assetAmount && p.liquidity === e.liquidity;
      tally.add[ok ? 0 : 1]++;
      if (!ok) console.log(`  MISMATCH add ${entry.pool.symbol} tick ${ev.tickNumber}: logged ${JSON.stringify(e)}, predicted ${JSON.stringify(p)}`);
      if (p.ok && pool.totalLiquidity > 0) {
        const worth = (e.assetAmount * pool.reserveQu) / pool.reserveAsset; // the tokens' worth in QU at the pool's price
        deposits.push(`  ${entry.pool.symbol.padEnd(8)} tick ${ev.tickNumber}  ${p.path.padEnd(10)} ${fmt(e.quAmount)} QU + ${fmt(e.assetAmount)} tokens (worth ${fmt(worth)} QU)  QU beyond the tokens' worth: ${fmt(e.quAmount - worth)}  refund ${fmt(p.refundQu)} QU`);
      }
      st = pre;
    } else if (type === 5) {
      const e = decodeRemoveLiquidityEvent(body)!;
      const tx = removes.get(ev.transactionHash!)!;
      const b = Buffer.from(tx.inputData, "base64");
      const call = { amountQu: Number(tx.amount), burnLiquidity: Number(b.readBigInt64LE(40)), quAmountMin: Number(b.readBigInt64LE(48)), assetAmountMin: Number(b.readBigInt64LE(56)) };
      const pre: S = { q: st.q + BigInt(e.quAmount), a: st.a + BigInt(e.assetAmount), t: st.t + BigInt(call.burnLiquidity) };
      const pool: PoolState = { exists: true, reserveQu: Number(pre.q), reserveAsset: Number(pre.a), totalLiquidity: Number(pre.t) };
      const p = predictRemove(pool, call, call.burnLiquidity);
      const ok = p.ok && p.quOut === e.quAmount && p.assetOut === e.assetAmount;
      tally.remove[ok ? 0 : 1]++;
      if (!ok) console.log(`  MISMATCH remove ${entry.pool.symbol} tick ${ev.tickNumber}: logged ${JSON.stringify(e)}, predicted ${JSON.stringify(p)}`);
      else {
        const exactAsset = (call.burnLiquidity * pool.reserveAsset) / pool.totalLiquidity;
        deposits.push(`  ${entry.pool.symbol.padEnd(8)} tick ${ev.tickNumber}  removal   burn ${fmt(call.burnLiquidity)} -> ${fmt(e.quAmount)} QU + ${fmt(e.assetAmount)} tokens; token fraction left in the pool ${(exactAsset - e.assetAmount).toFixed(3)} (~${fmt((exactAsset - e.assetAmount) * pool.reserveQu / pool.reserveAsset)} QU)`);
      }
      st = pre;
    } else {
      const x = body.readBigInt64LE(40);
      const y = body.readBigInt64LE(48);
      const u = undoSwap(type, x, y, st);
      tally.swap[u.ok ? 0 : 1]++;
      if (!u.ok) {
        console.log(`  ${entry.pool.symbol}: swap type ${type} at tick ${ev.tickNumber} does not reproduce (${u.detail}); stopping this pool.`);
        broken = true;
      }
      st = u.pre;
    }
  }
}
console.log(`\nWalked back: adds ${tally.add[0]} matched / ${tally.add[1]} not, removes ${tally.remove[0]} / ${tally.remove[1]}, swaps ${tally.swap[0]} / ${tally.swap[1]}.`);
console.log("Each real liquidity change, with the pool state just before it:");
for (const d of deposits) console.log(d);

// Real liquidity providers' positions.
console.log("\nPositions of recent liquidity providers:");
const seen = new Set<string>();
for (const tx of [...adds.values()].reverse()) {
  const b = Buffer.from(tx.inputData, "base64");
  const key = keyOf(b.subarray(0, 32).toString("hex"), assetNameFromU64(b.readBigUInt64LE(32)));
  const entry = live.get(key);
  if (!entry || seen.has(tx.source + key) || seen.size >= 10) continue;
  seen.add(tx.source + key);
  const mine = await readLiquidity(query, { issuer: entry.pool.issuer, assetName: entry.pool.symbol }, tx.source);
  const v = positionValue(entry.state, mine.liquidity);
  console.log(`  ${tx.source.slice(0, 10)}… in ${entry.pool.symbol.padEnd(8)} ${fmt(mine.liquidity)} units = ${v.sharePct.toFixed(4)}% of the pool -> ${fmt(v.quOut)} QU + ${fmt(v.assetOut)} tokens, ~${fmt(v.valueQu)} QU; earnedFees ${fmt(mine.earnedFeesQu)} QU`);
  if (mine.liquidity > 0) {
    for (const amount of [{ percent: 25 }, { percent: 100 }]) {
      const r = planRemoveLiquidity({ asset: { symbol: entry.pool.symbol, issuer: entry.pool.issuer, assetName: entry.pool.symbol }, pool: entry.state, liquidity: mine.liquidity, amount, balanceQu: 1e9, slippageBps: 100 });
      console.log(`      remove ${"percent" in amount ? amount.percent : 0}%: ${r.ok ? `burn ${fmt(r.burnLiquidity)} -> ${fmt(r.expectedQu)} QU + ${fmt(r.expectedAsset)} (mins ${fmt(r.minQu)} / ${fmt(r.minAsset)})` : `refused: ${r.refusal!.message}`}`);
    }
  }
}

// What the planner makes of an add on each real pool.
console.log("\nPlanner on the live pools (a wallet with plenty of QU and tokens under QX), 1% limit:");
for (const { pool, state } of live.values()) {
  for (const qu of [1_000_000, 10_000_000, 100_000_000]) {
    const plan = planAddLiquidity({ asset: { symbol: pool.symbol, issuer: pool.issuer, assetName: pool.symbol }, pool: state, quAmount: qu, balanceQu: 1e12, holdings: { 1: 1e12 }, slippageBps: 100, transferFeeQu: { qx: 100, qswap: 100 } });
    console.log(
      `  ${pool.symbol.padEnd(8)} ${fmt(qu).padStart(11)} QU: ` +
        (plan.ok
          ? `${fmt(plan.assetAmount)} tokens + ${fmt(plan.expectedQu)} QU (max ${fmt(plan.maxQu)}, min ${fmt(plan.minQu)}) -> ${fmt(plan.expectedLiquidity)} units, ${plan.shareAfterPct.toFixed(4)}%, rounding ${fmt(plan.roundingLossQu)} QU, worst ${fmt(plan.worstRoundingQu)} QU, outlay ${fmt(plan.maxOutlayQu)}`
          : `refused (${plan.refusal!.code}): ${plan.refusal!.message}`),
    );
  }
}
console.log(`\nFlat fee per add and per remove: ${fmt(LIQUIDITY_FEE_QU)} QU.`);
