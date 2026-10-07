/**
 * Maps between a time (seconds) and a position on the chart's time axis, counted in candles (0 is the first one, 1.5 is halfway between the
 * second and the third), for any time, including those before the first candle or after the last.
 *
 * Drawings are anchored to a time and a price, not to a candle, so they stay put when the candles get wider or narrower (1h, 4h, 1d), and a
 * line can reach into the future. The chart library only converts times it has a candle for, hence this. Between candles it interpolates;
 * outside them it carries on at `stepSec` per candle.
 */
export class TimeGrid {
  readonly times: number[];
  readonly stepSec: number;

  /** `times` are the candle times in seconds, strictly increasing (gaps may be present). */
  constructor(times: number[], stepSec: number) {
    this.times = times;
    this.stepSec = stepSec > 0 ? stepSec : 3600;
  }

  get empty(): boolean {
    return this.times.length === 0;
  }

  /** Position (in candles) of a time. */
  indexOf(t: number): number {
    const a = this.times;
    if (!a.length) return 0;
    if (t <= a[0]) return (t - a[0]) / this.stepSec;
    const last = a.length - 1;
    if (t >= a[last]) return last + (t - a[last]) / this.stepSec;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - a[lo]) / (a[hi] - a[lo]);
  }

  /** The time at a position (in candles): the inverse of `indexOf`. */
  timeAt(index: number): number {
    const a = this.times;
    if (!a.length) return 0;
    if (index <= 0) return a[0] + index * this.stepSec;
    const last = a.length - 1;
    if (index >= last) return a[last] + (index - last) * this.stepSec;
    const lo = Math.floor(index);
    return a[lo] + (index - lo) * (a[lo + 1] - a[lo]);
  }
}
