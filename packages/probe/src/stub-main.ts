import { readStdin } from "./stdin.ts";

/** Shared body of the not-yet-implemented stdin entries: read stdin, print nothing, exit 0. */
export function runStub(): void {
  process.on("uncaughtException", () => process.exit(0));
  readStdin().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
