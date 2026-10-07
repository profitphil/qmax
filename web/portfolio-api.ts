import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE } from "./client.ts";
import type { AssetItem } from "./client.ts";
import { fetchLedger } from "./ledger-api.ts";
import type { Ledger } from "./ledger-api.ts";
import { buildPortfolio } from "../src/portfolio.ts";
import type { HoldingIn } from "../src/portfolio.ts";
import type { LiquidationResult } from "../src/liquidation.ts";

/** What the holdings would fetch if sold now (the server runs each through the router a sale uses). */
export async function fetchLiquidation(holdings: { asset: string; qty: number }[], signal?: AbortSignal): Promise<LiquidationResult> {
  const res = await fetch(`${BASE}/v1/liquidation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ holdings }), signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body as LiquidationResult;
}

const LEDGER_DAYS = 365;
/**
 * How long a pricing of the holdings is used before it is done again, whether My assets is open or was left and came back to. Pricing a real sale of every
 * holding is slow (it reads the live market for each one), and a portfolio's worth does not move fast enough to need more; the Refresh button prices it again whenever asked.
 */
const WORTH_FRESH_MS = 15 * 60_000;
/** A read ledger is kept for this long, so leaving My assets and coming back does not read the archive (which limits how often it is asked) again. */
const LEDGER_KEEP_MS = 15 * 60_000;
/** After this many busy answers in a row the page stops asking by itself (the button asks again). */
const MAX_AUTO_RETRIES = 6;
const kept = new Map<string, { at: number; ledger: Ledger }>();
/** The last pricing of each wallet's holdings (and which holdings it was for), kept for as long as the page is open, so coming back to My assets shows it at once. */
const keptWorth = new Map<string, { at: number; signature: string; result: LiquidationResult }>();

export type LedgerState = { status: "loading" } | { status: "ready"; ledger: Ledger } | { status: "error"; message: string; retryAfterSec?: number; /** The page will ask again by itself. */ willRetry: boolean };

/**
 * The My assets numbers: what each holding would fetch if sold now and what it cost (the wallet's trade ledger for the last year, read once: it is the slow
 * part, so the worth shows first and the cost fills in). The worth is priced when first asked for and then kept for 15 minutes, across leaving and coming
 * back (the last pricing shows straight away; an older one is shown while a new one is fetched); `refreshWorth` prices it again now. Nothing is asked for until `enabled`.
 */
export function usePortfolio({ walletId, assets, owned, enabled }: { walletId: string | null; assets: AssetItem[]; owned: Record<string, number>; enabled: boolean }) {
  const holdings = useMemo<HoldingIn[]>(
    () =>
      assets
        .filter((a) => a.issuer && (owned[`${a.symbol}|${a.issuer}`] ?? 0) > 0)
        .map((a) => ({ key: `${a.symbol}|${a.issuer}`, id: a.id, symbol: a.symbol, qty: owned[`${a.symbol}|${a.issuer}`] })),
    [assets, owned],
  );
  const signature = holdings.map((h) => `${h.id}:${h.qty}`).sort().join(",");

  const [liquidation, setLiquidation] = useState<LiquidationResult | null>(null);
  const [pricedAt, setPricedAt] = useState<number | null>(null);
  const [refreshingWorth, setRefreshingWorth] = useState(false);
  const [liqError, setLiqError] = useState("");
  const holdingsRef = useRef(holdings);
  holdingsRef.current = holdings;
  const priceNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled || !walletId || holdingsRef.current.length === 0) {
      setLiquidation(null);
      setPricedAt(null);
      priceNow.current = null;
      return;
    }
    // The last pricing of these same holdings, if there is one: shown at once; fetched again only when it is older than the keeping time.
    const have = keptWorth.get(walletId);
    const same = have && have.signature === signature ? have : null;
    if (same) {
      setLiquidation(same.result);
      setPricedAt(same.at);
      setLiqError("");
    }
    let lastAt = same?.at ?? 0;
    const ctl = new AbortController();
    let failures = 0;
    let again: ReturnType<typeof setTimeout> | undefined;
    const load = (): Promise<void> => {
      setRefreshingWorth(true);
      return fetchLiquidation(holdingsRef.current.map((h) => ({ asset: h.id, qty: h.qty })), ctl.signal)
        .then((r) => {
          failures = 0;
          lastAt = Date.now();
          keptWorth.set(walletId, { at: lastAt, signature, result: r });
          setLiquidation(r);
          setPricedAt(lastAt);
          setLiqError("");
          setRefreshingWorth(false);
        })
        .catch((e) => {
          if (e.name === "AbortError") return;
          setLiqError(e instanceof Error ? e.message : String(e));
          setRefreshingWorth(false);
          // The server is pricing other portfolios (or the market data is busy): ask again in a few seconds, a few times.
          if (++failures <= 3) again = setTimeout(() => void load(), 5000 * failures);
        });
    };
    priceNow.current = () => {
      clearTimeout(again);
      void load();
    };
    if (!same || Date.now() - same.at >= WORTH_FRESH_MS) void load();
    // While it is open (and seen), a pricing older than the keeping time is done again.
    const timer = setInterval(() => document.visibilityState === "visible" && Date.now() - lastAt >= WORTH_FRESH_MS && void load(), 60_000);
    return () => {
      ctl.abort();
      clearInterval(timer);
      clearTimeout(again);
      priceNow.current = null;
    };
  }, [enabled, walletId, signature]);
  const refreshWorth = useCallback(() => priceNow.current?.(), []);
  // On coming back to My assets the last pricing of these holdings is there in the first draw (the effect only decides whether a newer one is needed).
  const keptNow = enabled && walletId ? keptWorth.get(walletId) : undefined;
  const restored = liquidation === null && keptNow && keptNow.signature === signature ? keptNow : null;
  const shown = liquidation ?? restored?.result ?? null;
  const shownAt = liquidation ? pricedAt : restored?.at ?? null;

  const [ledger, setLedger] = useState<LedgerState>({ status: "loading" });
  const [tries, setTries] = useState(0);
  const busyInARow = useRef(0);
  useEffect(() => {
    if (!enabled || !walletId) return;
    const have = kept.get(walletId);
    if (have && Date.now() - have.at < LEDGER_KEEP_MS) {
      setLedger({ status: "ready", ledger: have.ledger });
      return;
    }
    const ctl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    setLedger((cur) => (cur.status === "ready" ? cur : { status: "loading" }));
    fetchLedger(walletId, LEDGER_DAYS, ctl.signal)
      .then((l) => {
        busyInARow.current = 0;
        kept.set(walletId, { at: Date.now(), ledger: l });
        setLedger({ status: "ready", ledger: l });
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        const after = typeof e?.retryAfterSec === "number" ? e.retryAfterSec : undefined;
        // The server (or the archive behind it) is busy: ask again by itself, a few times, a little further apart each time.
        const willRetry = after !== undefined && busyInARow.current < MAX_AUTO_RETRIES;
        setLedger({ status: "error", message: e instanceof Error ? e.message : String(e), retryAfterSec: after, willRetry });
        if (willRetry) {
          busyInARow.current++;
          again = setTimeout(() => setTries((n) => n + 1), Math.max(3, after!) * 1000 * Math.min(3, busyInARow.current));
        }
      });
    return () => {
      ctl.abort();
      clearTimeout(again);
    };
  }, [enabled, walletId, tries]);
  const retry = useCallback(() => {
    busyInARow.current = 0;
    setTries((n) => n + 1);
  }, []);

  const built = useMemo(() => buildPortfolio(holdings, shown?.items ?? null, ledger.status === "ready" ? ledger.ledger : null), [holdings, shown, ledger]);
  const rowsByKey = useMemo(() => new Map(built.rows.map((r) => [r.key, r])), [built.rows]);
  return { rows: built.rows, rowsByKey, totals: built.totals, loadingWorth: enabled && holdings.length > 0 && shown === null && !liqError, /* a failed refresh keeps showing the last pricing */ liqError: shown ? "" : liqError, pricedAt: shownAt, refreshingWorth, refreshWorth, ledger, retry, coveredFromMs: ledger.status === "ready" ? ledger.ledger.coveredFromMs : null, ledgerDays: LEDGER_DAYS };
}
