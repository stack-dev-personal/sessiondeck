// Child of lock-race.proc.test.ts: waits for a wall-clock instant, tries to take the lock, prints
// WON or LOST, and holds a won lock for a while. Run with node's built-in TypeScript stripping.
import { acquireLock } from "../src/daemon/lock.ts";

const [lockPath, startAt, holdMs] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // spin: all children contend within the same millisecond or two
}
const lock = acquireLock(lockPath);
process.stdout.write(lock ? "WON\n" : "LOST\n");
if (lock) setTimeout(() => process.exit(0), Number(holdMs));
else process.exit(0);
