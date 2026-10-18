// Self-test fixture for the guard timing instrumentation. Same stdin JSON and process.exit path as
// the guard. The command picks the case: "quadratic" runs a regex that backtracks quadratically on
// a long space run and exits 2; anything else runs a linear control and exits 0.
import { readFileSync } from "node:fs";

const QUADRATIC_RUN = 30_000;
const input = JSON.parse(readFileSync(0, "utf8"));
const subject = " ".repeat(QUADRATIC_RUN) + "a";

if (input.tool_input.command === "skip-exit-handlers") {
  // A hard kill skips the preload exit handler, so no timing file is written.
  process.kill(process.pid, "SIGKILL");
}
if (input.tool_input.command === "quadratic") {
  /\s+$/.test(subject);
  process.exit(2);
}
/a$/.test(subject);
process.exit(0);
