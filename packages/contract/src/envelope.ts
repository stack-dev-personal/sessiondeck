import { z } from "zod";

/** Event kinds a probe can emit (architecture 3.1). */
export const EVENT_KINDS = [
  "hook",
  "statusline",
  "subagents",
  "transcript",
  "liveness",
  "probe",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ENVELOPE_VERSION = 1;
export const HOST_OS_VALUES = ["win32", "linux", "darwin"] as const;
export type HostOs = (typeof HOST_OS_VALUES)[number];

/** Kind that is allowed to carry a null session_id. */
const SESSIONLESS_KIND: EventKind = "probe";

/**
 * ULID format only: 26 Crockford base32 characters (no I, L, O, U), upper case.
 * The first character is 0-7 because the 48-bit timestamp must not overflow.
 * Generation is the probe's job.
 */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface Envelope<K extends EventKind = EventKind> {
  v: 1;
  id: string;
  kind: K;
  host: string;
  os: HostOs;
  session_id: string | null;
  agent_id?: string;
  hook_event_name?: string;
  ts: number;
  seq: number;
  /** The raw stdin JSON, untouched. The key must be present (it may be null). */
  payload: unknown;
}

/** An envelope of kind hook; hook_event_name is guaranteed present. */
export type HookEnvelope = Envelope<"hook"> & { hook_event_name: string };

const NonNegativeInt = z.number().int().nonnegative();

const EnvelopeObjectSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  id: z.string().regex(ULID_PATTERN, "id must be a ULID"),
  kind: z.enum(EVENT_KINDS),
  host: z.string().min(1),
  os: z.enum(HOST_OS_VALUES),
  session_id: z.string().nullable(),
  agent_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  ts: NonNegativeInt,
  seq: NonNegativeInt,
  // z.unknown() alone would also accept a missing key; presence is checked below.
  payload: z.unknown(),
});

export const EnvelopeSchema = EnvelopeObjectSchema.superRefine((env, ctx) => {
  if (!("payload" in env)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: "payload key is required",
    });
  }
  if (env.session_id === null && env.kind !== SESSIONLESS_KIND) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["session_id"],
      message: `session_id may be null only for kind '${SESSIONLESS_KIND}'`,
    });
  }
  // Orchestrator decision: tightened from the architecture doc's optional marker.
  // A hook envelope without hook_event_name cannot be reduced, so reject it at the edge.
  if (env.kind === "hook" && (env.hook_event_name === undefined || env.hook_event_name === "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hook_event_name"],
      message: "hook_event_name is required when kind is 'hook'",
    });
  }
}).transform((env): Envelope => ({ ...env, payload: env.payload }));

export function parseEnvelope(input: unknown): Envelope {
  return EnvelopeSchema.parse(input);
}

export function safeParseEnvelope(input: unknown): z.SafeParseReturnType<unknown, Envelope> {
  return EnvelopeSchema.safeParse(input);
}

export function isHookEnvelope(env: Envelope): env is HookEnvelope {
  return (
    env.kind === "hook" && typeof env.hook_event_name === "string" && env.hook_event_name !== ""
  );
}
