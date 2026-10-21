import type { Envelope } from "@sessiondeck/contract";
import type { SpoolLine } from "../spool-format.ts";

/** Position in a directory of day files: file base name and byte offset of the next unread byte. */
export interface Cursor {
  file: string;
  offset: number;
}

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;

/** What a component may use. */
export interface ComponentContext {
  home: string;
  host: string;
  log: Logger;
  /** Queues a daemon-originated envelope (no seq) in the outbox. */
  enqueue: (line: SpoolLine) => void;
}

/**
 * Hook point for later units (transcript tailer, liveness). Components are started before the forwarder, after the
 * daemon state is loaded and stopped before it exits. onSpoolLine sees every hook-spool envelope
 * when its batch is closed, and again if a pending batch is resent after a restart; it is
 * at-least-once, so implementations must be idempotent.
 */
export interface DaemonComponent {
  name: string;
  start?(ctx: ComponentContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  onSpoolLine?(env: Envelope): void;
}
