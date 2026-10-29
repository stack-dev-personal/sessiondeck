// Pure snapshot updates for the envelope kinds the contract has no reducer for (statusline,
// subagents) and the transcript payload shape. Hook and liveness reduction is the contract's
// reduce() / reduceLiveness(); this file never reimplements them. Time comes only from e.ts so a
// replay reproduces the same snapshots.
import {
  StatusLinePayloadSchema,
  epochSecondsToMs,
  mergeSource,
  normalizeRateLimitWindow,
  type Envelope,
  type RateLimitPeriod,
  type SnapshotSources,
  type SessionSnapshot,
  type SubagentSnapshot,
  type Window,
} from "@sessiondeck/contract";
import { z } from "zod";
import type { SampleRow } from "../db/store.ts";

const MAX_TEXT = 200;
const EMPTY_CONTEXT: SessionSnapshot["context"] = {
  used_pct: null,
  window: null,
  input: null,
  output: null,
};
const cap = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Called with the payload field name each time an out-of-range used_percentage is nulled. */
export type RangeNulled = (field: string) => void;

const inRange = (p: number): boolean => p >= 0 && p <= 100;

/** A stored window whose reset time has passed no longer has a valid percentage. */
function staleCheck(w: Window | null, now: number): Window | null {
  if (w === null || w.resets_at === null || now < w.resets_at || w.used_pct === null) return w;
  return { used_pct: null, resets_at: w.resets_at };
}

/**
 * R2.7 read-time staleness (D-S3-7). The reducer only nulls a past-reset window when another
 * statusline arrives, so an idle session would keep showing an old used_pct. Every read and every
 * broadcast of a snapshot (REST, WS) must pass it through this pure function with the current
 * time. Returns the same object when nothing is stale; never mutates the input.
 */
export function applyRateLimitStaleness(snapshot: SessionSnapshot, nowMs: number): SessionSnapshot {
  const five = staleCheck(snapshot.rate_limits.five_hour, nowMs);
  const seven = staleCheck(snapshot.rate_limits.seven_day, nowMs);
  if (five === snapshot.rate_limits.five_hour && seven === snapshot.rate_limits.seven_day) {
    return snapshot;
  }
  return {
    ...snapshot,
    rate_limits: { ...snapshot.rate_limits, five_hour: five, seven_day: seven },
  };
}

/** Longest path kept in a snapshot (cwd, project_dir); longer values are truncated. */
export const MAX_SNAPSHOT_PATH = 1024;

/** Truncates attacker-sized path fields; returns the same object when within bounds. */
export function clampSnapshot(s: SessionSnapshot): SessionSnapshot {
  if (s.cwd.length <= MAX_SNAPSHOT_PATH && (s.project_dir?.length ?? 0) <= MAX_SNAPSHOT_PATH)
    return s;
  return {
    ...s,
    cwd: s.cwd.slice(0, MAX_SNAPSHOT_PATH),
    project_dir: s.project_dir === null ? null : s.project_dir.slice(0, MAX_SNAPSHOT_PATH),
  };
}

function window(
  raw: RateLimitPeriod | null | undefined,
  prev: Window | null,
  e: Envelope,
  field: string,
  onNulled: RangeNulled,
): Window | null {
  if (raw === undefined) return staleCheck(prev, e.ts);
  const pct = raw?.used_percentage;
  if (typeof pct === "number" && Number.isFinite(pct) && !inRange(pct)) onNulled(field);
  return normalizeRateLimitWindow(raw, e.ts);
}

export function applyStatusLine(
  prev: SessionSnapshot,
  e: Envelope,
  onNulled: RangeNulled,
): { snapshot: SessionSnapshot; sample: SampleRow | null } {
  // Same routing rule as the contract reducer (isForSession): another host's envelope must not
  // overwrite this session's context, cost or rate limits.
  if (e.host !== prev.host || e.session_id !== prev.session_id) {
    return { snapshot: prev, sample: null };
  }
  const parsed = StatusLinePayloadSchema.safeParse(e.payload);
  if (!parsed.success) throw new Error("statusline payload does not match StatusLinePayloadSchema");
  const p = parsed.data;
  const s: SessionSnapshot = { ...prev, last_event_at: Math.max(prev.last_event_at, e.ts) };
  // R2.12: a figure the statusline sets is owned by it from now on (transcripts never overwrite it).
  let sources: SnapshotSources | undefined = prev.sources;
  const own = (key: keyof SnapshotSources): void => {
    sources = mergeSource(sources, key, "statusline");
  };

  const modelRaw = p.model;
  if (typeof modelRaw === "string" && modelRaw !== "") {
    s.model = { id: cap(modelRaw), display_name: cap(modelRaw) };
    own("model");
  } else if (typeof modelRaw === "object" && modelRaw !== null) {
    const id = nonEmpty(modelRaw.id);
    if (id !== null) {
      s.model = { id: cap(id), display_name: cap(nonEmpty(modelRaw.display_name) ?? id) };
      own("model");
    }
  }
  const level = p.effort?.level;
  if (typeof level === "string" && level !== "") s.effort = cap(level);
  const name = nonEmpty(p.session_name);
  if (name !== null) s.session_name = cap(name);
  if (s.cwd === "" && nonEmpty(p.cwd) !== null) s.cwd = cap(p.cwd as string);
  const projectDir = nonEmpty(p.workspace?.project_dir);
  if (projectDir !== null) s.project_dir = projectDir;

  const branch = nonEmpty(p.worktree?.branch);
  const worktree = nonEmpty(p.workspace?.git_worktree) ?? nonEmpty(p.worktree?.name);
  const prNumber = finite(p.pr?.number);
  const prUrl = nonEmpty(p.pr?.url);
  if (branch !== null) own("git_branch");
  s.git = {
    branch: branch !== null ? cap(branch) : prev.git.branch,
    worktree: worktree !== null ? cap(worktree) : prev.git.worktree,
    pr: prNumber !== null && prUrl !== null ? { number: prNumber, url: prUrl } : prev.git.pr,
  };

  const cw = p.context_window;
  if (cw !== undefined && cw !== null) {
    let used: number | null = finite(cw.used_percentage);
    if (used !== null && !inRange(used)) {
      onNulled("context_window.used_percentage");
      used = null;
    }
    // Tokens a transcript filled are not statusline figures: do not carry them into a statusline context.
    const base = prev.sources?.context === "transcript" ? EMPTY_CONTEXT : prev.context;
    s.context = {
      used_pct: cw.used_percentage === undefined ? base.used_pct : used,
      window: cw.context_window_size === undefined ? base.window : finite(cw.context_window_size),
      input: cw.total_input_tokens === undefined ? base.input : finite(cw.total_input_tokens),
      output: cw.total_output_tokens === undefined ? base.output : finite(cw.total_output_tokens),
    };
    own("context");
  }

  const cost = p.cost;
  if (cost !== undefined) {
    s.cost = {
      usd: cost.total_cost_usd === undefined ? prev.cost.usd : finite(cost.total_cost_usd),
      duration_ms:
        cost.total_duration_ms === undefined
          ? prev.cost.duration_ms
          : finite(cost.total_duration_ms),
      lines_added:
        cost.total_lines_added === undefined
          ? prev.cost.lines_added
          : finite(cost.total_lines_added),
      lines_removed:
        cost.total_lines_removed === undefined
          ? prev.cost.lines_removed
          : finite(cost.total_lines_removed),
    };
  }

  if (finite(cost?.total_cost_usd) !== null) own("cost");
  if (sources !== prev.sources) s.sources = sources;

  const rl = p.rate_limits;
  const base = prev.rate_limits;
  if (rl !== undefined && rl !== null) {
    s.rate_limits = {
      five_hour: window(
        rl.five_hour,
        base.five_hour,
        e,
        "rate_limits.five_hour.used_percentage",
        onNulled,
      ),
      seven_day: window(
        rl.seven_day,
        base.seven_day,
        e,
        "rate_limits.seven_day.used_percentage",
        onNulled,
      ),
      captured_at: e.ts,
    };
  } else {
    s.rate_limits = {
      five_hour: staleCheck(base.five_hour, e.ts),
      seven_day: staleCheck(base.seven_day, e.ts),
      captured_at: base.captured_at,
    };
  }

  const pc = p.prompt_cache;
  if (pc !== undefined) {
    const exp = finite(pc.expires_at);
    s.prompt_cache = {
      warm: pc.warm === true,
      expires_at: exp === null ? null : epochSecondsToMs(exp),
    };
  }

  const sample: SampleRow = {
    session_id: s.session_id,
    ts: e.ts,
    context_used_pct: s.context.used_pct,
    cost_usd: s.cost.usd,
    five_hour_pct: s.rate_limits.five_hour?.used_pct ?? null,
    five_hour_resets: s.rate_limits.five_hour?.resets_at ?? null,
    seven_day_pct: s.rate_limits.seven_day?.used_pct ?? null,
    seven_day_resets: s.rate_limits.seven_day?.resets_at ?? null,
  };
  return { snapshot: s, sample };
}

function withoutTranscriptFigures(row: SubagentSnapshot): SubagentSnapshot {
  const { effort: _effort, ...rest } = row;
  void _effort;
  return { ...rest, tokens: null, context_window: null, model: null };
}

const SubagentsPayloadSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          id: z.string(),
          model: z.string().nullish(),
          contextWindowSize: z.number().nullish(),
          tokenCount: z.number().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * subagentStatusLine rows refresh tokens, context window and model of the snapshot's existing
 * subagent rows (matched by agent_id = task id). Rows are created and closed by the hooks
 * SubagentStart and SubagentStop (contract reducer); unmatched tasks are ignored. A task that
 * states at least one figure makes the row statusline-owned (figures_source "subagent_statusline",
 * R2.13): the transcript deriver never touches it afterwards. A task that states none leaves a
 * transcript-filled row as it is, so a null never erases a measured figure. A task that states
 * only some figures over a transcript-filled row nulls the rest (and effort), so a replay, which
 * applies the statusline before any transcript figure exists, agrees with live.
 */
export function applySubagents(prev: SessionSnapshot, e: Envelope): SessionSnapshot {
  if (e.host !== prev.host || e.session_id !== prev.session_id) return prev;
  const parsed = SubagentsPayloadSchema.safeParse(e.payload);
  if (!parsed.success) throw new Error("subagents payload does not match the expected shape");
  const byId = new Map(parsed.data.tasks.map((t) => [t.id, t]));
  const subagents = prev.subagents.map((row) => {
    const t = byId.get(row.agent_id);
    if (t === undefined) return row;
    const states =
      finite(t.tokenCount) !== null ||
      finite(t.contextWindowSize) !== null ||
      nonEmpty(t.model) !== null;
    if (!states && row.figures_source === "transcript") return row;
    // A task that states something takes the whole row over: figures it leaves out were measured
    // from the transcript, not stated by the statusline, so they become null (replay applies the
    // statusline before any transcript figure exists and gets exactly that).
    const base =
      states && row.figures_source === "transcript"
        ? withoutTranscriptFigures(row)
        : row;
    return {
      ...base,
      ...(states ? { figures_source: "subagent_statusline" as const } : {}),
      tokens: t.tokenCount === undefined ? base.tokens : finite(t.tokenCount),
      context_window:
        t.contextWindowSize === undefined ? base.context_window : finite(t.contextWindowSize),
      model: t.model === undefined ? base.model : nonEmpty(t.model),
    };
  });
  return { ...prev, subagents, last_event_at: Math.max(prev.last_event_at, e.ts) };
}

/**
 * Transcript envelope payload (the contract defines none; hub decision, to confirm with the probe
 * tailer S2 and the contract owner): `{ start_line: number, lines: string[] }`. lines are raw JSONL
 * strings and start_line, REQUIRED (no default), is the 0-based line number of lines[0]. A default
 * of 0 would number every chunk from 0 and (session, agent, line_no) conflicts would silently drop
 * all chunks after the first, so a payload without start_line is a reducer exception instead.
 */
const TranscriptPayloadSchema = z.object({
  start_line: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});

export function parseTranscriptPayload(payload: unknown): { line_no: number; raw: string }[] {
  const parsed = TranscriptPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("transcript payload does not match the expected shape");
  return parsed.data.lines.map((raw, i) => ({ line_no: parsed.data.start_line + i, raw }));
}
