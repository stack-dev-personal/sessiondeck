import type { Envelope } from "./envelope";

/** Raw hook payloads are untrusted: every read goes through these helpers and never throws. */
export type PayloadRecord = Readonly<Record<string, unknown>>;

const EMPTY_PAYLOAD: PayloadRecord = Object.freeze({});

/** The payload as a record, or an empty record when it is null, a primitive, or an array. */
export function asRecord(value: unknown): PayloadRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as PayloadRecord;
  }
  return EMPTY_PAYLOAD;
}

/** A non-empty string field, or null when missing or of another type. */
export function readString(record: PayloadRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The envelope's agent_id (the probe copies it from the hook), or null for the main thread. */
export function agentIdOf(e: Envelope): string | null {
  return typeof e.agent_id === "string" && e.agent_id !== "" ? e.agent_id : null;
}

/** True when the hook ran inside a subagent. */
export function isSubagentEnvelope(e: Envelope): boolean {
  return agentIdOf(e) !== null;
}
