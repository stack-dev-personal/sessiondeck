import { TOOL_NAME_MAX_CHARS, truncate } from "./limits";
import { readString } from "./payload";
import type { Tracking } from "./snapshot";
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
 * permission: recorded when a row enters waiting_permission (PermissionRequest names its own tool;
 * anything else is the Notification fallback, whose payload names no tool), null on any other target.
 */
function nextPermission(t: Transition, ctx: TransitionContext): Tracking["permission"] {
  if (t.to !== "waiting_permission") return null;
  const tool = t.trigger === "PermissionRequest" ? toolOf(ctx) : null;
  return { tool, agent_id: ctx.agentId };
}

/** The tracking after this transition fired. SessionStart (non-compact) resets all of it. */
export function nextTracking(t: Transition, ctx: TransitionContext): Tracking {
  if (t.trigger === "SessionStart") return createTracking();
  return { last_tool: nextLastTool(t, ctx), permission: nextPermission(t, ctx) };
}
