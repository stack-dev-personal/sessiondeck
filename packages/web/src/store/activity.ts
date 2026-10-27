import type { SessionSnapshot } from "@sessiondeck/contract";
import { STATE_VOCAB } from "../lib/state-vocab";

/** Rows kept per session. The oldest row drops first. */
export const ACTIVITY_CAP = 500;
/** Longest row text; payload strings are untrusted and can be huge. */
const MAX_TEXT = 160;

export type ActivityKind =
  "state" | "tool" | "prompt" | "reply" | "agent" | "task" | "usage" | "event";

/** One line of the live list. `n` counts up per session for the life of the buffer (a stable key). */
export interface ActivityRow {
  n: number;
  ts: number;
  kind: ActivityKind;
  /** Text glyph; the kind label is always shown next to it, never color alone. */
  glyph: string;
  text: string;
}

export interface ActivityLog {
  /** Oldest first, at most ACTIVITY_CAP. */
  rows: ActivityRow[];
  /** Rows ever appended; the next row gets n = total. */
  total: number;
}

export const KIND_LABEL: Record<ActivityKind, string> = {
  state: "state",
  tool: "tool",
  prompt: "prompt",
  reply: "reply",
  agent: "agents",
  task: "tasks",
  usage: "usage",
  event: "event",
};
const GLYPH: Record<ActivityKind, string> = {
  state: "●",
  tool: "▸",
  prompt: "›",
  reply: "‹",
  agent: "◇",
  task: "▪",
  usage: "∑",
  event: "·",
};

export const EMPTY_LOG: ActivityLog = Object.freeze({ rows: [], total: 0 }) as ActivityLog;

type Draft = Pick<ActivityRow, "kind" | "text">;

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
};

/**
 * What changed between two snapshots of one session, as rows. `hook` (the envelope's hook event
 * name, when there was one) gives an "event" row when nothing visible changed, so every hook the
 * pane saw leaves a trace. Hub snapshot deltas pass no hook name and add rows only for changes.
 * Pure; `before` undefined means the first sight of the session.
 */
export function draftRows(
  before: SessionSnapshot | undefined,
  after: SessionSnapshot,
  hook?: string,
): Draft[] {
  const out: Draft[] = [];
  if (before === undefined || before.state !== after.state) {
    const v = STATE_VOCAB[after.state];
    out.push({
      kind: "state",
      text: clip(`${v.glyph} ${v.label}${after.state_detail ? `: ${after.state_detail}` : ""}`),
    });
  }
  const tool = after.tracking.last_tool;
  if (tool !== null && tool !== before?.tracking.last_tool) {
    out.push({ kind: "tool", text: clip(tool) });
  }
  if (after.last_prompt !== null && after.last_prompt !== before?.last_prompt) {
    out.push({ kind: "prompt", text: clip(after.last_prompt) });
  }
  if (
    after.last_assistant_message !== null &&
    after.last_assistant_message !== before?.last_assistant_message
  ) {
    out.push({ kind: "reply", text: clip(after.last_assistant_message) });
  }
  const active = (s: SessionSnapshot | undefined) =>
    s ? s.subagents.filter((a) => a.ended_at === null).length : 0;
  if (before !== undefined && active(before) !== active(after)) {
    out.push({ kind: "agent", text: `${active(after)} active` });
  }
  if (
    before !== undefined &&
    (before.tasks.total !== after.tasks.total || before.tasks.completed !== after.tasks.completed)
  ) {
    const subject = after.tasks.last_subject ? ` ${after.tasks.last_subject}` : "";
    out.push({
      kind: "task",
      text: clip(`${after.tasks.completed}/${after.tasks.total} done${subject}`),
    });
  }
  if (
    (after.context.used_pct !== null && after.context.used_pct !== before?.context.used_pct) ||
    (after.cost.usd !== null && after.cost.usd !== before?.cost.usd)
  ) {
    const ctx = after.context.used_pct === null ? "n/a" : `${Math.round(after.context.used_pct)}%`;
    const usd = after.cost.usd === null ? "n/a" : `$${after.cost.usd.toFixed(2)}`;
    out.push({ kind: "usage", text: `ctx ${ctx} · ${usd}` });
  }
  if (out.length === 0 && hook !== undefined) out.push({ kind: "event", text: clip(hook) });
  return out;
}

/** Appends to a copy of the log, dropping the oldest rows beyond the cap. Never mutates `prev`. */
export function appendRows(
  prev: ActivityLog | undefined,
  ts: number,
  drafts: readonly Draft[],
): ActivityLog {
  const log = prev ?? EMPTY_LOG;
  if (drafts.length === 0) return log;
  const rows = log.rows.concat(
    drafts.map((d, i) => ({
      n: log.total + i,
      ts,
      kind: d.kind,
      glyph: GLYPH[d.kind],
      text: d.text,
    })),
  );
  return {
    rows: rows.length > ACTIVITY_CAP ? rows.slice(rows.length - ACTIVITY_CAP) : rows,
    total: log.total + drafts.length,
  };
}
