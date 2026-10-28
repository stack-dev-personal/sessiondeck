import { z } from "zod";
import { EnvelopeSchema, type Envelope } from "./envelope";

/**
 * Payload of an envelope of kind `archive` (Phase 5, R5.2). The probe parses one vault capture
 * file (`projects/<x>/sessions/*.md` or `harness/<x>/sessions/*.md`) and ships one envelope per
 * file. The caps below are shared: the probe truncates to the same numbers the schema enforces.
 */
export const ARCHIVE_MAX_ROOT_LABEL = 64;
export const ARCHIVE_MAX_REL_PATH = 512;
export const ARCHIVE_MAX_SESSION_ID = 128;
export const ARCHIVE_MAX_COLLECTION = 512;
export const ARCHIVE_MAX_TITLE = 300;
export const ARCHIVE_MAX_TIMESTAMP = 40;
export const ARCHIVE_MAX_PROJECT_DIR = 1024;
export const ARCHIVE_MAX_BRANCH = 255;
export const ARCHIVE_MAX_TOOL_NAME = 100;
export const ARCHIVE_MAX_TOOLS = 100;
export const ARCHIVE_MAX_LIST_ENTRIES = 200;
export const ARCHIVE_MAX_LIST_ITEM = 500;
export const ARCHIVE_MAX_OUTCOME = 16384;

const NonNegativeInt = z.number().int().nonnegative();

/** True for a vault-relative path: forward slashes, no leading slash, no `.`/`..`/empty segments. */
export function isSafeRelPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const RelPath = z
  .string()
  .max(ARCHIVE_MAX_REL_PATH)
  .refine(isSafeRelPath, "rel_path must be vault-relative with forward slashes and no '..'");

/** ISO 8601 date (YYYY-MM-DD) or datetime with optional fraction and zone. */
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const IsoString = z
  .string()
  .max(ARCHIVE_MAX_TIMESTAMP)
  .regex(ISO_DATE_PATTERN, "ISO 8601 expected");

const ListItems = z.array(z.string().max(ARCHIVE_MAX_LIST_ITEM)).max(ARCHIVE_MAX_LIST_ENTRIES);

export const ArchiveSourceSchema = z.object({
  root_label: z.string().min(1).max(ARCHIVE_MAX_ROOT_LABEL),
  rel_path: RelPath,
  mtime_ms: NonNegativeInt,
  size: NonNegativeInt,
});

export const ArchiveToolSchema = z.object({
  name: z.string().min(1).max(ARCHIVE_MAX_TOOL_NAME),
  count: NonNegativeInt.nullable(),
});

export const ArchivePayloadSchema = z.object({
  source: ArchiveSourceSchema,
  schema_version: NonNegativeInt.nullable(),
  session_id: z.string().min(1).max(ARCHIVE_MAX_SESSION_ID),
  collection: z.string().max(ARCHIVE_MAX_COLLECTION).nullable(),
  title: z.string().max(ARCHIVE_MAX_TITLE).nullable(),
  date: IsoString.nullable(),
  started_at: IsoString.nullable(),
  ended_at: IsoString.nullable(),
  duration_s: z.number().nonnegative().finite().nullable(),
  project_dir: z.string().max(ARCHIVE_MAX_PROJECT_DIR).nullable(),
  branch: z.string().max(ARCHIVE_MAX_BRANCH).nullable(),
  tools_used: z.array(ArchiveToolSchema).max(ARCHIVE_MAX_TOOLS),
  commits: ListItems,
  prs: ListItems,
  outcome: z.string().max(ARCHIVE_MAX_OUTCOME),
  outcome_truncated: z.boolean(),
});
export type ArchivePayload = z.infer<typeof ArchivePayloadSchema>;
export type ArchiveSource = z.infer<typeof ArchiveSourceSchema>;
export type ArchiveTool = z.infer<typeof ArchiveToolSchema>;

/** An envelope of kind archive whose payload has been validated. */
export type ArchiveEnvelope = Envelope<"archive"> & {
  session_id: string;
  payload: ArchivePayload;
};

/**
 * True when env is kind archive, its payload is a valid ArchivePayload and
 * payload.session_id equals the envelope session_id.
 */
export function isArchiveEnvelopeConsistent(env: Envelope): env is ArchiveEnvelope {
  if (env.kind !== "archive" || env.session_id === null) return false;
  const parsed = ArchivePayloadSchema.safeParse(env.payload);
  return parsed.success && parsed.data.session_id === env.session_id;
}

/** EnvelopeSchema plus the archive rules: valid payload, payload.session_id equals the envelope's. */
export const ArchiveEnvelopeSchema = EnvelopeSchema.superRefine((env, ctx) => {
  if (env.kind !== "archive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: "kind must be 'archive'",
    });
    return;
  }
  const parsed = ArchivePayloadSchema.safeParse(env.payload);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: "invalid archive payload",
    });
  } else if (parsed.data.session_id !== env.session_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "session_id"],
      message: "payload.session_id must equal the envelope session_id",
    });
  }
});
