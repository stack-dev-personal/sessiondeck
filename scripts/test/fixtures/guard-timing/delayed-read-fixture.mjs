// Self-test fixture for the raw script time bound. A guard that sits idle BEFORE it reads stdin
// looks like it did almost no work (the idle time is subtracted as stdin wait), yet the real hook
// would run that long, and a guard that idles past the 5 s hook timeout is allowed. The script
// argument picks the way to stay idle: "timer" waits on a timer for 3600 ms; "exec" starts an
// asynchronous child process that lives 3500 ms and waits for it. Both happen before stdin is
// read, then the fixture exits 0 like an allowing guard.
import { exec } from "node:child_process";

// Just over the 3000 ms raw script bound; a longer idle only makes the self-test slower and, on a
// loaded runner, closer to the 10 s kill limit.
const TIMER_IDLE_MS = 3600;
const EXEC_IDLE_MS = 3500;
const mode = process.argv[2] ?? "timer";

if (mode === "exec") {
  await new Promise((done) => {
    exec(`node -e "setTimeout(() => undefined, ${EXEC_IDLE_MS})"`, { windowsHide: true }, done);
  });
} else {
  await new Promise((done) => setTimeout(done, TIMER_IDLE_MS));
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
await new Promise((resolve) => process.stdin.on("end", resolve));
JSON.parse(data);
process.exit(0);
