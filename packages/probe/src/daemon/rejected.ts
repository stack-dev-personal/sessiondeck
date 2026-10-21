import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./types.ts";

export const REJECTED_MAX_FILES = 200;
export const REJECTED_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Keeps the rejected-batch directory under a file count and a byte cap by deleting the oldest
 * files first. Logs one summary line when it had to delete anything.
 */
export async function capRejected(
  dir: string,
  maxFiles: number,
  maxBytes: number,
  log: Logger,
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return;
  }
  const files: { path: string; size: number; mtime: number; name: string }[] = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      files.push({ path: join(dir, name), size: st.size, mtime: st.mtimeMs, name });
    } catch {
      // vanished
    }
  }
  files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  let total = files.reduce((n, f) => n + f.size, 0);
  let count = files.length;
  let removed = 0;
  let freed = 0;
  for (const f of files) {
    if (count <= maxFiles && total <= maxBytes) break;
    if (count <= 1) break; // always keep the newest
    await rm(f.path, { force: true });
    count -= 1;
    total -= f.size;
    removed += 1;
    freed += f.size;
  }
  if (removed > 0) {
    log("warn", `rejected/ cap reached: deleted ${removed} oldest file(s), ${freed} bytes`);
  }
}
