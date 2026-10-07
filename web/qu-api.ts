import { useEffect, useState } from "react";
import { BASE } from "./client.ts";
import type { CandlesResponse } from "./client.ts";
import type { QuCandle, QuRange, QuSnapshot } from "../src/qubicprice.ts";

export type { QuCandle, QuRange, QuSnapshot };

export async function fetchQu(signal?: AbortSignal): Promise<QuSnapshot> {
  const res = await fetch(`${BASE}/v1/qu`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body as QuSnapshot;
}

/** What a chart of one QU is drawn in: dollars for a million QU, because one QU is worth about 0.0000006 of a dollar. */
export const QU_PER = 1_000_000;

interface QuKlineRow extends QuCandle {
  v: number;
}

/**
 * Exchange candles of QU in the shape the asset charts take, so the same chart (indicators, drawing tools, epochs, settings, pictures) shows them.
 * Prices are dollars for a million QU. A candle's `volumeQty` is the millions of QU traded and `volumeQu` the dollars they came to, so the
 * average of the two, which the VWAP is made from, is the price in the chart's own unit.
 */
export async function fetchQuChart(range: string, interval: string, signal?: AbortSignal): Promise<CandlesResponse> {
  const res = await fetch(`${BASE}/v1/qu/candles?${new URLSearchParams({ range, interval })}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  const rows = body.candles as QuKlineRow[];
  const candles = rows.map((k) => {
    const [o, h, l, c] = [k.o, k.h, k.l, k.c].map((x) => x * QU_PER);
    const millions = k.v / QU_PER;
    return { t: k.t, o, h, l, c, volumeQty: millions, volumeQu: millions * ((h + l + c) / 3), trades: 0 };
  });
  return {
    asset: "QU",
    range,
    interval: body.interval,
    venue: "all",
    candles,
    ...(body.truncated ? { truncated: true } : {}),
    volume24hQu: 0, // not used: the chart says nothing about a day's volume (the dialog's header has it, from CoinGecko)
    trades24h: 0,
  };
}

// One shared reading for everything on the page that shows the price (the title bar, the portfolio): asked for at most every 30 seconds.
let kept: { at: number; value: QuSnapshot } | null = null;
let inflight: Promise<QuSnapshot> | null = null;
const read = (): Promise<QuSnapshot> => {
  if (kept && Date.now() - kept.at < 30_000) return Promise.resolve(kept.value);
  inflight ??= fetchQu()
    .then((value) => {
      kept = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

/** The QU price in dollars, kept up to date about every minute while the page is on screen. Null until it is read, and when it cannot be. */
export function useQuPrice(): QuSnapshot | null {
  const [price, setPrice] = useState<QuSnapshot | null>(kept?.value ?? null);
  useEffect(() => {
    let alive = true;
    const load = () => read().then((v) => alive && setPrice(v)).catch(() => {}); // no price: the chip just stays out
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return price;
}

/**
 * Dollars for one QU, which is a very small number (about 0.0000006): enough places to show three figures that mean something.
 * 5.906e-7 becomes "$0.000000591".
 */
export function usdPerQu(p: number): string {
  if (!(p > 0)) return "–";
  const places = Math.min(12, Math.max(2, -Math.floor(Math.log10(p)) + 2));
  return `$${p.toFixed(places)}`;
}

/** An amount in dollars: two places from a dollar up, whole thousands compacted, and cents below that. */
export function usd(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${Math.round(x).toLocaleString("en-US")}`;
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
