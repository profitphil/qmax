/**
 * What the chart gives everyone and what is part of Max (QMax Pro). The basics are free: candles and the line, the ranges, an automatic candle width (and an hour or a
 * day), volume, the 20-candle average, the linear axis, the market choice, a trend line and a horizontal line, fit, full screen, and a picture at screen size. The rest
 * (the other chart styles and candle widths, more indicators, epoch marks, filling gaps, the log and percent axes, the chart settings panel, bigger pictures, and
 * the other drawing tools) switch on with Max. A choice a person made while Max was on is kept, and simply not applied while it is off.
 */
export const FREE_CHART = {
  types: ["candles", "line"],
  intervals: ["auto", "1h", "1d"],
  indicators: ["sma20"],
  scales: ["normal"],
  tools: ["cursor", "trend", "hline"],
  /** Picture widths in pixels; 0 is the screen's own size. */
  shotWidths: [0],
} as const;

const has = (list: readonly string[], v: string) => list.includes(v);
export const isFreeType = (t: string): boolean => has(FREE_CHART.types, t);
export const isFreeInterval = (i: string): boolean => has(FREE_CHART.intervals, i);
export const isFreeIndicator = (i: string): boolean => has(FREE_CHART.indicators, i);
export const isFreeScale = (s: string): boolean => has(FREE_CHART.scales, s);
export const isFreeTool = (t: string): boolean => has(FREE_CHART.tools, t);
export const isFreeShot = (width: number): boolean => FREE_CHART.shotWidths.some((w) => w === width);

/** The chart choices as they apply: with Max off, anything outside the free set falls back to the basic one. Max on, they are what was chosen. */
export function entitled<P extends { type: string; interval: string; indicators: readonly string[]; epochs: boolean; fill: boolean; scale: string }>(prefs: P, max: boolean): P {
  if (max) return prefs;
  return {
    ...prefs,
    type: isFreeType(prefs.type) ? prefs.type : FREE_CHART.types[0],
    interval: isFreeInterval(prefs.interval) ? prefs.interval : FREE_CHART.intervals[0],
    indicators: prefs.indicators.filter(isFreeIndicator) as P["indicators"],
    epochs: false,
    fill: false,
    scale: isFreeScale(prefs.scale) ? prefs.scale : FREE_CHART.scales[0],
  };
}
