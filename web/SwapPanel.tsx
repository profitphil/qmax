import { useEffect, useMemo, useRef, useState } from "react";
import { fetchQuote, shownName } from "./client.ts";
import type { AssetItem, QuoteResponse } from "./client.ts";
import { busiest } from "./catalog.ts";
import { fetchBalance } from "./exec/chain.ts";
import { fetchSwapQuote } from "./swap-api.ts";
import type { SwapPlan } from "./swap-api.ts";
import { fetchVenueQuote } from "./max-api.ts";
import { ExecuteModal } from "./ExecuteModal.tsx";
import { SwapModal } from "./SwapModal.tsx";
import { MaxModal } from "./MaxModal.tsx";
import { useMaxMode } from "./maxmode.tsx";
import { useSettings } from "./settings.tsx";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Avatar, Icon, Modal, Spinner } from "./ui.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const keyOf = (a: AssetItem) => `${a.symbol}|${a.issuer}`;

/** QU itself, as a choice beside the tokens: giving QU is a buy and getting QU is a sell, so there is only one trade (a plain QSwap swap). */
const QU: AssetItem = { id: "QU", symbol: "QU", issuer: "", category: "token", venues: [], priceQu: 1, liquidityQu: 0 };
const isQu = (a: AssetItem | null | undefined) => a?.id === "QU";

/**
 * What one buy or sell comes to, for a swap that has QU on one side. Selling: the quote for that many units. Buying with a budget in QU: the
 * most units whose quote fits the budget, found by quoting, scaling the amount by budget over cost and quoting again (a few rounds: the price
 * moves as the size does).
 */
function useSingleTrade(asset: AssetItem | null, side: "buy" | "sell" | null, amount: number, slippageBps: number, venue?: "QSwap") {
  // A plain swap is on the QSwap pool only; anywhere else the router takes the best route.
  const quoteOf = (s: "buy" | "sell", qty: number, signal: AbortSignal) => (venue ? fetchVenueQuote({ asset: asset!.id, side: s, qty, venue, slippageBps }, signal) : fetchQuote({ side: s, asset: asset!.id, qty, slippageBps }, signal));
  const [state, setState] = useState<{ quote: QuoteResponse | null; qty: number; loading: boolean; error: string }>({ quote: null, qty: 0, loading: false, error: "" });
  useEffect(() => {
    if (!asset || !side || !(Number.isInteger(amount) && amount > 0)) {
      setState({ quote: null, qty: 0, loading: false, error: "" });
      return;
    }
    const ctl = new AbortController();
    setState({ quote: null, qty: 0, loading: true, error: "" });
    const t = setTimeout(async () => {
      try {
        if (side === "sell") {
          const q = await quoteOf("sell", amount, ctl.signal);
          setState({ quote: q, qty: amount, loading: false, error: "" });
          return;
        }
        const price = asset.priceQu && asset.priceQu > 0 ? asset.priceQu : null;
        if (!price) throw new Error(`${shownName(asset)} has no price right now.`);
        let qty = Math.max(1, Math.floor(amount / price));
        let best: QuoteResponse | null = null;
        const tried = new Set<number>();
        for (let round = 0; round < 5 && !ctl.signal.aborted; round++) {
          if (tried.has(qty)) break;
          tried.add(qty);
          const q = await quoteOf("buy", qty, ctl.signal);
          if (!q.fillable || !(q.totalQu > 0)) {
            if (qty <= 1) break;
            qty = Math.max(1, Math.floor(qty / 2)); // not enough on the market at this size: try less
            continue;
          }
          if (q.totalQu <= amount) {
            if (!best || q.qty > best.qty) best = q;
            if (q.totalQu >= amount * 0.985) break; // close enough to the budget
          }
          const next = Math.max(1, Math.floor(qty * (amount / q.totalQu) * (q.totalQu > amount ? 0.995 : 1)));
          if (next === qty) break;
          qty = next;
        }
        if (ctl.signal.aborted) return;
        if (!best) throw new Error(`${n(amount)} QU does not buy even one ${shownName(asset)} right now.`);
        setState({ quote: best, qty: best.qty, loading: false, error: "" });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setState({ quote: null, qty: 0, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [asset?.id, side, amount, slippageBps, venue]);
  return state;
}

interface Props {
  assets: AssetItem[];
  /** What the wallet holds that QX and QSwap can trade, by `symbol|issuer`. */
  owned: Record<string, number>;
  walletId: string | null;
  onConnect: () => void;
  /** Told when a swap finished or closed, so the page can read the wallet again. */
  onChanged?: () => void;
  /** Opens the normal buy screen (offered when a swap's second trade could not go ahead). */
  onBuy?: (asset: AssetItem) => void;
  /** The narrow form that sits in the workspace's right-hand panel: no page heading, tighter spacing (the stylesheet does the rest). */
  compact?: boolean;
}

/**
 * The Swap section. With Max mode off (the switch in Settings) it is the plain QSwap swap: QU for a token, or a token back to QU, straight through the QSwap
 * pool, made like any trade. With Max mode on, one asset can be swapped for another: underneath it is two trades (sell, then buy with the QU), each on QMax's
 * best route across QX and QSwap, measured against every single-market alternative so "best price" is shown, not claimed; and a swap with QU on one side
 * opens QMax's search for the best position for that trade. Signing happens in `SwapModal` (two assets) or the ordinary trade dialogs, which re-check everything.
 */
export function SwapPanel({ assets, owned, walletId, onConnect, onChanged, onBuy, compact }: Props) {
  const { settings } = useSettings();
  const { connected } = useQubicConnect();
  const max = useMaxMode();
  const maxMode = max.active;
  // A plain swap is on the QSwap pool, so only tokens with a pool; a Max swap can use any token that trades anywhere.
  const tradable = useMemo(() => assets.filter((a) => (maxMode ? a.venues.length > 0 : a.venues.includes("QSwap"))), [assets, maxMode]);
  const held = (a: AssetItem) => owned[keyOf(a)] ?? 0;

  // It starts with QU on the give side (most swaps begin with QU in the wallet) and the busiest token on the other.
  const defaults = useMemo(() => ({ from: QU, to: [...tradable].sort(busiest)[0] ?? null }), [tradable]);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const pick = (id: string | null, fallback: AssetItem | null): AssetItem | null => {
    const want = id ?? fallback?.id;
    if (want === QU.id) return QU;
    return tradable.find((a) => a.id === want) ?? null;
  };
  let from = pick(fromId, defaults.from);
  let to = pick(toId, defaults.to);
  // A plain swap always has QU on exactly one side; with Max on there may be two assets instead, but never QU for QU.
  if (!maxMode && !isQu(from) && !isQu(to)) from = QU;
  if (isQu(from) && isQu(to)) to = defaults.to;
  const [qtyText, setQtyText] = useState("");
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [searching, setSearching] = useState(false);

  // Max mode was switched on or off: start again from the defaults for it.
  const lastMode = useRef(maxMode);
  useEffect(() => {
    if (lastMode.current === maxMode) return;
    lastMode.current = maxMode;
    setFromId(null);
    setToId(null);
    setQtyText("");
    setSwapping(false);
    setSearching(false);
    setReviewing(false);
  }, [maxMode]);

  const qty = Number(qtyText.replace(/,/g, ""));
  const validQty = Number.isInteger(qty) && qty > 0;
  const slippageBps = Math.round(settings.slippagePct * 100);

  // QU on one side makes it a single trade (giving QU buys, getting QU sells): on the QSwap pool for a plain swap, or QMax's best position with Max on.
  const single: "buy" | "sell" | null = isQu(from) && !isQu(to) ? "buy" : isQu(to) && !isQu(from) ? "sell" : null;
  const singleAsset = single === "buy" ? to : single === "sell" ? from : null;
  const trade = useSingleTrade(singleAsset, single, validQty ? qty : 0, slippageBps, maxMode ? undefined : "QSwap");
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    setBalance(null);
    if (!walletId) return;
    let alive = true;
    fetchBalance(walletId).then((b) => alive && setBalance(b)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [walletId]);

  // The plan, then the comparison: the plan comes back fast and the comparison (several more plans) fills in after.
  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    setPlan(null);
    setError("");
    setComparing(false);
    if (!maxMode || !from || !to || !validQty || from.id === to.id || isQu(from) || isQu(to)) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const first = await fetchSwapQuote({ from: from.id, to: to.id, qty, slippageBps }, ctl.signal);
        if (seq.current !== mine) return;
        setPlan(first);
        setLoading(false);
        if (first.sell && first.buy) {
          setComparing(true);
          const full = await fetchSwapQuote({ from: from.id, to: to.id, qty, slippageBps, compare: true }, ctl.signal);
          if (seq.current === mine) setPlan(full);
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError" && seq.current === mine) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq.current === mine) {
          setLoading(false);
          setComparing(false);
        }
      }
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [maxMode, from?.id, to?.id, qty, slippageBps]);

  const flip = () => {
    if (!from || !to) return;
    setFromId(to.id);
    setToId(from.id);
    setQtyText("");
  };
  const available = isQu(from) ? balance ?? 0 : from ? held(from) : 0;

  /** Choosing for one side. A plain swap keeps QU on exactly one side: choosing a token for one side puts QU on the other, and choosing QU for one side puts a token on the other. With Max on, two assets are fine; QU for QU never is. */
  const choose = (side: "from" | "to", a: AssetItem) => {
    const other = side === "from" ? to : from;
    const setSelf = side === "from" ? setFromId : setToId;
    const setOther = side === "from" ? setToId : setFromId;
    setSelf(a.id);
    if (side === "from") setQtyText("");
    if (isQu(a)) setOther(isQu(other) ? defaults.to?.id ?? null : other?.id ?? null);
    else if (!maxMode) setOther(QU.id);
  };

  return (
    <div className={compact ? "swapsec compact" : "swapsec"}>
      <header className="swapsec-head">
        {!compact && <h2>Swap</h2>}
        <p className="note swapsec-modes">
          <span><b>QSwap:</b> Qubic &#8644; Token</span>
          <span>
            <b>Max swap:</b> Asset &#8644; Asset{" "}
            {!maxMode && <button type="button" className="linklike" onClick={() => max.setOn(true)}>Turn on Max</button>}
          </span>
        </p>
      </header>

      <div className="swapsec-card">
        <div className="swapsec-field">
          <span className="swapsec-top">
            <span>You give</span>
            {from && connected && (isQu(from) ? balance !== null && <small>Balance {n(balance)} QU</small> : <small>{available > 0 ? `Holds ${n(available)} ${shownName(from)}` : `You hold no ${shownName(from)} that ${maxMode ? "QX or QSwap" : "QSwap"} can trade`}</small>)}
          </span>
          <div className="swapsec-row">
            <TokenButton asset={from} onClick={() => setPicking("from")} label="Choose the token to give" />
            <span className="swapsec-amount">
              <input
                value={qtyText}
                inputMode="numeric"
                placeholder="0"
                aria-label={`How many ${from ? shownName(from) : "tokens"} to give`}
                onChange={(e) => {
                  const d = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
                  setQtyText(d === "" ? "" : Number(d).toLocaleString("en-US"));
                }}
              />
              {connected && available > 0 && (
                <button type="button" className="allbtn" onClick={() => setQtyText(n(available))} title="Everything you have of this">All</button>
              )}
            </span>
          </div>
        </div>

        <button className="swapsec-flip" onClick={flip} aria-label="Swap the two tokens around" title="Swap the two tokens around">
          <Icon name="swap" size={16} />
        </button>

        <div className="swapsec-field">
          <span className="swapsec-top">
            <span>You get</span>
            {single ? trade.quote && <small>{maxMode ? "at the best route" : "from the QSwap pool"}, if the price stays within your {settings.slippagePct}% limit</small> : plan?.executable && <small>at least {n(plan.minOutQty)} {(to ? shownName(to) : "")}, if prices stay within your {settings.slippagePct}% limit</small>}
          </span>
          <div className="swapsec-row">
            <TokenButton asset={to} onClick={() => setPicking("to")} label="Choose the token to get" />
            <span className="swapsec-out num" aria-live="polite">
              {single ? (
                trade.loading ? <Spinner size={16} /> : trade.quote ? <>≈ {n(single === "buy" ? trade.qty : trade.quote.totalQu)}</> : <span className="muted">–</span>
              ) : loading ? <Spinner size={16} /> : plan?.executable ? <>≈ {n(plan.expectedOutQty)}</> : <span className="muted">–</span>}
            </span>
          </div>
        </div>
      </div>

      {!from || !to ? (
        <p className="note">Choose the two tokens.</p>
      ) : from.id === to.id ? (
        <p className="warn inline"><Icon name="alert" size={15} /> Pick two different tokens.</p>
      ) : !validQty ? (
        <p className="note">{maxMode ? `Enter how many ${shownName(from)} to give and QMax will find the best route.` : `Enter how many ${shownName(from)} to give.`}</p>
      ) : single ? (
        trade.error ? (
          <p className="err inline"><Icon name="alert" size={15} /> {trade.error}</p>
        ) : trade.loading || !trade.quote ? (
          <div className="quote loading" role="status" aria-label="Pricing the swap">
            <span className="skeleton line" style={{ width: "45%" }} />
            <span className="skeleton line big" style={{ width: "60%" }} />
            <span className="skeleton line" style={{ width: "90%" }} />
          </div>
        ) : (
          <div className="swapsec-plan">
            <ul className="swapsec-legs" aria-label="The swap">
              <li>
                <span className="swapsec-step">1</span>
                <span>
                  <b>{single === "buy" ? `Buy ${n(trade.qty)} ${(singleAsset ? shownName(singleAsset) : "")}` : `Sell ${n(trade.qty)} ${(singleAsset ? shownName(singleAsset) : "")}`}</b> for about {n(trade.quote.totalQu)} QU
                  <small>on QSwap{trade.quote.averagePriceQu !== null ? `, ${n(trade.quote.averagePriceQu, 2)} QU each on average, fees included` : ""}.</small>
                </span>
              </li>
            </ul>
            {single === "buy" && connected && balance !== null && trade.quote.totalQu > balance && (
              <p className="warn inline"><Icon name="alert" size={15} /> This costs more than the {n(balance)} QU in your wallet.</p>
            )}
            {trade.quote.warnings.map((w) => <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>)}
            <p className="note">{maxMode ? "This is the plain best-route price. Max searches for a better position: the best way to execute, the best size, an arbitrage, the best exit." : "A straight swap through the QSwap pool: its 0.3% fee and a flat 100,000 QU per swap are in the price above. It does not compare other markets; Buy and Sell on the trade screen take the best route, and Max mode searches for the best position."}</p>
          </div>
        )
      ) : error ? (
        <p className="err inline"><Icon name="alert" size={15} /> {error}</p>
      ) : loading && !plan ? (
        <div className="quote loading" role="status" aria-label="Finding the best route">
          <span className="skeleton line" style={{ width: "45%" }} />
          <span className="skeleton line big" style={{ width: "60%" }} />
          <span className="skeleton line" style={{ width: "90%" }} />
        </div>
      ) : plan ? (
        <PlanView plan={plan} from={from} to={to} comparing={comparing} />
      ) : null}

      <div className="swapsec-cta">
        {!connected || !walletId ? (
          <button className="go buy" onClick={onConnect}>
            <Icon name="wallet" size={17} /> Connect wallet to swap
          </button>
        ) : single && maxMode ? (
          <button className="go max-go" disabled={!validQty || !singleAsset} onClick={() => setSearching(true)}>
            {!validQty ? "Enter an amount" : `Max: best position to ${single} ${(singleAsset ? shownName(singleAsset) : "")}`}
          </button>
        ) : single ? (
          <button className="go buy" disabled={!trade.quote || trade.loading || !singleAsset} onClick={() => setSwapping(true)}>
            {trade.loading ? <><Spinner size={16} /> Pricing the swap…</> : !validQty ? "Enter an amount" : trade.quote && singleAsset ? `Swap ${single === "buy" ? `QU for ${shownName(singleAsset)}` : `${shownName(singleAsset)} for QU`} on QSwap` : "This cannot be done right now"}
          </button>
        ) : (
          <button className="go max-go" disabled={!plan?.executable || loading} onClick={() => setReviewing(true)}>
            {loading ? <><Spinner size={16} /> Finding the best route…</> : !validQty ? "Enter an amount" : plan?.executable ? <>Max: swap {(from ? shownName(from) : "")} for {(to ? shownName(to) : "")}</> : "This swap cannot be made right now"}
          </button>
        )}
        <p className="trade-trust"><Icon name="shield" size={14} /> Non-custodial: you review and sign each trade in your own wallet.{maxMode && !single && " A swap between two assets is two trades, so it is never atomic: if the second cannot go ahead you keep the QU from the first."}</p>
      </div>

      {picking && (
        <TokenPicker
          assets={tradable.filter((a) => !(maxMode && a.id === (picking === "from" ? to?.id : from?.id)))}
          withQu
          held={held}
          title={picking === "from" ? "Token to give" : "Token to get"}
          note={maxMode ? undefined : "QSwap is Qubic \u21c4 Token, so only tokens with a QSwap pool are listed. For Asset \u21c4 Asset, turn on Max."}
          onPick={(a) => {
            choose(picking, a);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}

      {searching && single && singleAsset && (
        <MaxModal
          asset={singleAsset}
          side={single}
          qty={single === "sell" ? qty : undefined}
          balanceQu={single === "buy" ? (balance !== null ? Math.min(qty, balance) : qty) : balance}
          heldQty={single === "sell" ? Math.min(qty, held(singleAsset)) : held(singleAsset)}
          slippageBps={slippageBps}
          onClose={() => {
            setSearching(false);
            onChanged?.();
          }}
          onDone={() => onChanged?.()}
        />
      )}

      {swapping && single && singleAsset && trade.quote && (
        <ExecuteModal
          shown={trade.quote}
          slippageBps={slippageBps}
          expected={{ assetName: singleAsset.symbol, issuer: singleAsset.issuer }}
          venue="QSwap"
          onClose={() => {
            setSwapping(false);
            onChanged?.();
          }}
        />
      )}

      {reviewing && from && to && (
        <SwapModal
          from={from}
          assets={tradable}
          holdings={null}
          initialTo={to.id}
          initialQty={qty}
          onClose={() => {
            setReviewing(false);
            onChanged?.();
          }}
          onBuy={(a) => {
            setReviewing(false);
            onChanged?.();
            onBuy?.(a);
          }}
          onConnect={onConnect}
        />
      )}
    </div>
  );
}

function TokenButton({ asset, onClick, label }: { asset: AssetItem | null; onClick: () => void; label: string }) {
  return (
    <button type="button" className="swapsec-token" onClick={onClick} aria-label={label}>
      {asset ? (
        <>
          <Avatar symbol={asset.symbol} category={asset.category} issuer={asset.issuer} size={28} />
          <b>{shownName(asset)}</b>
        </>
      ) : (
        <span className="muted">Choose</span>
      )}
      <Icon name="chevron" size={14} />
    </button>
  );
}

type Kind = "all" | "contract" | "token";
const KIND_NAMES: Record<Exclude<Kind, "all">, string> = { contract: "Smart contracts", token: "Tokens" };
/** The most rows shown in one section: the search narrows the rest. */
const PICK_LIMIT = 80;

/** The list to choose a token from: smart contracts and tokens in their own sections (and a filter for each), what you hold first. */
function TokenPicker({ assets, withQu, held, title, note, onPick, onClose }: { assets: AssetItem[]; withQu: boolean; held: (a: AssetItem) => number; title: string; note?: string; onPick: (a: AssetItem) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const matches = useMemo(() => {
    const s = q.trim().toUpperCase();
    return assets
      .filter((a) => !s || a.symbol.toUpperCase().includes(s) || a.id.toUpperCase().includes(s))
      .sort((a, b) => Number(held(b) > 0) - Number(held(a) > 0) || b.liquidityQu - a.liquidityQu);
  }, [assets, q]);
  const byKind = useMemo(() => ({ contract: matches.filter((a) => a.category === "contract"), token: matches.filter((a) => a.category === "token") }), [matches]);
  const sections = (["contract", "token"] as const).filter((k) => kind === "all" || kind === k).map((k) => ({ kind: k, total: byKind[k].length, rows: byKind[k].slice(0, PICK_LIMIT) })).filter((x) => x.total > 0);
  const showQu = withQu && (!q.trim() || "QU QUBIC".includes(q.trim().toUpperCase()));
  return (
    <Modal title={title} size="sm" onClose={onClose}>
      {note && <p className="note first">{note}</p>}
      <label className="swapsec-search">
        <Icon name="search" size={16} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a token or contract" aria-label="Search a token or contract" />
      </label>
      <div className="seg-mini swapsec-kinds" role="group" aria-label="Kind of asset">
        {([["all", "All", matches.length], ["contract", "Contracts", byKind.contract.length], ["token", "Tokens", byKind.token.length]] as const).map(([id, label, count]) => (
          <button key={id} type="button" className={kind === id ? "on" : ""} aria-pressed={kind === id} onClick={() => setKind(id)}>
            {label} <span className="count">{count}</span>
          </button>
        ))}
      </div>
      <div className="swapsec-scroll">
        {showQu && (
          <section>
            <h4 className="swapsec-sec">Qubic</h4>
            <ul className="swapsec-list" aria-label="Qubic">
              <li>
                <button type="button" onClick={() => onPick(QU)}>
                  <Avatar symbol="QU" category="token" size={30} />
                  <span className="swapsec-list-name">
                    <b>QU</b>
                    <small>Qubic: the coin itself. QSwap swaps it for a token (Qubic ⇄ Token)</small>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        )}
        {sections.length === 0 && !showQu && <p className="note first">{q ? `No ${kind === "contract" ? "smart contract" : kind === "token" ? "token" : "token or contract"} matches “${q}”.` : "Nothing to choose."}</p>}
        {sections.map((sec) => (
          <section key={sec.kind}>
            <h4 className="swapsec-sec">
              {KIND_NAMES[sec.kind]} <span className="count">{sec.total}</span>
            </h4>
            <ul className="swapsec-list" aria-label={KIND_NAMES[sec.kind]}>
              {sec.rows.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => onPick(a)}>
                    <Avatar symbol={a.symbol} category={a.category} issuer={a.issuer} size={30} />
                    <span className="swapsec-list-name">
                      <b>{a.id}</b>
                      <small>{a.venues.length > 1 ? "QX and QSwap" : a.venues[0]}{held(a) > 0 ? ` · you hold ${n(held(a))}` : ""}</small>
                    </span>
                    <span className="num swapsec-list-price">{a.priceQu !== null ? `${n(a.priceQu, a.priceQu < 10 ? 4 : 2)} QU` : "–"}</span>
                  </button>
                </li>
              ))}
            </ul>
            {sec.total > sec.rows.length && <p className="note swapsec-more">Showing {sec.rows.length} of {sec.total}: type to narrow the list.</p>}
          </section>
        ))}
      </div>
    </Modal>
  );
}

const venues = (q: { route: { venue: string; qty: number }[] } | null) => {
  if (!q || !q.route.length) return "–";
  const total = q.route.reduce((a, r) => a + r.qty, 0);
  return q.route.map((r) => (q.route.length > 1 && total > 0 ? `${r.venue} ${n((r.qty / total) * 100)}%` : r.venue)).join(" + ");
};

function PlanView({ plan, from, to, comparing }: { plan: SwapPlan; from: AssetItem; to: AssetItem; comparing: boolean }) {
  const deal = plan.bestDeal;
  return (
    <div className="swapsec-plan">
      {plan.executable && (
        <ul className="swapsec-legs" aria-label="The two trades">
          <li>
            <span className="swapsec-step">1</span>
            <span>
              <b>Sell {n(plan.qty)} {shownName(from)}</b> for about {n(plan.expectedProceedsQu)} QU
              <small>on {venues(plan.sell)}. At least {n(plan.worstProceedsQu)} QU within your limit.</small>
            </span>
          </li>
          <li>
            <span className="swapsec-step">2</span>
            <span>
              <b>Buy about {n(plan.expectedOutQty)} {shownName(to)}</b> with that QU
              <small>on {venues(plan.buy)}. At least {n(plan.minOutQty)} if prices stay within your limit.</small>
            </span>
          </li>
        </ul>
      )}

      {plan.executable && (
        <p className="swapsec-meta">
          QU needed in your wallet before the first trade: <b className="num">{n(plan.upfrontQu)} QU</b> (flat fees). About <b className="num">{n(plan.expectedLeftoverQu)} QU</b> is expected to stay in your wallet as QU.
        </p>
      )}

      {deal ? (
        <div className="swapsec-deal">
          <p className="swapsec-deal-head"><Icon name="bolt" size={15} fill /> <b>{deal.headline}</b></p>
          <table className="swapsec-table">
            <thead>
              <tr><th scope="col">Route</th><th scope="col" className="r">{shownName(to)} bought</th><th scope="col" className="r">Worth</th></tr>
            </thead>
            <tbody>
              <tr className="us">
                <th scope="row"><Icon name="check" size={13} /> QMax's route</th>
                <td className="r num">{n(plan.expectedOutQty)}</td>
                <td className="r num">{n(deal.valueQty)}</td>
              </tr>
              {deal.comparisons.map((c) => (
                <tr key={c.label} className={c.executable ? "" : "off"}>
                  <th scope="row">{c.label}</th>
                  {c.executable ? (
                    <>
                      <td className="r num">{n(c.expectedOutQty)}</td>
                      <td className="r num">{n(c.valueQty)}{c.lessPct !== null && c.lessPct >= 0.05 && <small className="neg"> −{c.lessPct < 10 ? c.lessPct.toFixed(1) : n(c.lessPct)}%</small>}</td>
                    </>
                  ) : (
                    <td className="r" colSpan={2}><small className="muted">{c.reason ?? "cannot do this swap"}</small></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">
            Each row is this same swap forced onto those markets, planned the same way. "Worth" counts the {shownName(to)} bought plus the QU left over (at the price paid) minus the fees paid up front, because a plan that buys at a better price can end up buying fewer units and keeping the rest as QU.
          </small>
        </div>
      ) : comparing ? (
        <p className="status-line"><Spinner size={14} /> Comparing with every single-market route…</p>
      ) : null}

      {plan.warnings.map((w) => <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>)}
    </div>
  );
}
