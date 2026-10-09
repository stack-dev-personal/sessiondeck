// Sprint state files: the .sprint/<id>/ layout of PROMPT-BOOK.md section 6 plus an atomic,
// schema-checked, secret-free way to write and read the two status files. This module touches
// node:fs, so it is a subpath export (@sessiondeck/contract/state-file) and is deliberately NOT
// re-exported from index.ts, which the web bundle imports.
import { mkdir, readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
import { writeStateFileAtomic, type AtomicWriteOptions } from "./state-file-atomic.ts";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
import { errorCode, StateFileError } from "./state-file-error.ts";
import {
  SessionStatusSchema,
  SprintStatusSchema,
  type SessionStatus,
  type SprintStatus,
  // @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
} from "./state-file-schemas.ts";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
import { assertNoSecrets } from "./state-file-secrets.ts";

// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
export * from "./state-file-atomic.ts";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
export * from "./state-file-error.ts";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
export * from "./state-file-schemas.ts";
// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
export * from "./state-file-secrets.ts";

export const STATE_SUBDIRS = {
  sessions: "sessions",
  prompts: "prompts",
  questions: "questions",
  answers: "answers",
  logs: "logs",
  reports: "reports",
  screens: "screens",
  gate: "gate",
} as const;

export const SPRINT_STATUS_FILE = "status.json";
const SESSION_STATUS_EXT = ".json";
const MARKDOWN_EXT = ".md";
const ISSUE_LIMIT = 5;

/**
 * Ids become file names, so only letters, digits, "_" and "-" are allowed, starting with an
 * alphanumeric. No dots, separators, colons or NUL: "../x" cannot leave the state directory.
 */
export const STATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type StateLayout = { readonly stateDir: string } & {
  readonly [K in keyof typeof STATE_SUBDIRS]: string;
};

export function assertValidId(label: string, id: string): string {
  if (!STATE_ID_PATTERN.test(id)) {
    throw new StateFileError(
      "invalid-id",
      `invalid ${label} ${JSON.stringify(id)}: use letters, digits, "_" and "-" only (max 64)`,
    );
  }
  return id;
}

/** State directory of one sprint under a root such as .sprint. */
export function sprintStateDir(root: string, sprintId: string): string {
  return join(root, assertValidId("sprint id", sprintId));
}

export function sprintStatusPath(stateDir: string): string {
  return join(stateDir, SPRINT_STATUS_FILE);
}

export function sessionStatusPath(stateDir: string, sessionId: string): string {
  const name = assertValidId("session id", sessionId) + SESSION_STATUS_EXT;
  return join(stateDir, STATE_SUBDIRS.sessions, name);
}

/** The orchestrator uses the id "sprint" for its own question file. */
export function questionFilePath(stateDir: string, sessionId: string): string {
  return join(
    stateDir,
    STATE_SUBDIRS.questions,
    assertValidId("session id", sessionId) + MARKDOWN_EXT,
  );
}

export function answerFilePath(stateDir: string, sessionId: string): string {
  return join(
    stateDir,
    STATE_SUBDIRS.answers,
    assertValidId("session id", sessionId) + MARKDOWN_EXT,
  );
}

export function reportFilePath(stateDir: string, sessionId: string): string {
  return join(
    stateDir,
    STATE_SUBDIRS.reports,
    assertValidId("session id", sessionId) + MARKDOWN_EXT,
  );
}

/** Creates the state directory and every subdirectory; safe to call repeatedly. */
export async function ensureStateLayout(stateDir: string): Promise<StateLayout> {
  const dirs = Object.fromEntries(
    Object.entries(STATE_SUBDIRS).map(([key, name]) => [key, join(stateDir, name)]),
  ) as Record<keyof typeof STATE_SUBDIRS, string>;
  await mkdir(stateDir, { recursive: true });
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  return { stateDir, ...dirs };
}

export interface StatusWriteOptions extends AtomicWriteOptions {
  /** Clock for updated_at; injectable so tests are deterministic. */
  now?: () => Date;
}

/** ISO 8601 UTC with seconds precision, e.g. 2026-10-12T01:00:00Z. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, ISSUE_LIMIT)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new StateFileError("schema", `${where} does not match its schema: ${issues.join("; ")}`);
}

async function writeChecked<T extends { updated_at: string }>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  filePath: string,
  status: unknown,
  options: StatusWriteOptions,
): Promise<T> {
  const stamp = formatTimestamp((options.now ?? (() => new Date()))());
  const candidate = { ...(status as Record<string, unknown>), updated_at: stamp };
  assertNoSecrets(candidate);
  const parsed = parseWith(schema, candidate, filePath);
  await writeStateFileAtomic(filePath, parsed, options);
  return parsed;
}

/** Validates, stamps updated_at, and atomically writes status.json. Returns what was written. */
export async function writeSprintStatus(
  stateDir: string,
  status: unknown,
  options: StatusWriteOptions = {},
): Promise<SprintStatus> {
  return writeChecked(SprintStatusSchema, sprintStatusPath(stateDir), status, options);
}

/** Validates, stamps updated_at, and atomically writes sessions/<id>.json. */
export async function writeSessionStatus(
  stateDir: string,
  sessionId: string,
  status: unknown,
  options: StatusWriteOptions = {},
): Promise<SessionStatus> {
  return writeChecked(SessionStatusSchema, sessionStatusPath(stateDir, sessionId), status, options);
}

/** Missing file, invalid JSON and schema failure are three different StateFileError kinds. */
async function readChecked<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  filePath: string,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    const code = errorCode(error);
    const kind = code === "ENOENT" ? "not-found" : "read-failed";
    throw new StateFileError(kind, `cannot read ${filePath}: ${code ?? "UNKNOWN"}`, {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error: unknown) {
    throw new StateFileError("invalid-json", `${filePath} is not valid JSON`, { cause: error });
  }
  return parseWith(schema, json, filePath);
}

export function readSprintStatus(stateDir: string): Promise<SprintStatus> {
  return readChecked(SprintStatusSchema, sprintStatusPath(stateDir));
}

export function readSessionStatus(stateDir: string, sessionId: string): Promise<SessionStatus> {
  return readChecked(SessionStatusSchema, sessionStatusPath(stateDir, sessionId));
}

/** Reads any status file, picking the schema from the file name (status.json is the sprint file). */
export function readStatusFile(filePath: string): Promise<SprintStatus | SessionStatus> {
  // win32.basename accepts both separators, so Windows-style paths work on any host.
  const isSprint = win32.basename(filePath) === SPRINT_STATUS_FILE;
  return isSprint
    ? readChecked(SprintStatusSchema, filePath)
    : readChecked(SessionStatusSchema, filePath);
}
