// Tracks whether an ingest request is in progress, so background work (retention compaction) can
// yield to it (R2.4: ingest p95 must hold while compaction runs). Holds two numbers and is rebuilt
// empty on restart; nothing depends on it for correctness.

export class IngestActivity {
  private inflight = 0;
  private lastEnd = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** Call when an ingest request starts; call the returned function once when it is over. */
  begin(): () => void {
    this.inflight++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight--;
      this.lastEnd = this.clock();
    };
  }

  /**
   * How long a background batch should wait before it starts: 0 when no request is in flight and
   * the last one ended at least quietMs ago, otherwise the time after which to look again.
   */
  waitMs(quietMs: number): number {
    if (this.inflight > 0) return quietMs;
    return Math.max(0, quietMs - (this.clock() - this.lastEnd));
  }

  get active(): number {
    return this.inflight;
  }
}
