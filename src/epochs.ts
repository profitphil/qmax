/**
 * Qubic epochs. An epoch is one week, and it begins on Wednesday at 12:00 UTC. Epoch 207 began on 2026-04-01 (the archive's trade records start there)
 * and the network was on epoch 233 on 2026-10-06, which this count gives. The network can start an epoch a few minutes after the hour, so these are the
 * times an epoch is due to begin, good for drawing a line on a chart, not for telling which epoch a given tick belongs to (ticks say that themselves).
 */
export const EPOCH_MS = 7 * 24 * 3_600_000;
const EPOCH_207_START = Date.UTC(2026, 3, 1, 12, 0, 0);

/** When an epoch is due to begin, in ms since 1970. */
export const epochStartMs = (epoch: number): number => EPOCH_207_START + (epoch - 207) * EPOCH_MS;

/** The epoch running at a time. */
export const epochAt = (ms: number): number => 207 + Math.floor((ms - EPOCH_207_START) / EPOCH_MS);

/** The epochs that begin between two times (both ends included), oldest first. Empty if the range is backwards or not finite. */
export function epochsIn(fromMs: number, toMs: number): { epoch: number; startMs: number }[] {
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs)) || toMs < fromMs) return [];
  const out: { epoch: number; startMs: number }[] = [];
  const first = epochAt(fromMs) + (epochStartMs(epochAt(fromMs)) >= fromMs ? 0 : 1);
  for (let e = first, start = epochStartMs(first); start <= toMs && out.length < 1000; e++, start = epochStartMs(e)) out.push({ epoch: e, startMs: start });
  return out;
}
