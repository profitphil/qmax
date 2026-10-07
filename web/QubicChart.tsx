import type { ChartSource } from "./ChartView.tsx";
import { QU_PER, fetchQuChart } from "./qu-api.ts";
import { axisVolume } from "../src/lwdata.ts";

const WIDTH_NAME = { "1m": "a minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "an hour", "4h": "4 hours", "1d": "a day" } as const;

/**
 * QU's price as the chart of any asset has it: the same tools, indicators, drawings, epochs, settings and pictures. Only the candles differ: they
 * are real exchange candles (MEXC's QUBIC/USDT, USDT counted as a dollar), in dollars for a million QU because one QU is a tiny fraction of a cent.
 */
export const QU_SOURCE: ChartSource = {
  candles: fetchQuChart,
  priceUnit: "USD per 1M QU",
  volumeLine: (c) => (c.volumeQty > 0 ? `${axisVolume(c.volumeQty * QU_PER)} QU traded · $${axisVolume(c.volumeQu)}` : "No QU traded"),
  note: (c, range) =>
    c === null ? (
      <>Dollars for one million QU: the closing price of each candle on MEXC's QUBIC/USDT market (Gate.io if MEXC cannot be reached). Drawing tools and indicators are for the candle styles.</>
    ) : c.candles.length === 0 ? (
      <>No candles for {range === "1d" ? "the last day" : "this range"} right now. Try a longer one.</>
    ) : (
      <>
        Dollars for one million QU. {WIDTH_NAME[c.interval].replace(/^an? /, "").replace(/^(\w)/, (ch) => ch.toUpperCase())} candles, MEXC's QUBIC/USDT (Gate.io if MEXC cannot be reached), USDT counted as a dollar. Bars are the dollars traded; the legend also gives the QU. UTC, updates every minute.
        {range === "all" && " QU first traded on 9 May 2024 (on Gate.io); MEXC lists it from 17 July 2024, so the days before are Gate.io's. Nothing earlier exists."}
      </>
    ),
};
