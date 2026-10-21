import type { ZodError, ZodIssue } from "zod";

/** "envelopes[3].kind" style path; "body" for the root. */
export function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "body";
  let out = "";
  for (const seg of path) {
    out += typeof seg === "number" ? `[${seg}]` : out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** Messages are rebuilt from the issue code so a rejected value is never echoed back. */
function safeMessage(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? "Required"
        : `Expected ${issue.expected}, received ${issue.received}`;
    case "invalid_enum_value":
      return "Invalid enum value";
    case "invalid_literal":
      return "Invalid literal value";
    case "custom":
    case "invalid_string":
    case "too_small":
    case "too_big":
      return issue.message; // schema-authored text (e.g. "id must be a ULID"), never contains input
    default:
      return issue.code;
  }
}

/** First issue only: "<path>: <message>". */
export function reasonFromZod(err: ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return "invalid";
  return `${formatPath(issue.path)}: ${safeMessage(issue)}`;
}

// ---- Hub-side bounds, stricter than the contract schema (D-S3-8). ----

/** Envelopes per batch (400 too_many_envelopes). */
export const MAX_ENVELOPES = 5000;
/** Nesting depth of an envelope payload; the top-level object is depth 1. */
export const MAX_PAYLOAD_DEPTH = 64;
export const MAX_HOST_LEN = 128;
export const MAX_SESSION_ID_LEN = 128;
export const MAX_AGENT_ID_LEN = 128;
export const MAX_HOOK_EVENT_NAME_LEN = 64;
/**
 * project_dir and cwd are truncated, not rejected: a long path is real data, not an attack worth
 * poisoning a batch over (the probe would retry it forever).
 */
export const MAX_PATH_LEN = 1024;

/**
 * True when value nests deeper than max. Iterative on purpose: JSON.parse accepts nesting far
 * deeper than the call stack allows for recursion (canonicalJson, JSON.stringify), so this must
 * run before either.
 */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number];
    if (typeof v !== "object" || v === null) continue;
    if (d > max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

interface BoundedEnvelope {
  host: string;
  session_id: string | null;
  agent_id?: string | undefined;
  hook_event_name?: string | undefined;
  payload: unknown;
}

/** First bound violation as "envelopes[i].field: reason", or null. Values are never echoed. */
export function checkBounds(host: string, envelopes: readonly BoundedEnvelope[]): string | null {
  if (host.length > MAX_HOST_LEN) return "host: too_long";
  for (const [i, e] of envelopes.entries()) {
    if (e.host.length > MAX_HOST_LEN) return `envelopes[${i}].host: too_long`;
    if (e.session_id !== null && e.session_id.length > MAX_SESSION_ID_LEN)
      return `envelopes[${i}].session_id: too_long`;
    if (e.agent_id !== undefined && e.agent_id.length > MAX_AGENT_ID_LEN)
      return `envelopes[${i}].agent_id: too_long`;
    if (e.hook_event_name !== undefined && e.hook_event_name.length > MAX_HOOK_EVENT_NAME_LEN)
      return `envelopes[${i}].hook_event_name: too_long`;
    if (exceedsDepth(e.payload, MAX_PAYLOAD_DEPTH)) return `envelopes[${i}].payload: too_deep`;
  }
  return null;
}
