import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.ts";

/**
 * In-memory store by default: per-test directory, WAL files and rm cost dominate on Windows CI
 * (R0.5 budget). Pass { file: true } for tests that reopen the database or check on-disk behavior.
 */
export function tempStore(opts: { file?: boolean } = {}): { store: Store; cleanup: () => void } {
  if (!opts.file) {
    const store = Store.open(":memory:");
    return {
      store,
      cleanup: () => {
        try {
          store.close();
        } catch {
          // already closed
        }
      },
    };
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const store = Store.open(path.join(dir, "hub.sqlite"));
  // Test-only: skip fsync. Durability is not under test here; file-mode tests use Store.open directly.
  store.db.pragma("synchronous = OFF");
  return {
    store,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
