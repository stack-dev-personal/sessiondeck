// Daemon component for the vault archive importer (R5.2, R5.3): scans shortly after start, then
// every intervalSec, never overlapping. It ships `archive` envelopes through ctx.enqueue.
import { ARCHIVE_DEFAULT_INTERVAL_SEC, type ArchiveConfig } from "../config/config.ts";
import { ArchiveImporter, type ScanStats } from "../archive/importer.ts";
import type { ComponentContext, DaemonComponent } from "./types.ts";

export interface ArchiveComponentOptions {
  config: ArchiveConfig;
  statePath: string;
  /** Delay before the first scan (default 5 s, so daemon start is not slowed). */
  initialDelayMs?: number;
  /** Overrides config.intervalSec; tests only. */
  intervalMs?: number;
}

export class ArchiveComponent implements DaemonComponent {
  readonly name = "archive";
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<ScanStats> | undefined;
  private importer: ArchiveImporter | undefined;
  private ctx: ComponentContext | undefined;

  private readonly o: ArchiveComponentOptions;

  constructor(o: ArchiveComponentOptions) {
    this.o = o;
  }

  start(ctx: ComponentContext): void {
    this.ctx = ctx;
    this.stopped = false;
    this.importer = new ArchiveImporter({
      roots: this.o.config.roots,
      statePath: this.o.statePath,
      host: ctx.host,
      enqueue: ctx.enqueue,
      log: ctx.log,
      shouldStop: () => this.stopped,
    });
    this.schedule(this.o.initialDelayMs ?? 5000);
  }

  private intervalMs(): number {
    return this.o.intervalMs ?? (this.o.config.intervalSec ?? ARCHIVE_DEFAULT_INTERVAL_SEC) * 1000;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().finally(() => this.schedule(this.intervalMs()));
    }, ms);
    this.timer.unref();
  }

  /** One scan; a scan already running is returned instead of starting another. */
  runOnce(): Promise<ScanStats> {
    if (this.running) return this.running;
    const importer = this.importer;
    if (!importer) return Promise.reject(new Error("archive component not started"));
    const p = importer.scan().catch((e: unknown) => {
      this.ctx?.log("error", `archive scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return { scanned: 0, shipped: 0, unchanged: 0, skipped: {}, failed: 0, dropped: 0, ms: 0 };
    });
    this.running = p.finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
