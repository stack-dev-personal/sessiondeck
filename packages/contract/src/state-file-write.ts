import type { ZodType, ZodTypeDef } from "zod";
import { writeStateFileAtomic, type AtomicWriteOptions } from "./state-file-atomic.ts";
import { sessionStatusPath, sprintStatusPath } from "./state-file-paths.ts";
import { parseWith } from "./state-file-read.ts";
import {
  SessionStatusSchema,
  SprintStatusSchema,
  type SessionStatus,
  type SprintStatus,
} from "./state-file-schemas.ts";
import { assertNoSecrets } from "./state-file-secrets.ts";

export interface StatusWriteOptions extends AtomicWriteOptions {
  /** Clock for updated_at; injectable so tests are deterministic. */
  now?: () => Date;
}

/** ISO 8601 UTC with seconds precision, e.g. 2026-10-12T01:00:00Z. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
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
