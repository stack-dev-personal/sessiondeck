// Ported from simple10/agents-observe hooks/scripts/hook.sh @ b3a7238 (MIT)
// Changes: rewritten in TypeScript for node (exec form, no shell); instead of an HTTP POST the one
// unit of work is a locked single-write append to the local spool; adds bounded stdin, an error
// log, and ULID/seq envelope building. Kept: do the minimum, never print, always exit 0.
import { logHookError, processHookInput } from "./hook-core.ts";
import { readStdin } from "./stdin.ts";

function exit0(): never {
  process.exit(0);
}

// No path may leave a non-zero exit code or print: swallow everything.
process.on("uncaughtException", exit0);
process.on("unhandledRejection", exit0);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"] as const) {
  try {
    process.on(sig, exit0);
  } catch {
    // signal not supported on this platform
  }
}
// A closed stdout must not raise EPIPE; we never write to it anyway.
process.stdout?.on?.("error", () => undefined);
process.stderr?.on?.("error", () => undefined);

async function main(): Promise<void> {
  // Read all of stdin before anything else.
  const input = await readStdin();
  const outcome = processHookInput(input);
  if (!outcome.ok) logHookError(outcome.reason);
}

main().then(exit0, exit0);
