// Child of lock-race.proc.test.ts. Prints READY once started, then waits for a line holding a
// wall-clock instant on stdin, spins until then, tries to take the lock, prints WON or LOST, and
// holds a won lock for a while. Run with node's built-in TypeScript stripping.
import { acquireLock } from "../src/daemon/lock.ts";

const [lockPath, holdMs] = process.argv.slice(2);
process.stdout.write("READY\n");
process.stdin.once("data", (buf) => {
  const startAt = Number(String(buf).trim());
  while (Date.now() < startAt) {
    // spin: all children contend within the same millisecond or two
  }
  const lock = acquireLock(lockPath);
  process.stdout.write(lock ? "WON\n" : "LOST\n");
  if (lock) setTimeout(() => process.exit(0), Number(holdMs));
  else process.exit(0);
});
