import type { Envelope } from "./envelope";
import {
  AGENT_ID_MAX_CHARS,
  AGENT_TYPE_MAX_CHARS,
  END_REASON_MAX_CHARS,
  LAST_MESSAGE_MAX_CHARS,
  LAST_PROMPT_MAX_CHARS,
  MODEL_ID_MAX_CHARS,
  STATE_DETAIL_MAX_CHARS,
  PENDING_SPAWNS_MAX,
  SUBAGENT_ROWS_MAX,
  TASK_SUBJECT_MAX_CHARS,
  truncate,
} from "./limits";
import type { PayloadRecord } from "./payload";
import { agentIdOf, isSubagentEnvelope, readString } from "./payload";
import type { SessionSnapshot, SubagentSnapshot } from "./snapshot";
import { normalizeSubagentLinks, reachesAgent } from "./subagent-links";

/** Fallbacks used when a documented field is missing or of the wrong type. */
const UNKNOWN_END_REASON = "unknown";
const UNKNOWN_AGENT_TYPE = "unknown";
const COMPACT_DETAIL_PREFIX = "compact:";

interface FieldContext {
  readonly e: Envelope;
  readonly payload: PayloadRecord;
}

type FieldPatch = (s: SessionSnapshot, ctx: FieldContext) => SessionSnapshot;

function onSessionStart(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const rawModel = readString(ctx.payload, "model");
  const modelId = rawModel === null ? null : truncate(rawModel, MODEL_ID_MAX_CHARS);
  const model =
    modelId === null || s.model?.id === modelId ? s.model : { id: modelId, display_name: modelId };
  return { ...s, model };
}

function onUserPromptSubmit(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const prompt = readString(ctx.payload, "prompt");
  return prompt === null ? s : { ...s, last_prompt: truncate(prompt, LAST_PROMPT_MAX_CHARS) };
}

function onStop(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const message = readString(ctx.payload, "last_assistant_message");
  if (message === null || isSubagentEnvelope(ctx.e)) return s;
  return { ...s, last_assistant_message: truncate(message, LAST_MESSAGE_MAX_CHARS) };
}

function onSessionEnd(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  if (isSubagentEnvelope(ctx.e)) return s;
  const reason = readString(ctx.payload, "reason") ?? UNKNOWN_END_REASON;
  return { ...s, ended_reason: truncate(reason, END_REASON_MAX_CHARS) };
}

function onPostCompact(s: SessionSnapshot): SessionSnapshot {
  return { ...s, compactions: s.compactions + 1 };
}

/**
 * PreCompact: the trigger (manual or auto) goes into state_detail, but only while working. PostCompact
 * clears the detail only from the states it moves to working; from any other state the text would
 * stay behind. The state itself never changes here.
 */
function onPreCompact(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const trigger = readString(ctx.payload, "trigger");
  if (trigger === null || s.state !== "working") return s;
  return {
    ...s,
    state_detail: truncate(`${COMPACT_DETAIL_PREFIX}${trigger}`, STATE_DETAIL_MAX_CHARS),
  };
}

/** The subject of a task event (TaskCreated, TaskCompleted), capped; the previous one when absent. */
function taskSubject(s: SessionSnapshot, ctx: FieldContext): string | null {
  const subject = readString(ctx.payload, "task_subject");
  return subject === null ? s.tasks.last_subject : truncate(subject, TASK_SUBJECT_MAX_CHARS);
}

function onTaskCreated(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  return {
    ...s,
    tasks: { ...s.tasks, total: s.tasks.total + 1, last_subject: taskSubject(s, ctx) },
  };
}

/** completed + 1; total follows when the task was created before the probe saw the session. */
function onTaskCompleted(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const completed = s.tasks.completed + 1;
  const total = Math.max(s.tasks.total, completed);
  return { ...s, tasks: { total, completed, last_subject: taskSubject(s, ctx) } };
}

/** The payload agent_id, capped the same way as on rows; null when absent or not a string. */
function payloadAgentId(ctx: FieldContext): string | null {
  const id = readString(ctx.payload, "agent_id");
  return id === null ? null : truncate(id, AGENT_ID_MAX_CHARS);
}

/**
 * At most SUBAGENT_ROWS_MAX rows: the oldest ended rows go first, a running row only when all run.
 * Links that pointed at a dropped row are cleared (null / unknown) so none dangles.
 */
function capSubagents(rows: readonly SubagentSnapshot[]): SubagentSnapshot[] {
  const excess = rows.length - SUBAGENT_ROWS_MAX;
  if (excess <= 0) return normalizeSubagentLinks(rows);
  const indices = rows.map((_, i) => i);
  const ended = indices.filter((i) => rows[i]?.ended_at !== null);
  const running = indices.filter((i) => rows[i]?.ended_at === null);
  const dropped = new Set([...ended, ...running].slice(0, excess));
  return normalizeSubagentLinks(rows.filter((_, i) => !dropped.has(i)));
}

const SPAWN_TOOLS: readonly string[] = ["Agent", "Task"];

/**
 * With the spawn bookkeeping replaced (keys omitted when empty). The taint flag lives only while the
 * queue is non-empty: an empty queue ends the window.
 */
function withPending(
  s: SessionSnapshot,
  pending: (string | null)[],
  tainted = false,
): SessionSnapshot {
  const { pending_spawns: _p, pending_tainted: _t, ...rest } = s.tracking;
  void _p;
  void _t;
  return {
    ...s,
    tracking: {
      ...rest,
      ...(pending.length === 0 ? {} : { pending_spawns: pending }),
      ...(pending.length > 0 && tainted ? { pending_tainted: true as const } : {}),
    },
  };
}

function taintedOf(s: SessionSnapshot): boolean {
  return s.tracking.pending_tainted === true;
}

function spawnToolOf(ctx: FieldContext): boolean {
  const tool = readString(ctx.payload, "tool_name");
  return tool !== null && SPAWN_TOOLS.includes(tool);
}

/**
 * PreToolUse of the Agent or Task tool: remember which context asked for a spawn. The window (the
 * span while the queue is non-empty) is tainted when this spawn's context differs from a pending
 * one, or when the cap drops entries (their contexts are lost).
 */
function onPreToolUse(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  if (!spawnToolOf(ctx)) return s;
  const before = s.tracking.pending_spawns ?? [];
  const who = agentIdOf(ctx.e);
  const all = [...before, who];
  const dropped = Math.max(0, all.length - PENDING_SPAWNS_MAX);
  const mixed = before.some((c) => c !== who);
  return withPending(s, all.slice(dropped), taintedOf(s) || mixed || dropped > 0);
}

/**
 * A failed Agent or Task call never starts a subagent, but which pending entry it belonged to cannot
 * be told (the spawn may already have been consumed by a start). When every pending entry shares one
 * context, any of them may be dropped without changing what the rest mean, so one is dropped and the
 * window keeps its state. With more than one context pending the window is tainted. Fixtures show
 * PostToolUseFailure with tool_name; no fixture shows it for Agent, and PermissionDenied has no
 * fixture, so only PostToolUseFailure is handled.
 */
function onPostToolUseFailure(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  if (!spawnToolOf(ctx)) return s;
  const pending = s.tracking.pending_spawns ?? [];
  if (pending.length === 0) return s;
  if (new Set(pending).size > 1) return withPending(s, [...pending], true);
  return withPending(s, pending.slice(1), taintedOf(s));
}

/** A new prompt starts a new turn: spawn requests that never produced a SubagentStart are stale. */
function onPromptReset(s: SessionSnapshot): SessionSnapshot {
  return s.tracking.pending_spawns === undefined && s.tracking.pending_tainted === undefined
    ? s
    : withPending(s, []);
}

/**
 * Parent attribution by window. SubagentStart takes the oldest pending spawn. The parent is known
 * only when the window is untainted (every spawn queued since the queue was last empty came from one
 * context, no cap drop, no mixed failure). Otherwise parent_known is false for this start and for
 * every later start until the queue is empty again. The entry is consumed either way.
 */
function takeParent(s: SessionSnapshot): {
  parent: string | null;
  known: boolean;
  rest: (string | null)[];
  tainted: boolean;
} {
  const pending = s.tracking.pending_spawns ?? [];
  if (pending.length === 0) return { parent: null, known: false, rest: [], tainted: false };
  const rest = pending.slice(1);
  const tainted = taintedOf(s);
  return { parent: pending[0] ?? null, known: !tainted, rest, tainted };
}

function onSubagentStart(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const agentId = payloadAgentId(ctx);
  if (agentId === null || s.subagents.some((a) => a.agent_id === agentId)) return s;
  const taken = takeParent(s);
  // A link is kept only when it is the main thread or an existing row (no dangling or looping links).
  const linkable =
    taken.known &&
    taken.parent !== agentId &&
    (taken.parent === null || s.subagents.some((a) => a.agent_id === taken.parent)) &&
    !reachesAgent(s.subagents, taken.parent, agentId);
  const agentType = readString(ctx.payload, "agent_type") ?? UNKNOWN_AGENT_TYPE;
  const row = {
    agent_id: agentId,
    agent_type: truncate(agentType, AGENT_TYPE_MAX_CHARS),
    started_at: ctx.e.ts,
    ended_at: null,
    tokens: null,
    context_window: null,
    model: null,
    parent_agent_id: linkable ? taken.parent : null,
    parent_known: linkable,
  };
  return {
    ...withPending(s, taken.rest, taken.tainted),
    subagents: capSubagents([...s.subagents, row]),
  };
}

function onSubagentStop(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const agentId = payloadAgentId(ctx);
  const open = s.subagents.some((a) => a.agent_id === agentId && a.ended_at === null);
  if (!open) return s;
  const subagents = s.subagents.map((a) =>
    a.agent_id === agentId && a.ended_at === null ? { ...a, ended_at: ctx.e.ts } : a,
  );
  return { ...s, subagents };
}

const FIELD_PATCHES: Readonly<Record<string, FieldPatch>> = {
  SessionStart: onSessionStart,
  UserPromptSubmit: (s, ctx) => onPromptReset(onUserPromptSubmit(s, ctx)),
  PreToolUse: onPreToolUse,
  PostToolUseFailure: onPostToolUseFailure,
  Stop: onStop,
  SessionEnd: onSessionEnd,
  PostCompact: onPostCompact,
  PreCompact: onPreCompact,
  TaskCreated: onTaskCreated,
  TaskCompleted: onTaskCompleted,
  SubagentStart: onSubagentStart,
  SubagentStop: onSubagentStop,
};

/** Applies the per-event snapshot field updates (not state). Unknown events change nothing. */
export function applyEventFields(
  s: SessionSnapshot,
  eventName: string,
  e: Envelope,
  payload: PayloadRecord,
): SessionSnapshot {
  const patch = Object.hasOwn(FIELD_PATCHES, eventName) ? FIELD_PATCHES[eventName] : undefined;
  return patch === undefined ? s : patch(s, { e, payload });
}
