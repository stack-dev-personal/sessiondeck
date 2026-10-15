// Builds the inventory text: event -> count -> distinct top-level key sets. Key names only.
import { keysOf, listEvents, readEvent } from "./fixture-files.mjs";
import { HOOK_EVENTS } from "./hook-events.mjs";

/** How to make Claude Code fire each registered hook event, shown for events with no captures. */
export const TRIGGER_HINTS = Object.freeze({
  SessionStart: "start a new claude session",
  UserPromptSubmit: "submit any prompt",
  PreToolUse: "let Claude run any tool",
  PostToolUse: "let Claude run any tool to completion",
  PostToolUseFailure: "make a tool fail, for example read a file that does not exist",
  PermissionRequest: "run a tool that needs approval in default permission mode",
  PermissionDenied: "deny a permission prompt, or trigger an auto-mode denial",
  Notification: "leave a permission or idle prompt unanswered",
  SubagentStart: "ask Claude to delegate work to a subagent",
  SubagentStop: "let a subagent finish",
  TaskCreated: "create a task with the task tools (agent-team sessions)",
  TaskCompleted: "complete a task with the task tools (agent-team sessions)",
  Stop: "let Claude finish a turn",
  StopFailure: "end a turn with an API error, for example a rate limit",
  PreCompact: "run /compact",
  PostCompact: "run /compact and let it finish",
  SessionEnd: "exit the session with /exit or /clear",
});

/**
 * Structural type of a value, never the value itself.
 * @param {unknown} v
 */
function typeOf(v) {
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

/** Identifier-like keys are structure; anything else (free-text map keys) is content. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;

/** @param {string} k */
function safeKey(k) {
  return SAFE_KEY.test(k) || /^-[A-Za-z]$/.test(k) ? k : "<key>";
}

/**
 * Key paths with value types (no values), nested objects expanded, arrays summarised by the
 * union of their element shapes.
 * @param {unknown} v
 * @param {string} prefix
 * @param {Set<string>} out
 */
export function collectShapes(v, prefix, out) {
  if (Array.isArray(v)) {
    for (const el of v) collectShapes(el, `${prefix}[]`, out);
    if (v.length === 0) out.add(`${prefix}[]: empty`);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const p = prefix === "" ? safeKey(k) : `${prefix}.${safeKey(k)}`;
      const child = /** @type {Record<string, unknown>} */ (v)[k];
      out.add(`${p}: ${typeOf(child)}`);
      collectShapes(child, p, out);
    }
  }
}

/**
 * @param {string} root capture directory (raw/)
 * @param {{ shapes?: boolean }} [opts] shapes: also list nested key paths with types
 * @returns {{ text: string, total: number }}
 */
export function buildInventory(root, opts = {}) {
  const lines = [];
  let total = 0;
  for (const event of listEvents(root)) {
    const { items, bad } = readEvent(root, event);
    total += items.length;
    const sets = new Map();
    for (const it of items) {
      const key = keysOf(it.payload).join(",");
      sets.set(key, (sets.get(key) ?? 0) + 1);
    }
    lines.push(`${event}\t${items.length}${bad > 0 ? `\t(${bad} unreadable)` : ""}`);
    const ordered = [...sets.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [key, n] of ordered) lines.push(`  ${n}\t[${key}]`);
    if (opts.shapes) {
      const shapes = new Set();
      for (const it of items) collectShapes(it.payload, "", shapes);
      for (const s of [...shapes].sort()) lines.push(`    ~ ${s}`);
    }
  }
  const captured = new Set(listEvents(root));
  for (const event of HOOK_EVENTS) {
    if (captured.has(event)) continue;
    const hint = Object.hasOwn(TRIGGER_HINTS, event)
      ? TRIGGER_HINTS[/** @type {keyof typeof TRIGGER_HINTS} */ (event)]
      : "no hint";
    lines.push(`NO CAPTURES\t${event}\ttrigger: ${hint}`);
  }
  lines.push(`TOTAL\t${total}`);
  return { text: `${lines.join("\n")}\n`, total };
}
