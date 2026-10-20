// Adapted from simple10/agents-observe, path app/server/src/utils/event-signature.ts
// Repo: https://github.com/simple10/agents-observe
// Upstream commit: b3a7238b3913976c10da052f75c73e29ad084c61
// License: MIT, Copyright (c) 2025 Joe Johnston
// Changes: material is built from the sessiondeck envelope (kind, host, session_id, agent_id,
//   hook_event_name, payload) instead of agents-observe's envelope; canonicalJson is written here
//   (sorted keys, recursive). The fixed 5 s time bucket is REMOVED from the hash: two events are
//   duplicates when the signatures match and their ts differ by less than SIGNATURE_WINDOW_MS, a
//   literal sliding window checked against the events_signature index. A fixed bucket would
//   treat a pair 1 s apart that straddles a bucket boundary as distinct.
import { createHash } from "node:crypto";
import type { Envelope } from "@sessiondeck/contract";

export const SIGNATURE_WINDOW_MS = 5000;

/**
 * JSON with object keys sorted at every depth; undefined values are dropped as JSON.stringify does.
 * Recursive: callers must have bounded the nesting first (route: MAX_PAYLOAD_DEPTH = 64).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(rec).sort()) {
      if (rec[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function computeEventSignature(env: Envelope): string {
  const material = {
    kind: env.kind,
    host: env.host,
    session_id: env.session_id,
    agent_id: env.agent_id ?? null,
    hook_name: env.hook_event_name ?? null,
    payload: env.payload,
  };
  return createHash("sha256").update(canonicalJson(material)).digest("hex");
}
