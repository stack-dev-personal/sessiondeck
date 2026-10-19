import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StateFileError } from "./state-file-error.ts";
import { scrubSecrets } from "./state-file-secrets.ts";
import { sweepStaleTemps, type SweepOptions } from "./state-file-sweep.ts";

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
    // The id is caller text that may have been a credential pasted in the wrong place.
    throw new StateFileError(
      "invalid-id",
      `invalid ${label} ${scrubSecrets(JSON.stringify(id))}: use letters, digits, "_" and "-" only (max 64)`,
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

function sessionScopedPath(subdir: string, stateDir: string, sessionId: string): string {
  return join(stateDir, subdir, assertValidId("session id", sessionId) + MARKDOWN_EXT);
}

/** The orchestrator uses the id "sprint" for its own question file. */
export function questionFilePath(stateDir: string, sessionId: string): string {
  return sessionScopedPath(STATE_SUBDIRS.questions, stateDir, sessionId);
}

export function answerFilePath(stateDir: string, sessionId: string): string {
  return sessionScopedPath(STATE_SUBDIRS.answers, stateDir, sessionId);
}

export function reportFilePath(stateDir: string, sessionId: string): string {
  return sessionScopedPath(STATE_SUBDIRS.reports, stateDir, sessionId);
}

/**
 * Creates the state directory and every subdirectory; safe to call repeatedly. Also removes
 * temp files of writers that were killed before their rename (status.json and sessions/ only,
 * the two places the helper writes).
 */
export async function ensureStateLayout(
  stateDir: string,
  sweep: SweepOptions = {},
): Promise<StateLayout> {
  const dirs = Object.fromEntries(
    Object.entries(STATE_SUBDIRS).map(([key, name]) => [key, join(stateDir, name)]),
  ) as Record<keyof typeof STATE_SUBDIRS, string>;
  await mkdir(stateDir, { recursive: true });
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  await Promise.all([stateDir, dirs.sessions].map((dir) => sweepStaleTemps(dir, sweep)));
  return { stateDir, ...dirs };
}
