import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.ts";

export function tempStore(): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const store = Store.open(path.join(dir, "hub.sqlite"));
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
