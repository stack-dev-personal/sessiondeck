import type { Envelope } from "./envelope";
import {
  AGENT_ID_MAX_CHARS,
  AGENT_TYPE_MAX_CHARS,
  END_REASON_MAX_CHARS,
  LAST_MESSAGE_MAX_CHARS,
  LAST_PROMPT_MAX_CHARS,
  MODEL_ID_MAX_CHARS,
  SUBAGENT_ROWS_MAX,
  truncate,
} from "./limits";
import type { PayloadRecord } from "./payload";
import { isSubagentEnvelope, readString } from "./payload";
import type { SessionSnapshot, SubagentSnapshot } from "./snapshot";

/** Fallbacks used when a documented field is missing or of the wrong type. */
const UNKNOWN_END_REASON = "unknown";
const UNKNOWN_AGENT_TYPE = "unknown";

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

/** The payload agent_id, capped the same way as on rows; null when absent or not a string. */
function payloadAgentId(ctx: FieldContext): string | null {
  const id = readString(ctx.payload, "agent_id");
  return id === null ? null : truncate(id, AGENT_ID_MAX_CHARS);
}

/** At most SUBAGENT_ROWS_MAX rows: the oldest ended rows go first, a running row only when all run. */
function capSubagents(rows: readonly SubagentSnapshot[]): SubagentSnapshot[] {
  const excess = rows.length - SUBAGENT_ROWS_MAX;
  if (excess <= 0) return [...rows];
  const indices = rows.map((_, i) => i);
  const ended = indices.filter((i) => rows[i]?.ended_at !== null);
  const running = indices.filter((i) => rows[i]?.ended_at === null);
  const dropped = new Set([...ended, ...running].slice(0, excess));
  return rows.filter((_, i) => !dropped.has(i));
}

function onSubagentStart(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const agentId = payloadAgentId(ctx);
  if (agentId === null || s.subagents.some((a) => a.agent_id === agentId)) return s;
  const agentType = readString(ctx.payload, "agent_type") ?? UNKNOWN_AGENT_TYPE;
  const row = {
    agent_id: agentId,
    agent_type: truncate(agentType, AGENT_TYPE_MAX_CHARS),
    started_at: ctx.e.ts,
    ended_at: null,
    tokens: null,
    context_window: null,
    model: null,
  };
  return { ...s, subagents: capSubagents([...s.subagents, row]) };
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
  UserPromptSubmit: onUserPromptSubmit,
  Stop: onStop,
  SessionEnd: onSessionEnd,
  PostCompact: onPostCompact,
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
