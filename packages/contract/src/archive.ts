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
export const ARCHIVE_MAX_LIST_ENTRIES = 50;
export const ARCHIVE_MAX_LIST_ITEM = 200;
export const ARCHIVE_MAX_OUTCOME = 16384;

const NonNegativeInt = z.number().int().nonnegative();
const SafeNonNegativeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Longest accepted duration: 30 days in seconds. */
export const ARCHIVE_MAX_DURATION_S = 30 * 86400;
export const ARCHIVE_MAX_TOOL_COUNT = 1_000_000;

/**
 * Size budget: the hub ingest body limit is 1 MiB (INGEST_BODY_LIMIT in packages/hub/src/ingest/route.ts,
 * mirrored here because contract must not import hub). A max-size payload with worst-case characters
 * (6 bytes each as a JSON \uXXXX escape) has to stay well under it; test/archive.test.ts asserts this.
 */
export const ARCHIVE_INGEST_BODY_LIMIT = 1024 * 1024;

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const REL_PATH_SHAPE = /^(?:projects|harness)\/[^/]+\/sessions\/[^/]+\.md$/;

/**
 * True for a vault-relative path: forward slashes, no leading slash, no `.`/`..`/empty segments, no
 * control characters or `:`, no segment ending in `.` or space, no Windows device names, and the
 * shape `(projects|harness)/<x>/sessions/<file>.md`.
 */
export function isSafeRelPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f:]/.test(p)) return false;
  const ok = p.split("/").every((seg) => {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.endsWith(".") || seg.endsWith(" ")) return false;
    return !WINDOWS_RESERVED.test(seg.split(".")[0] ?? "");
  });
  return ok && REL_PATH_SHAPE.test(p);
}

const RelPath = z
  .string()
  .max(ARCHIVE_MAX_REL_PATH)
  .refine(
    isSafeRelPath,
    "rel_path must be (projects|harness)/<x>/sessions/<file>.md, vault-relative",
  );

// C0 controls other than \n and \t (and \r too where allowed).
// eslint-disable-next-line no-control-regex
const C0_NO_CR = /[\x00-\x08\x0b-\x1f]/;
// eslint-disable-next-line no-control-regex
const C0_WITH_CR = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const noCtl = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !C0_NO_CR.test(v), "control characters are not allowed");

/** ISO 8601 date (YYYY-MM-DD) or datetime with optional fraction and zone. */
const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/;

/** True when the ISO shape also has in-range components (month 1-12, real day, 00-23:00-59:00-59). */
export function isValidIsoString(v: string): boolean {
  const m = ISO_DATE_PATTERN.exec(v);
  if (!m) return false;
  const [y, mo, d, hh, mi, ss, zh, zm] = m
    .slice(1)
    .map((x) => (x === undefined ? 0 : Number(x))) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1) return false;
  if (d! > new Date(Date.UTC(y!, mo!, 0)).getUTCDate()) return false;
  return hh! <= 23 && mi! <= 59 && ss! <= 59 && zh! <= 23 && zm! <= 59;
}
const IsoString = z
  .string()
  .max(ARCHIVE_MAX_TIMESTAMP)
  .regex(ISO_DATE_PATTERN, "ISO 8601 expected")
  .refine(isValidIsoString, "ISO 8601 components out of range");

const ListItems = z.array(noCtl(ARCHIVE_MAX_LIST_ITEM)).max(ARCHIVE_MAX_LIST_ENTRIES);

export const ArchiveSourceSchema = z
  .object({
    root_label: z
      .string()
      .max(ARCHIVE_MAX_ROOT_LABEL)
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "root_label must be a plain label"),
    rel_path: RelPath,
    mtime_ms: SafeNonNegativeInt,
    size: SafeNonNegativeInt,
  })
  .strict();

export const ArchiveToolSchema = z
  .object({
    name: noCtl(ARCHIVE_MAX_TOOL_NAME).refine((v) => v.length >= 1, "name required"),
    count: NonNegativeInt.max(ARCHIVE_MAX_TOOL_COUNT).nullable(),
  })
  .strict();

export const ArchivePayloadSchema = z
  .object({
    source: ArchiveSourceSchema,
    schema_version: NonNegativeInt.nullable(),
    session_id: z
      .string()
      .max(ARCHIVE_MAX_SESSION_ID)
      .regex(/^[A-Za-z0-9-]{1,128}$/, "session_id must be letters, digits and '-'"),
    collection: z.string().max(ARCHIVE_MAX_COLLECTION).nullable(),
    title: noCtl(ARCHIVE_MAX_TITLE).nullable(),
    date: IsoString.nullable(),
    started_at: IsoString.nullable(),
    ended_at: IsoString.nullable(),
    duration_s: z.number().nonnegative().finite().max(ARCHIVE_MAX_DURATION_S).nullable(),
    project_dir: noCtl(ARCHIVE_MAX_PROJECT_DIR).nullable(),
    branch: noCtl(ARCHIVE_MAX_BRANCH).nullable(),
    tools_used: z.array(ArchiveToolSchema).max(ARCHIVE_MAX_TOOLS),
    commits: ListItems,
    prs: ListItems,
    outcome: z
      .string()
      .max(ARCHIVE_MAX_OUTCOME)
      .refine((v) => !C0_WITH_CR.test(v), "control characters are not allowed"),
    outcome_truncated: z.boolean(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.collection === null) return;
    const first2 = p.source.rel_path.split("/").slice(0, 2).join("/");
    if (p.collection !== first2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collection"],
        message: "collection must equal the first two segments of source.rel_path",
      });
    }
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

/**
 * EnvelopeSchema plus the archive rules: valid payload, payload.session_id equals the envelope's.
 * The output carries the parsed payload (unknown keys are rejected, not passed through).
 */
export const ArchiveEnvelopeSchema = EnvelopeSchema.transform((env, ctx) => {
  if (env.kind !== "archive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: "kind must be 'archive'",
    });
    return z.NEVER;
  }
  const parsed = ArchivePayloadSchema.safeParse(env.payload);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: "invalid archive payload",
    });
    return z.NEVER;
  }
  if (parsed.data.session_id !== env.session_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "session_id"],
      message: "payload.session_id must equal the envelope session_id",
    });
    return z.NEVER;
  }
  return { ...env, payload: parsed.data };
});
