// Vault archive scanner and incremental index (R5.2). Read-only: it lists
// `<root>/projects/*/sessions/*.md` and `<root>/harness/*/sessions/*.md`, ships one `archive`
// envelope per changed file and remembers (mtime_ms, size) per file in a state file. Unchanged
// files are only stat'ed. An index entry is written only after the envelope was enqueued, so a
// crash re-ships rather than loses.
import { constants as fsc } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ArchiveEnvelopeSchema, isSafeRelPath } from "@sessiondeck/contract";
import { writeFileAtomic } from "../install/atomic.ts";
import { buildEnvelope } from "../envelope.ts";
import type { SpoolLine } from "../spool-format.ts";
import { type SkipReason, normalizeCapture } from "./normalize.ts";

export const ARCHIVE_MAX_FILE_BYTES = 1024 * 1024;
export const ARCHIVE_READ_CONCURRENCY = 16;

export interface ArchiveRoot {
  label: string;
  path: string;
}

type ScanSkip =
  SkipReason | "root_missing" | "symlink" | "not_regular" | "too_large" | "read_error";

export interface ScanStats {
  scanned: number;
  shipped: number;
  unchanged: number;
  skipped: Record<string, number>;
  /** Files whose envelope could not be enqueued; they stay unindexed and ship next scan. */
  failed: number;
  /** Index entries dropped because the file is gone. */
  dropped: number;
  ms: number;
}

interface IndexEntry {
  mtime_ms: number;
  size: number;
  session_id: string | null;
  /** Set for files that were read and skipped, so an unchanged bad file is not re-read. */
  skip?: string;
}
interface IndexFile {
  v: 1;
  entries: Record<string, IndexEntry>;
}

export interface ImporterOptions {
  roots: ArchiveRoot[];
  statePath: string;
  host: string;
  enqueue: (line: SpoolLine) => void | Promise<void>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
  concurrency?: number;
  maxFileBytes?: number;
  /** Polled between files; true stops issuing work (the scan finishes what is in flight). */
  shouldStop?: () => boolean;
}

interface Candidate {
  key: string;
  rootLabel: string;
  rel: string;
  abs: string;
}

/** Runs fn over items with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "ENOENT";

export class ArchiveImporter {
  private index: IndexFile | undefined;
  private readonly now: () => number;

  private readonly o: ImporterOptions;

  constructor(o: ImporterOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  private async loadIndex(): Promise<IndexFile> {
    if (this.index) return this.index;
    let entries: Record<string, IndexEntry> = {};
    try {
      const raw = JSON.parse(await readFile(this.o.statePath, "utf8")) as unknown;
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const e = (raw as { entries?: unknown }).entries;
        if (typeof e === "object" && e !== null && !Array.isArray(e)) {
          for (const [k, v] of Object.entries(e)) {
            const x = v as Partial<IndexEntry> | null;
            if (
              x !== null &&
              typeof x === "object" &&
              Number.isSafeInteger(x.mtime_ms) &&
              Number.isSafeInteger(x.size)
            ) {
              entries[k] = {
                mtime_ms: x.mtime_ms as number,
                size: x.size as number,
                session_id: typeof x.session_id === "string" ? x.session_id : null,
                ...(typeof x.skip === "string" ? { skip: x.skip } : {}),
              };
            }
          }
        }
      }
    } catch {
      entries = {}; // missing or corrupt: everything is re-shipped, which is safe (idempotent hub)
    }
    this.index = { v: 1, entries };
    return this.index;
  }

  /** Lists candidate files; also reports which directories were listed so vanished files can be dropped. */
  private async list(
    root: ArchiveRoot,
    skipped: (r: ScanSkip) => void,
  ): Promise<{ files: Candidate[]; present: Set<string>; goneOk: (rel: string) => boolean }> {
    const files: Candidate[] = [];
    const present = new Set<string>();
    const kindOk = new Map<string, Set<string>>(); // kind -> names listed
    const sessionsOk = new Set<string>(); // "kind/x" whose sessions dir was listed (or is absent)
    let rootExists = true;
    try {
      const st = await lstat(root.path);
      if (!st.isDirectory()) rootExists = false;
    } catch {
      rootExists = false;
    }
    if (!rootExists) {
      this.o.log?.("warn", `archive root ${root.label} is not a directory; skipped`);
      skipped("root_missing");
      return { files, present, goneOk: () => false };
    }
    for (const kind of ["projects", "harness"] as const) {
      let xs: import("node:fs").Dirent[];
      try {
        xs = await readdir(join(root.path, kind), { withFileTypes: true });
      } catch (e) {
        if (isEnoent(e)) kindOk.set(kind, new Set());
        continue;
      }
      const names = new Set<string>();
      kindOk.set(kind, names);
      for (const x of xs) {
        names.add(x.name);
        if (!x.isDirectory()) continue;
        let fs: import("node:fs").Dirent[];
        try {
          fs = await readdir(join(root.path, kind, x.name, "sessions"), { withFileTypes: true });
          sessionsOk.add(`${kind}/${x.name}`);
        } catch (e) {
          if (isEnoent(e)) sessionsOk.add(`${kind}/${x.name}`);
          continue;
        }
        for (const f of fs) {
          if (!f.name.endsWith(".md")) continue;
          const rel = `${kind}/${x.name}/sessions/${f.name}`;
          if (!isSafeRelPath(rel)) {
            skipped("bad_rel_path");
            continue;
          }
          if (f.isSymbolicLink()) {
            skipped("symlink");
            continue;
          }
          const key = `${root.label}:${rel}`;
          present.add(key);
          files.push({
            key,
            rootLabel: root.label,
            rel,
            abs: join(root.path, kind, x.name, "sessions", f.name),
          });
        }
      }
    }
    const goneOk = (rel: string): boolean => {
      const [kind, x] = rel.split("/");
      const names = kindOk.get(kind as string);
      if (!names) return false;
      return !names.has(x as string) || sessionsOk.has(`${kind}/${x}`);
    };
    return { files, present, goneOk };
  }

  /** One scan of every root. Never throws; enqueue failures are counted in `failed`. */
  async scan(): Promise<ScanStats> {
    const t0 = performance.now();
    const stats: ScanStats = {
      scanned: 0,
      shipped: 0,
      unchanged: 0,
      skipped: {},
      failed: 0,
      dropped: 0,
      ms: 0,
    };
    const skip = (r: ScanSkip | string): void => {
      stats.skipped[r] = (stats.skipped[r] ?? 0) + 1;
    };
    const index = await this.loadIndex();
    let dirty = false;
    let failed = false;
    const maxBytes = this.o.maxFileBytes ?? ARCHIVE_MAX_FILE_BYTES;
    const limit = this.o.concurrency ?? ARCHIVE_READ_CONCURRENCY;
    const stop = (): boolean => failed || (this.o.shouldStop?.() ?? false);

    const labels = new Set(this.o.roots.map((r) => r.label));
    const goneChecks: Array<{
      label: string;
      present: Set<string>;
      goneOk: (rel: string) => boolean;
    }> = [];
    const work: Candidate[] = [];
    for (const root of this.o.roots) {
      const l = await this.list(root, skip);
      goneChecks.push({ label: root.label, present: l.present, goneOk: l.goneOk });
      work.push(...l.files);
    }

    await pool(work, limit, async (c) => {
      if (stop()) return;
      stats.scanned += 1;
      let st;
      try {
        st = await lstat(c.abs);
      } catch {
        skip("read_error");
        return;
      }
      if (st.isSymbolicLink()) return skip("symlink");
      if (!st.isFile()) return skip("not_regular");
      if (st.size > maxBytes) return skip("too_large");
      const mtime = Math.floor(st.mtimeMs);
      const prev = index.entries[c.key];
      if (prev && prev.mtime_ms === mtime && prev.size === st.size) {
        if (prev.skip) skip(prev.skip);
        else stats.unchanged += 1;
        return;
      }
      let buf: Buffer;
      let rmtime = mtime;
      let rsize = st.size;
      try {
        const fh = await open(c.abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
        try {
          const fst = await fh.stat();
          if (!fst.isFile()) return skip("not_regular");
          if (fst.size > maxBytes) return skip("too_large");
          rmtime = Math.floor(fst.mtimeMs);
          rsize = fst.size;
          buf = await fh.readFile();
        } finally {
          await fh.close();
        }
      } catch {
        skip("read_error");
        return;
      }
      if (buf.length > maxBytes) return skip("too_large");
      const res = normalizeCapture({
        text: buf.toString("utf8"),
        rootLabel: c.rootLabel,
        relPath: c.rel,
        mtimeMs: rmtime,
        size: rsize,
      });
      if (!res.ok) {
        skip(res.reason);
        index.entries[c.key] = {
          mtime_ms: rmtime,
          size: rsize,
          session_id: null,
          skip: res.reason,
        };
        dirty = true;
        return;
      }
      const env = buildEnvelope({
        kind: "archive",
        host: this.o.host,
        session_id: res.payload.session_id,
        payload: res.payload,
        ts: this.now(),
      });
      // The hub validates the same schema; refuse to ship anything that would be rejected.
      if (!ArchiveEnvelopeSchema.safeParse({ ...env, seq: 0 }).success) {
        skip("invalid_payload");
        index.entries[c.key] = {
          mtime_ms: rmtime,
          size: rsize,
          session_id: null,
          skip: "invalid_payload",
        };
        dirty = true;
        return;
      }
      try {
        await this.o.enqueue(env);
      } catch (e) {
        failed = true;
        stats.failed += 1;
        this.o.log?.(
          "error",
          `archive enqueue failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      index.entries[c.key] = { mtime_ms: rmtime, size: rsize, session_id: res.payload.session_id };
      dirty = true;
      stats.shipped += 1;
    });

    // Drop entries of vanished files, but only where the directory was actually listed.
    if (!failed && !(this.o.shouldStop?.() ?? false)) {
      for (const key of Object.keys(index.entries)) {
        const sep = key.indexOf(":");
        const label = key.slice(0, sep);
        const rel = key.slice(sep + 1);
        let drop = !labels.has(label);
        if (!drop) {
          const g = goneChecks.find((x) => x.label === label);
          drop = g !== undefined && !g.present.has(key) && g.goneOk(rel);
        }
        if (drop) {
          delete index.entries[key];
          stats.dropped += 1;
          dirty = true;
        }
      }
    }

    if (dirty) {
      try {
        await writeFileAtomic(this.o.statePath, JSON.stringify(index), { mode: 0o600 });
      } catch (e) {
        this.o.log?.(
          "error",
          `archive index not saved: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    stats.ms = Math.round(performance.now() - t0);
    const sk = Object.entries(stats.skipped)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    this.o.log?.(
      "info",
      `archive scan scanned=${stats.scanned} shipped=${stats.shipped} unchanged=${stats.unchanged} skipped=${sk || "0"} failed=${stats.failed} dropped=${stats.dropped} ms=${stats.ms}`,
    );
    return stats;
  }
}
