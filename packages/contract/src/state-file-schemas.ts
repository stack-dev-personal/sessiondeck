import { z } from "zod";

// Shapes of the two status files in PROMPT-BOOK.md section 6. Unknown keys are preserved
// (passthrough) because other tools already add their own, for example worktree or heartbeat.

// "green" is not in the PROMPT-BOOK section 6 list: it is the terminal state of the smoke package
// (R0.8, infra/sprint/README.md "Smoke test"), whose status.json the helper must be able to write.
export const SPRINT_STATES = [
  "running",
  "blocked",
  "merging",
  "gate",
  "awaiting-merge-approval",
  "merged",
  "failed",
  "green",
] as const;

// "not-started" is not in the PROMPT-BOOK list but the conductor writes it for sessions that
// have not been launched yet, so the reader has to accept it.
export const SPRINT_SESSION_STATES = [
  "not-started",
  "running",
  "blocked",
  "green",
  "failed",
] as const;

export const GATE_STATES = ["pending", "pass", "fail"] as const;

const Timestamp = z.string().min(1);
const OptionalText = z.string().nullable().optional();

const SessionEntryShape = {
  state: z.enum(SPRINT_SESSION_STATES),
  branch: z.string().optional(),
  pr: z.number().int().nullable().optional(),
  verify: OptionalText,
  units_done: z.number().int().nonnegative().optional(),
  units_total: z.number().int().nonnegative().optional(),
  question_file: OptionalText,
};

/** One entry of status.json `sessions`. */
export const SprintSessionEntrySchema = z
  .object({ ...SessionEntryShape, updated_at: Timestamp.optional() })
  .passthrough();

/** sessions/<id>.json: one entry plus the fields only the session itself knows. */
export const SessionStatusSchema = z
  .object({
    ...SessionEntryShape,
    updated_at: Timestamp,
    current_unit: OptionalText,
    last_report: OptionalText,
    pid: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

export const SprintGateSchema = z
  .object({ state: z.enum(GATE_STATES), report: OptionalText })
  .passthrough();

/** status.json of one sprint. */
export const SprintStatusSchema = z
  .object({
    // The CLI parses sprint=0 as the number 0; the file always holds the string, as in PROMPT-BOOK.
    sprint: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
    name: z.string().min(1),
    branch: z.string().min(1),
    state: z.enum(SPRINT_STATES),
    started_at: Timestamp.optional(),
    updated_at: Timestamp,
    sessions: z.record(SprintSessionEntrySchema).optional(),
    questions: z.array(z.string()).optional(),
    pr: z.union([z.number().int(), z.string()]).nullable().optional(),
    gate: SprintGateSchema.optional(),
    needs_laptop_confirmation: z.array(z.string()).optional(),
  })
  .passthrough();

export type SprintState = (typeof SPRINT_STATES)[number];
export type SprintSessionState = (typeof SPRINT_SESSION_STATES)[number];
export type SprintSessionEntry = z.infer<typeof SprintSessionEntrySchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SprintStatus = z.infer<typeof SprintStatusSchema>;
