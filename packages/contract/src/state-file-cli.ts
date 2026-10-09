// Command-line entry for sessions that reach the state helper through Bash. Run from the repo root:
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     packages/contract/src/state-file-cli.ts <command> ...
// (needs Node 22.6 or newer). Commands:
//   init <stateDir>
//   write-session <stateDir> <sessionId> [--replace] key=value ...  (merged into the existing file)
//   write-sprint <stateDir> key=value ...                           (merged; sessions per id)
//   read <file>
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureStateLayout,
  mergeSessionStatus,
  mergeSprintStatus,
  readStatusFile,
  scrubSecrets,
  StateFileError,
  type MergeOptions,
} from "./state-file.ts";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const REPLACE_FLAG = "--replace";
export const USAGE =
  "usage: init <stateDir> | write-session <stateDir> <sessionId> [--replace] key=value... | " +
  "write-sprint <stateDir> key=value... | read <file>. " +
  "Values are JSON when they parse (pr=4, question_file=null, sessions={...}), else text; " +
  "text fields (branch, name, current_unit, last_report, verify) keep numbers as text. " +
  `${REPLACE_FLAG} overwrites a session file that is not valid JSON.`;

/** Fields whose schema type is text: `current_unit=3` means the text "3", not the number. */
export const TEXT_FIELDS: readonly string[] = [
  "name",
  "branch",
  "current_unit",
  "last_report",
  "verify",
];

export interface CliResult {
  code: number;
  output: string;
}

function usage(message: string = USAGE): never {
  throw new StateFileError("usage", message);
}

function parseValue(key: string, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // not JSON, so it is plain text such as a branch name
  }
  const isScalar = typeof parsed === "number" || typeof parsed === "boolean";
  return isScalar && TEXT_FIELDS.includes(key) ? raw : parsed;
}

/** key=value pairs to an object; the first "=" splits, so values may contain "=". */
function parsePairs(pairs: readonly string[]): Record<string, unknown> {
  const entries = pairs.map((pair, index) => {
    const at = pair.indexOf("=");
    // Position only: the text may be a credential pasted without its key.
    return at > 0
      ? ([pair.slice(0, at), parseValue(pair.slice(0, at), pair.slice(at + 1))] as const)
      : usage(`argument ${index + 1} after the target is not key=value`);
  });
  return Object.fromEntries(entries);
}

async function dispatch(
  command: string | undefined,
  args: readonly string[],
  options: MergeOptions,
): Promise<unknown> {
  const [first, second, ...rest] = args;
  if (command === "init" && first !== undefined && second === undefined) {
    return ensureStateLayout(first);
  }
  if (command === "read" && first !== undefined && second === undefined) {
    return readStatusFile(first);
  }
  if (command === "write-session" && first !== undefined && second !== undefined) {
    const pairs = rest.filter((arg) => arg !== REPLACE_FLAG);
    const replace = pairs.length !== rest.length;
    return mergeSessionStatus(first, second, parsePairs(pairs), { ...options, replace });
  }
  if (command === "write-sprint" && first !== undefined) {
    return mergeSprintStatus(first, parsePairs(args.slice(1)), options);
  }
  return usage();
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Last line of defence: whatever a lower layer echoed, a credential shape never reaches a log.
  return scrubSecrets(text.split("\n")[0] ?? "");
}

/** Runs one command; failures come back as a one-line message, never a stack trace. */
export async function runCli(
  argv: readonly string[],
  options: MergeOptions = {},
): Promise<CliResult> {
  try {
    const result = await dispatch(argv[0], argv.slice(1), options);
    return { code: EXIT_OK, output: `${JSON.stringify(result)}\n` };
  } catch (error: unknown) {
    const hint =
      error instanceof StateFileError &&
      error.kind === "invalid-json" &&
      argv[0] === "write-session"
        ? `; pass ${REPLACE_FLAG} to overwrite it`
        : "";
    return { code: EXIT_FAILURE, output: `state-file: ${messageOf(error)}${hint}\n` };
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // realpath on both sides: drive-letter case and symlinks differ between cwd and import.meta.url.
  return (
    realpathSync.native(resolve(entry)) === realpathSync.native(fileURLToPath(import.meta.url))
  );
}

if (isMain()) {
  const { code, output } = await runCli(process.argv.slice(2));
  (code === EXIT_OK ? process.stdout : process.stderr).write(output);
  process.exitCode = code;
}
