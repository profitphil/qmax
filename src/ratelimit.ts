const MAX_IDS = 100_000;

/** Fixed-window limiter: `limit` hits per `windowMs` for each id. */
export class RateLimiter {
  private limit: number;
  private windowMs: number;
  private seen = new Map<string, { count: number; resetAt: number }>();
  private lastPrune = 0;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** How many ids are being tracked (for tests and monitoring). */
  size(): number {
    return this.seen.size;
  }

  hit(id: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    // Forgetting ids whose window is over is a scan of the whole map, so it is done at most once a second, and the map never holds more
    // than MAX_IDS (the oldest are dropped first: an attacker rotating ids can only push out other idle ones).
    if (this.seen.size > 10_000 && now - this.lastPrune >= 1000) {
      this.lastPrune = now;
      for (const [k, v] of this.seen) if (v.resetAt <= now) this.seen.delete(k);
      for (const k of this.seen.keys()) {
        if (this.seen.size <= MAX_IDS) break;
        this.seen.delete(k);
      }
    }
    let w = this.seen.get(id);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.seen.set(id, w);
    }
    // The cap holds at once, not only at the next sweep: a new id past it pushes out the oldest one (the first in the map).
    if (this.seen.size > MAX_IDS) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined && oldest !== id) this.seen.delete(oldest);
    }
    if (w.count >= this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
    w.count++;
    return { ok: true };
  }
}
