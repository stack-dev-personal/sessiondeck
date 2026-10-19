// Self-test fixture for the guard timing instrumentation. Same stdin JSON and process.exit path as
// the guard. The command picks the case: "quadratic" runs a regex that backtracks quadratically on
// a long space run and exits 2; "slow-loop" busy-waits 600 ms with no regex; "hang" never exits (the
// helper timeout kills it); "cpu-in-data" busy-waits 400 ms inside the stdin data handler (no
// regex) and exits 0; "exec-sync" calls execSync once with a command the guard never runs;
// "exec-git" calls execSync once with the guard's exact `git rev-parse --abbrev-ref HEAD`;
// "exit-listener" adds an exit listener that busy-waits 400 ms (sync work after the preload's own
// exit listener) and exits 0; anything else runs a linear control and
// exits 0.
import { execSync } from "node:child_process";

const CPU_IN_DATA_MS = 400;

// Reads stdin through the stream like guard.mjs, so the preload sees the stdin `end` event.
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (chunk.includes("cpu-in-data")) {
        const end = performance.now() + CPU_IN_DATA_MS;
        while (performance.now() < end) {
          // busy wait inside the data handler: CPU that must not be subtracted as stdin wait
        }
      }
    });
    process.stdin.on("end", () => resolve(data));
  });
}

const QUADRATIC_RUN = 24_000;
const input = JSON.parse(await readStdin());
const subject = " ".repeat(QUADRATIC_RUN) + "a";

if (input.tool_input.command === "skip-exit-handlers") {
  // A hard kill skips the preload exit handler, so no timing file is written.
  process.kill(process.pid, "SIGKILL");
}
if (input.tool_input.command === "slow-loop") {
  const end = performance.now() + 600;
  while (performance.now() < end) {
    // busy wait: script time without any regex
  }
  process.exit(0);
}
if (input.tool_input.command === "hang") {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
if (input.tool_input.command === "exec-sync") {
  execSync("node -e 0", { stdio: "ignore", windowsHide: true });
  process.exit(0);
}
if (input.tool_input.command === "exec-git") {
  execSync("git rev-parse --abbrev-ref HEAD", { stdio: "ignore", windowsHide: true });
  process.exit(0);
}
if (input.tool_input.command === "exit-listener") {
  process.on("exit", () => {
    const end = performance.now() + CPU_IN_DATA_MS;
    while (performance.now() < end) {
      // sync work in an exit listener added after the preload's: outside every measured time
    }
  });
  process.exit(0);
}
if (input.tool_input.command === "quadratic") {
  /\s+$/.test(subject);
  process.exit(2);
}
/a$/.test(subject);
process.exit(0);
