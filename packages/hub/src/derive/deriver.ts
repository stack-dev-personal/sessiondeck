// R2.12. Per-session transcript figures, kept incrementally. A cache entry is the figures of the
// session's main transcript (agent_id '') plus the newest line_no seen, so a batch folds only its
// fresh lines (no rescan). The cache holds nothing the database cannot rebuild: a miss, an
// out-of-order line, or a rollback all fall back to a backward scan of the stored lines, and replay
// uses that same scan, so live ingest and replay agree. Entries are keyed by (session_id, agent_id)
// so the subagent unit (R2.13) can reuse the class; only agent '' is derived here.
import type { Store } from "../db/store.ts";
import {
  EMPTY_FIGURES,
  foldBackward,
  foldForward,
  isComplete,
  type FoldResult,
  type TranscriptFigures,
} from "./figures.ts";

export interface DeriverLog {
  warn(obj: object, msg: string): void;
}

const PAGE = 200;
/**
 * A rebuild reads at most this many of the newest stored lines. A session with no git branch (run
 * outside a repository) or no text-bearing assistant row never completes, and without a bound its
 * first ingest after a restart would page the whole transcript inside the ingest transaction.
 * Replay rebuilds through the same function, so the bound never makes it differ from ingest.
 */
export const REBUILD_MAX_LINES = 2000;
const CACHE_MAX = 2000;

export class TranscriptDeriver {
  private readonly cache = new Map<string, TranscriptFigures>();

  constructor(
    private readonly store: Store,
    private readonly log: DeriverLog,
  ) {}

  private key(sessionId: string, agentId: string): string {
    return `${sessionId}\u0000${agentId}`;
  }

  /**
   * Figures after `fresh` lines were stored (ascending line_no). Folds them onto the cached entry;
   * rebuilds from the store on a miss or when any fresh line is not newer than the newest seen.
   */
  update(
    sessionId: string,
    agentId: string,
    fresh: readonly { line_no: number; raw: string }[],
  ): TranscriptFigures {
    const k = this.key(sessionId, agentId);
    const cached = this.cache.get(k);
    const sorted = [...fresh].sort((a, b) => a.line_no - b.line_no);
    const first = sorted[0];
    if (cached === undefined || (first !== undefined && first.line_no <= cached.maxLine)) {
      return this.remember(k, this.rebuild(sessionId, agentId));
    }
    const r = foldForward(cached, sorted);
    this.report(sessionId, r.malformed);
    return this.remember(k, r.figures);
  }

  /** Newest value of each figure from the stored lines, scanning backwards in pages. */
  rebuild(sessionId: string, agentId: string): TranscriptFigures {
    if (agentId !== "") return EMPTY_FIGURES; // subagent transcripts: R2.13
    let acc = EMPTY_FIGURES;
    let malformed = 0;
    let before = Number.MAX_SAFE_INTEGER;
    let scanned = 0;
    while (scanned < REBUILD_MAX_LINES) {
      const limit = Math.min(PAGE, REBUILD_MAX_LINES - scanned);
      const page = this.store.listMainLinesBefore(sessionId, before, limit);
      if (page.length === 0) break;
      scanned += page.length;
      const r: FoldResult = foldBackward(acc, page);
      acc = r.figures;
      malformed += r.malformed;
      if (isComplete(acc) || page.length < limit) break;
      before = (page[page.length - 1] as { line_no: number }).line_no;
    }
    this.report(sessionId, malformed);
    return acc;
  }

  private remember(k: string, f: TranscriptFigures): TranscriptFigures {
    this.cache.delete(k);
    this.cache.set(k, f);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return f;
  }

  private report(sessionId: string, malformed: number): void {
    if (malformed > 0) {
      this.log.warn(
        { session_id: sessionId.slice(0, 64), malformed },
        "transcript lines with unparseable JSON ignored",
      );
    }
  }
}
