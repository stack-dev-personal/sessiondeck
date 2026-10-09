// Command-line entry for sessions that reach the state helper through Bash. Run from the repo root:
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     packages/contract/src/state-file-cli.ts <command> ...
// Commands:
//   init <stateDir>
//   write-session <stateDir> <sessionId> key=value ...   (merged into the existing file)
//   write-sprint <stateDir> key=value ...                (merged into the existing status.json)
//   read <file>
// Values are parsed as JSON when they parse (pr=4, question_file=null), else kept as text.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureStateLayout,
  readSessionStatus,
  readSprintStatus,
  readStatusFile,
  StateFileError,
  writeSessionStatus,
  writeSprintStatus,
  // @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
} from "./state-file.ts";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
const USAGE =
  "usage: init <stateDir> | write-session <stateDir> <sessionId> key=value... | " +
  "write-sprint <stateDir> key=value... | read <file>";

export interface CliResult {
  code: number;
  output: string;
}

function usage(message: string = USAGE): never {
  throw new StateFileError("usage", message);
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // not JSON, so it is plain text such as a branch name
  }
}

/** key=value pairs to an object; the first "=" splits, so values may contain "=". */
function parsePairs(pairs: readonly string[]): Record<string, unknown> {
  const entries = pairs.map((pair) => {
    const at = pair.indexOf("=");
    return at > 0
      ? ([pair.slice(0, at), parseValue(pair.slice(at + 1))] as const)
      : usage(`not key=value: ${pair}`);
  });
  return Object.fromEntries(entries);
}

async function existingOrEmpty<T extends object>(read: () => Promise<T>): Promise<Partial<T>> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof StateFileError && error.kind === "not-found") return {};
    throw error;
  }
}

async function dispatch(command: string | undefined, args: readonly string[]): Promise<unknown> {
  const [first, second, ...rest] = args;
  if (command === "init" && first !== undefined && second === undefined) {
    return ensureStateLayout(first);
  }
  if (command === "read" && first !== undefined && second === undefined) {
    return readStatusFile(first);
  }
  if (command === "write-session" && first !== undefined && second !== undefined) {
    const current = await existingOrEmpty(() => readSessionStatus(first, second));
    return writeSessionStatus(first, second, { ...current, ...parsePairs(rest) });
  }
  if (command === "write-sprint" && first !== undefined) {
    const current = await existingOrEmpty(() => readSprintStatus(first));
    return writeSprintStatus(first, { ...current, ...parsePairs(args.slice(1)) });
  }
  return usage();
}

/** Runs one command; failures come back as a one-line message, never a stack trace. */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
  try {
    const result = await dispatch(argv[0], argv.slice(1));
    return { code: EXIT_OK, output: `${JSON.stringify(result)}\n` };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: EXIT_FAILURE, output: `state-file: ${message.split("\n")[0]}\n` };
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
