import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import type { ZodIssue, ZodType, ZodTypeDef } from "zod";
import { errorCode, StateFileError } from "./state-file-error.ts";
import { sessionStatusPath, SPRINT_STATUS_FILE, sprintStatusPath } from "./state-file-paths.ts";
import {
  SessionStatusSchema,
  SprintStatusSchema,
  type SessionStatus,
  type SprintStatus,
} from "./state-file-schemas.ts";
import { scrubSecrets } from "./state-file-secrets.ts";

const ISSUE_LIMIT = 5;
/** Windows PowerShell 5.1 `Set-Content -Encoding UTF8` writes this mark; JSON.parse rejects it. */
const BYTE_ORDER_MARK = "﻿";

/** zod echoes the offending value ("received 'x'"), which could be a credential: say what is allowed. */
function describeIssue(issue: ZodIssue): string {
  const where = issue.path.join(".") || "(root)";
  if (issue.code === "invalid_enum_value") {
    return `${where}: expected one of ${issue.options.join(", ")}`;
  }
  return `${where}: ${scrubSecrets(issue.message)}`;
}

export function parseWith<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: unknown,
  where: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, ISSUE_LIMIT).map(describeIssue);
  throw new StateFileError("schema", `${where} does not match its schema: ${issues.join("; ")}`);
}

/** Missing file, invalid JSON and schema failure are different StateFileError kinds. */
export async function readJsonFile(filePath: string): Promise<unknown> {
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
  try {
    return JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
  } catch (error: unknown) {
    throw new StateFileError("invalid-json", `${filePath} is not valid JSON`, { cause: error });
  }
}

/**
 * The file as a plain object without schema checks, for merging; undefined when it does not
 * exist. Content that is not a JSON object (empty, truncated, an array) is "invalid-json".
 */
export async function readRawObject(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  let json: unknown;
  try {
    json = await readJsonFile(filePath);
  } catch (error: unknown) {
    if (error instanceof StateFileError && error.kind === "not-found") return undefined;
    throw error;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new StateFileError("invalid-json", `${filePath} is not a JSON object`);
  }
  return json as Record<string, unknown>;
}

async function readChecked<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  filePath: string,
): Promise<T> {
  return parseWith(schema, await readJsonFile(filePath), filePath);
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
