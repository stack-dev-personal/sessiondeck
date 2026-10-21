// Vitest setup file. Test databases on disk run with synchronous = OFF: no fsync on commit,
// checkpoint or close. On Windows CI an fsync costs tens of milliseconds, and the CLI and replay
// tests open and close file databases many times (R0.5 budget). Durability is not under test in
// this suite (crash safety is a SQLite property); WAL mode, checkpointing and locking behave the
// same. Production code is unchanged: this wraps Store.open in the test process only.
import { Store } from "../../src/db/store.ts";

const FLAG = Symbol.for("sessiondeck.test.fast-sqlite");
const marked = Store as unknown as Record<symbol, boolean>;

if (!marked[FLAG]) {
  marked[FLAG] = true;
  const open = Store.open.bind(Store);
  Store.open = (dbPath: string): Store => {
    const store = open(dbPath);
    if (dbPath !== ":memory:") store.db.pragma("synchronous = OFF");
    return store;
  };
}
