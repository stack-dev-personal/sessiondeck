/**
 * Per-host token bucket. Ephemeral by design (in-memory, rebuilt empty on restart); it protects the
 * hub from a runaway probe, it is not state. A batch costs its envelope count (minimum 1), capped
 * at the burst so a batch larger than the burst can still pass once the bucket is full.
 */
export class HostRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private static readonly MAX_HOSTS = 1000;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(host: string, cost: number): boolean {
    const t = this.now();
    const want = Math.min(Math.max(cost, 1), this.burst);
    let b = this.buckets.get(host);
    if (b === undefined) {
      if (this.buckets.size >= HostRateLimiter.MAX_HOSTS) this.prune(t);
      b = { tokens: this.burst, at: t };
      this.buckets.set(host, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.ratePerSec);
      b.at = t;
    }
    if (b.tokens < want) return false;
    b.tokens -= want;
    return true;
  }

  /** Drops buckets that have refilled completely (they carry no information). */
  private prune(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.ratePerSec >= this.burst) this.buckets.delete(k);
    }
    if (this.buckets.size >= HostRateLimiter.MAX_HOSTS) this.buckets.clear();
  }
}
