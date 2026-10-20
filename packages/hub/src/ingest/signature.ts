// Adapted from simple10/agents-observe, path app/server/src/utils/event-signature.ts
// Repo: https://github.com/simple10/agents-observe
// Upstream commit: b3a7238b3913976c10da052f75c73e29ad084c61
// License: MIT, Copyright (c) 2025 Joe Johnston
// Changes: material is built from the sessiondeck envelope (kind, host, session_id, agent_id,
//   hook_event_name, payload) instead of agents-observe's envelope; canonicalJson is written here
//   (sorted keys, recursive). The fixed 5 s time bucket is REMOVED from the hash: two events are
//   duplicates when the signatures match and their ts differ by less than SIGNATURE_WINDOW_MS, a
//   literal sliding window checked against the events_session_ts_sig index (migration 5). A fixed bucket would
//   treat a pair 1 s apart that straddles a bucket boundary as distinct.
import { hash } from "node:crypto";
import type { Envelope } from "@sessiondeck/contract";

export const SIGNATURE_WINDOW_MS = 5000;

/**
 * JSON with object keys sorted at every depth; undefined values are dropped as JSON.stringify does.
 * Recursive: callers must have bounded the nesting first (route: MAX_PAYLOAD_DEPTH = 64).
 * Written with string concatenation and a cache of quoted keys because it runs once per envelope
 * on the ingest hot path (R2.4); the output is byte-identical to the array/join form it replaced.
 */
const quoted = new Map<string, string>();
function quoteKey(k: string): string {
  let q = quoted.get(k);
  if (q === undefined) {
    q = JSON.stringify(k);
    // Bounded: payload keys come from the wire, so the cache must not grow without limit.
    if (quoted.size < 4096) quoted.set(k, q);
  }
  return q;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += canonicalJson(value[i] ?? null);
    }
    return `${out}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  let out = "{";
  let first = true;
  for (const k of keys) {
    const v = rec[k];
    if (v === undefined) continue;
    if (!first) out += ",";
    first = false;
    out += `${quoteKey(k)}:${canonicalJson(v)}`;
  }
  return `${out}}`;
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
  return hash("sha256", canonicalJson(material), "hex");
}
