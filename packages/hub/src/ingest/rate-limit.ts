/**
 * Token bucket limiter keyed by string. Ephemeral by design (in-memory, rebuilt empty on restart);
 * it protects the hub from a runaway or hostile sender, it is not state. A batch costs its
 * envelope count (minimum 1), capped at the burst so a batch larger than the burst can still pass
 * once the bucket is full.
 *
 * D-S3-5: keys must be trusted or validated values (the principal digest, a validated host).
 * Buckets are never cleared wholesale: when the table is full only a bucket that has refilled
 * completely (idle, it carries no information) is evicted, oldest-used first. If none is idle the
 * new key is refused, so a flood of keys can never reset a real sender's bucket.
 */
export class RateLimiter {
  // Map iteration order is insertion order; a touched bucket is re-inserted, so the first entry
  // is the least recently used.
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly maxKeys: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost: number): boolean {
    const t = this.now();
    const want = Math.min(Math.max(cost, 1), this.burst);
    let b = this.buckets.get(key);
    if (b === undefined) {
      if (this.buckets.size >= this.maxKeys && !this.evictIdle(t)) return false;
      b = { tokens: this.burst, at: t };
    } else {
      b.tokens = this.refilled(b, t);
      b.at = t;
      this.buckets.delete(key);
    }
    this.buckets.set(key, b);
    if (b.tokens < want) return false;
    b.tokens -= want;
    return true;
  }

  size(): number {
    return this.buckets.size;
  }

  private refilled(b: { tokens: number; at: number }, t: number): number {
    return Math.min(this.burst, b.tokens + (Math.max(0, t - b.at) / 1000) * this.ratePerSec);
  }

  /** Removes the least recently used fully refilled bucket; false when every bucket holds state. */
  private evictIdle(t: number): boolean {
    for (const [k, b] of this.buckets) {
      if (this.refilled(b, t) >= this.burst) {
        this.buckets.delete(k);
        return true;
      }
    }
    return false;
  }
}
