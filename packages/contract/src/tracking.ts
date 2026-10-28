import { AGENT_ID_MAX_CHARS, PENDING_SPAWNS_MAX, TOOL_NAME_MAX_CHARS, truncate } from "./limits";
import { asRecord, readString } from "./payload";
import type { PermissionHolder, SessionSnapshot, Tracking } from "./snapshot";
import { createTracking } from "./snapshot";
import type { Transition, TransitionContext } from "./transitions";

/** The tool name of a tool event payload, capped, or null when absent or not a string. */
function toolOf(ctx: TransitionContext): string | null {
  const name = readString(ctx.payload, "tool_name");
  return name === null ? null : truncate(name, TOOL_NAME_MAX_CHARS);
}

/** last_tool: written by main-thread PreToolUse only, cleared by UserPromptSubmit and Stop. */
function nextLastTool(t: Transition, ctx: TransitionContext): string | null {
  switch (t.trigger) {
    case "UserPromptSubmit":
    case "Stop":
      return null;
    case "PreToolUse":
      return ctx.agentId === null ? toolOf(ctx) : ctx.prev.tracking.last_tool;
    default:
      return ctx.prev.tracking.last_tool;
  }
}

/**
 * permission: recorded when a row enters waiting_permission, null on any other target.
 * PermissionRequest names its own tool and asker (agent_id null: main thread). Anything else is the
 * Notification fallback: its payload names no tool, and a Notification without agent_id cannot
 * say which context asked (hooks doc: agent_id appears only inside a subagent, and sandboxed
 * network prompts fire only this Notification), so the requester is recorded as unknown.
 */
function nextPermission(t: Transition, ctx: TransitionContext): Tracking["permission"] {
  if (t.to !== "waiting_permission") return null;
  if (t.trigger === "PermissionRequest") return { tool: toolOf(ctx), agent_id: ctx.agentId };
  if (ctx.agentId === null) return { tool: null, requester_unknown: true };
  return { tool: null, agent_id: ctx.agentId };
}

/** The tracking after this transition fired. SessionStart (non-compact) resets all of it. */
export function nextTracking(t: Transition, ctx: TransitionContext): Tracking {
  if (t.trigger === "SessionStart") return createTracking();
  return { last_tool: nextLastTool(t, ctx), permission: nextPermission(t, ctx) };
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readHolder(value: unknown): PermissionHolder | null {
  const record = asRecord(value);
  if (record["requester_unknown"] === true) return { tool: null, requester_unknown: true };
  const { tool, agent_id: agentId } = record;
  return isStringOrNull(tool) && isStringOrNull(agentId) ? { tool, agent_id: agentId } : null;
}

/**
 * A well-formed tracking from whatever a stored snapshot carries. A missing or malformed part
 * counts as empty, so the reducer never throws on a snapshot persisted without (or with a damaged)
 * tracking. Always a fresh object.
 */
export function readTracking(value: unknown): Tracking {
  const record = asRecord(value);
  const lastTool = record["last_tool"];
  const base: Tracking = {
    last_tool: typeof lastTool === "string" ? lastTool : null,
    permission: readHolder(record["permission"]),
  };
  const raw = record["pending_spawns"];
  const pending = Array.isArray(raw)
    ? raw
        .filter((x): x is string | null => isStringOrNull(x))
        .map((x) => (x === null ? null : truncate(x, AGENT_ID_MAX_CHARS)))
        .slice(-PENDING_SPAWNS_MAX)
    : [];
  if (pending.length === 0) return base;
  const amb = record["ambiguous_remaining"];
  const n = typeof amb === "number" && Number.isInteger(amb) ? Math.min(amb, pending.length) : 0;
  return { ...base, pending_spawns: pending, ...(n > 0 ? { ambiguous_remaining: n } : {}) };
}

/** The snapshot with its tracking replaced by readTracking(tracking). */
export function withReadTracking(s: SessionSnapshot): SessionSnapshot {
  return { ...s, tracking: readTracking(s.tracking) };
}
