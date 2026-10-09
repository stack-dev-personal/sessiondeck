import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_POLL_MS,
  LOCK_STALE_MS,
  LOCK_SUFFIX,
  LOCK_WAIT_MS,
  StateFileError,
  withFileLock,
} from "../src/state-file";

let root: string;
let target: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sd-lock-"));
  target = join(root, "status.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A clock that only moves when the injected sleep is called, so no test waits for real. */
function fakeTime(start: number): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let at = start;
  const slept: number[] = [];
  return {
    now: () => at,
    sleep: (ms) => {
      slept.push(ms);
      at += ms;
      return Promise.resolve();
    },
    slept,
  };
}

const lockFile = (): string => target + LOCK_SUFFIX;

describe("withFileLock", () => {
  it("runs the function under the lock and removes it afterwards", async () => {
    const result = await withFileLock(target, async () => {
      expect(await readdir(root)).toEqual(["status.json.lock"]);
      return 42;
    });
    expect(result).toBe(42);
    expect(await readdir(root)).toEqual([]);
  });

  it("removes the lock when the function throws", async () => {
    const run = withFileLock(target, () => Promise.reject(new Error("boom")));
    await expect(run).rejects.toThrow("boom");
    expect(await readdir(root)).toEqual([]);
  });

  it("takes over a lock older than the stale threshold without waiting for it", async () => {
    await writeFile(lockFile(), "");
    const old = new Date(Date.now() - LOCK_STALE_MS * 2);
    await utimes(lockFile(), old, old);
    const ran = await withFileLock(target, () => Promise.resolve("ran"));
    expect(ran).toBe("ran");
    expect(await readdir(root)).toEqual([]);
  });

  it("takes over with an injected clock past the threshold", async () => {
    await writeFile(lockFile(), "");
    const time = fakeTime(Date.now() + LOCK_STALE_MS * 2);
    await withFileLock(target, () => Promise.resolve(), time);
    expect(time.slept.length).toBeLessThanOrEqual(1);
  });

  it("waits for a live lock, then times out with a clear error, without real sleeping", async () => {
    await writeFile(lockFile(), "");
    const time = fakeTime(Date.now());
    const run = withFileLock(target, () => Promise.resolve(), time);
    await expect(run).rejects.toThrow(StateFileError);
    await expect(run).rejects.toMatchObject({ kind: "lock-timeout" });
    await expect(run).rejects.toThrow(/held by another writer after 5000 ms/);
    expect(time.slept.length).toBe(LOCK_WAIT_MS / LOCK_POLL_MS);
    expect(await readdir(root)).toEqual(["status.json.lock"]); // not ours, so not removed
  });

  it("acquires once the holder releases while it waits", async () => {
    await writeFile(lockFile(), "");
    const time = fakeTime(Date.now());
    let first = true;
    const sleep = async (ms: number): Promise<void> => {
      if (first) await rm(lockFile());
      first = false;
      await time.sleep(ms);
    };
    await withFileLock(target, () => Promise.resolve(), { now: time.now, sleep });
    expect(time.slept).toEqual([LOCK_POLL_MS]);
  });

  it("serialises two holders in one process", async () => {
    let inside = 0;
    let overlap = false;
    const section = async (): Promise<void> => {
      inside += 1;
      overlap ||= inside > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    };
    await Promise.all([
      withFileLock(target, section, { pollMs: 1 }),
      withFileLock(target, section, { pollMs: 1 }),
      withFileLock(target, section, { pollMs: 1 }),
    ]);
    expect(overlap).toBe(false);
  });

  it("reports a lock folder that cannot be created", async () => {
    await writeFile(join(root, "file"), "");
    const run = withFileLock(join(root, "file", "x.json"), () => Promise.resolve());
    await expect(run).rejects.toMatchObject({ kind: "write-failed" });
  });
});
