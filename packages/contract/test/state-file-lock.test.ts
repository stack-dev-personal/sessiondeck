import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_POLL_MS,
  LOCK_STALE_MS,
  LOCK_SUFFIX,
  LOCK_WAIT_MS,
  RELEASE_RETRIES,
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
    // A large poll step keeps this at 5 rounds of real fs work; the default 25 ms means 200 rounds,
    // which can exceed the 5 s test limit on a loaded Windows runner (R0.5).
    const pollMs = 1_000;
    const run = withFileLock(target, () => Promise.resolve(), { ...time, pollMs });
    await expect(run).rejects.toThrow(StateFileError);
    await expect(run).rejects.toMatchObject({ kind: "lock-timeout" });
    await expect(run).rejects.toThrow(/held by another writer after 5000 ms/);
    expect(time.slept.length).toBe(LOCK_WAIT_MS / pollMs);
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

  it("writes a random token into the lock, a different one for each holder", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await withFileLock(target, async () => {
        tokens.push(await readFile(lockFile(), "utf8"));
      });
    }
    expect(tokens[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("leaves a lock that another writer took over while this holder was paused", async () => {
    await withFileLock(target, async () => {
      // Holder A is paused past the stale threshold; B takes the lock over and is still inside.
      await rm(lockFile());
      await writeFile(lockFile(), "token-of-b");
    });
    // A's release must not delete the lock that now belongs to B.
    expect(await readFile(lockFile(), "utf8")).toBe("token-of-b");
  });

  it("does not fail when its own lock is already gone at release", async () => {
    await withFileLock(target, () => rm(lockFile()));
    expect(await readdir(root)).toEqual([]);
  });
});

describe("a failed token write", () => {
  it("removes the empty lock so the next writer is not blocked, and reports write-failed", async () => {
    const writeToken = (): Promise<void> =>
      Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    const run = withFileLock(target, () => Promise.resolve(), { writeToken });
    await expect(run).rejects.toMatchObject({ kind: "write-failed" });
    await expect(run).rejects.toThrow(/ENOSPC/);
    expect(await readdir(root)).toEqual([]);
    // Space is back: the very next writer gets the lock at once instead of timing out.
    const time = fakeTime(Date.now());
    await withFileLock(target, () => Promise.resolve(), time);
    expect(time.slept).toEqual([]);
  });
});

describe("release when the token cannot be read", () => {
  const readFailing =
    (code: string, failures: number) =>
    (path: string): Promise<string> => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(Object.assign(new Error("simulated"), { code }));
      }
      return readFile(path, "utf8");
    };

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a read that fails with %s and then removes the lock",
    async (code) => {
      const time = fakeTime(Date.now());
      const ran = await withFileLock(target, () => Promise.resolve("done"), {
        ...time,
        readToken: readFailing(code, 2),
      });
      expect(ran).toBe("done");
      expect(time.slept.length).toBe(2);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("leaves the lock for stale takeover, without throwing, when every read fails", async () => {
    const time = fakeTime(Date.now());
    const ran = await withFileLock(target, () => Promise.resolve("written"), {
      ...time,
      readToken: readFailing("EPERM", Number.POSITIVE_INFINITY),
    });
    expect(ran).toBe("written");
    expect(time.slept.length).toBe(RELEASE_RETRIES - 1);
    expect(await readdir(root)).toEqual(["status.json.lock"]);
  });

  it("does not retry a code that is not a sharing violation, and does not throw", async () => {
    const time = fakeTime(Date.now());
    const ran = await withFileLock(target, () => Promise.resolve("written"), {
      ...time,
      readToken: readFailing("EIO", Number.POSITIVE_INFINITY),
    });
    expect(ran).toBe("written");
    expect(time.slept).toEqual([]);
    expect(await readdir(root)).toEqual(["status.json.lock"]);
  });
});

describe("a lock that cannot be created", () => {
  const denied = (code: string) => (): Promise<void> =>
    Promise.reject(Object.assign(new Error("denied"), { code }));

  it.each(["EPERM", "EACCES", "ENOENT"])(
    "fails at once with write-failed on %s when no lock file exists",
    async (code) => {
      const time = fakeTime(Date.now());
      const run = withFileLock(target, () => Promise.resolve(), { ...time, create: denied(code) });
      await expect(run).rejects.toMatchObject({ kind: "write-failed" });
      await expect(run).rejects.toThrow(new RegExp(code));
      await expect(run).rejects.not.toThrow(/held by another writer/);
      expect(time.slept).toEqual([]);
    },
  );

  it.each(["EPERM", "EACCES"])(
    "still counts %s as contention when a lock file exists",
    async (code) => {
      await writeFile(lockFile(), "someone");
      const time = fakeTime(Date.now());
      const pollMs = 1_000; // 5 rounds instead of 200 real fs rounds (R0.5)
      const run = withFileLock(target, () => Promise.resolve(), {
        ...time,
        pollMs,
        create: denied(code),
      });
      await expect(run).rejects.toMatchObject({ kind: "lock-timeout" });
      expect(time.slept.length).toBe(LOCK_WAIT_MS / pollMs);
    },
  );

  it("retries once when the lock file vanishes between the failed create and the check", async () => {
    let calls = 0;
    const create = (): Promise<void> => {
      calls += 1;
      return calls === 1 ? denied("EPERM")() : Promise.resolve();
    };
    await withFileLock(target, () => Promise.resolve(), { create });
    expect(calls).toBe(2);
  });

  it("fails with write-failed for a code that is not contention", async () => {
    const run = withFileLock(target, () => Promise.resolve(), { create: denied("ENOSPC") });
    await expect(run).rejects.toMatchObject({ kind: "write-failed" });
  });
});
