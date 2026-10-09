import type { Envelope } from "./envelope";
import type { PayloadRecord } from "./payload";
import { isSubagentEnvelope, readString } from "./payload";
import type { SessionSnapshot } from "./snapshot";

/** Fallbacks used when a documented field is missing or of the wrong type. */
const UNKNOWN_END_REASON = "unknown";
const UNKNOWN_AGENT_TYPE = "unknown";

interface FieldContext {
  readonly e: Envelope;
  readonly payload: PayloadRecord;
}

type FieldPatch = (s: SessionSnapshot, ctx: FieldContext) => SessionSnapshot;

function onSessionStart(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const modelId = readString(ctx.payload, "model");
  const model =
    modelId === null || s.model?.id === modelId ? s.model : { id: modelId, display_name: modelId };
  return { ...s, model, ended_reason: null };
}

function onUserPromptSubmit(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const prompt = readString(ctx.payload, "prompt");
  return prompt === null ? s : { ...s, last_prompt: prompt };
}

function onStop(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const message = readString(ctx.payload, "last_assistant_message");
  if (message === null || isSubagentEnvelope(ctx.e)) return s;
  return { ...s, last_assistant_message: message };
}

function onSessionEnd(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  if (isSubagentEnvelope(ctx.e)) return s;
  return { ...s, ended_reason: readString(ctx.payload, "reason") ?? UNKNOWN_END_REASON };
}

function onPostCompact(s: SessionSnapshot): SessionSnapshot {
  return { ...s, compactions: s.compactions + 1 };
}

function onSubagentStart(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const agentId = readString(ctx.payload, "agent_id");
  if (agentId === null || s.subagents.some((a) => a.agent_id === agentId)) return s;
  const row = {
    agent_id: agentId,
    agent_type: readString(ctx.payload, "agent_type") ?? UNKNOWN_AGENT_TYPE,
    started_at: ctx.e.ts,
    ended_at: null,
    tokens: null,
    context_window: null,
    model: null,
  };
  return { ...s, subagents: [...s.subagents, row] };
}

function onSubagentStop(s: SessionSnapshot, ctx: FieldContext): SessionSnapshot {
  const agentId = readString(ctx.payload, "agent_id");
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
