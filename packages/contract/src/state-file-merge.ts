import { withFileLock, type LockOptions } from "./state-file-lock.ts";
import { sessionStatusPath, sprintStatusPath } from "./state-file-paths.ts";
import { readRawObject } from "./state-file-read.ts";
import type { SessionStatus, SprintStatus } from "./state-file-schemas.ts";
import {
  writeSessionStatus,
  writeSprintStatus,
  type StatusWriteOptions,
} from "./state-file-write.ts";

type PlainObject = Record<string, unknown>;

export interface MergeOptions extends StatusWriteOptions {
  lock?: LockOptions;
}

export interface SessionMergeOptions extends MergeOptions {
  /** Discard whatever the file holds, including content that is not JSON, and write only the overrides. */
  replace?: boolean;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Top-level override, except `sessions`: each id is merged into the existing entry, so a write
 * about one session cannot drop the others (a resume would relaunch a session that was done).
 */
export function mergeSprintFields(current: PlainObject, overrides: PlainObject): PlainObject {
  const merged = { ...current, ...overrides };
  if (!isPlainObject(current.sessions) || !isPlainObject(overrides.sessions)) return merged;
  const sessions: PlainObject = { ...current.sessions };
  for (const [id, entry] of Object.entries(overrides.sessions)) {
    const before = sessions[id];
    sessions[id] = isPlainObject(before) && isPlainObject(entry) ? { ...before, ...entry } : entry;
  }
  return { ...merged, sessions };
}

/**
 * Merges overrides over the file as it is on disk and validates only the result, so an old file
 * that is missing a field (or holds a value the overrides now fix) does not block the update.
 * The read and the write happen under one lock, so concurrent merges do not lose updates.
 */
export function mergeSessionStatus(
  stateDir: string,
  sessionId: string,
  overrides: PlainObject,
  options: SessionMergeOptions = {},
): Promise<SessionStatus> {
  const path = sessionStatusPath(stateDir, sessionId);
  return withFileLock(
    path,
    async () => {
      const current = options.replace ? undefined : await readRawObject(path);
      return writeSessionStatus(stateDir, sessionId, { ...current, ...overrides }, options);
    },
    options.lock,
  );
}

/** Same as mergeSessionStatus for status.json, with the per-id merge of `sessions`. */
export function mergeSprintStatus(
  stateDir: string,
  overrides: PlainObject,
  options: MergeOptions = {},
): Promise<SprintStatus> {
  const path = sprintStatusPath(stateDir);
  return withFileLock(
    path,
    async () => {
      const current = (await readRawObject(path)) ?? {};
      return writeSprintStatus(stateDir, mergeSprintFields(current, overrides), options);
    },
    options.lock,
  );
}
