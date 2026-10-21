import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Windows refuses to rename over a file another process holds open; those codes clear quickly. */
const RETRY_CODES = ["EPERM", "EBUSY", "EACCES"];
const MAX_ATTEMPTS = 7;
const BASE_DELAY_MS = 20;

function code(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String(e.code) : "UNKNOWN";
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (!RETRY_CODES.includes(code(e)) || attempt >= MAX_ATTEMPTS) throw e;
      const jitter = 0.5 + 0.5 * Math.random();
      await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** (attempt - 1) * jitter));
    }
  }
}

export interface WriteOptions {
  /** File mode for the new file (POSIX). Defaults to the existing file's mode, else 0o644. */
  mode?: number;
  /** Called with the temp path after it is created and before data is written. */
  beforeWrite?: (tempPath: string) => Promise<void>;
}

/** Writes text to path so readers see the old or the new complete content: tmp, fsync, rename. */
export async function writeFileAtomic(
  path: string,
  text: string,
  opts: WriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode = opts.mode;
  if (mode === undefined) {
    mode = await stat(path).then(
      (s) => s.mode & 0o777,
      () => 0o644,
    );
  }
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const handle = await open(tmp, "wx", mode);
  try {
    if (process.platform !== "win32") {
      await handle.chmod(mode);
      if (((await handle.stat()).mode & 0o777) !== mode)
        throw new Error(`cannot set mode on ${tmp}`);
    }
    if (opts.beforeWrite) await opts.beforeWrite(tmp);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    await renameWithRetry(tmp, path);
  } catch (e) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700);
}
