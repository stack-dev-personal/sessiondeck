import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RENAME_MAX_ATTEMPTS,
  RENAME_RETRY_CODES,
  STALE_TEMP_MS,
  ensureStateLayout,
  renameBackoffMs,
  StateFileError,
  writeStateFileAtomic,
  type RenameFn,
} from "../src/state-file";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sd-atomic-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Fails with `code` for the first `times` calls, then performs the real rename. */
function flaky(code: string, times: number): { fn: RenameFn; calls: () => number } {
  let calls = 0;
  const fn: RenameFn = async (from, to) => {
    calls += 1;
    if (calls <= times) throw Object.assign(new Error("simulated"), { code });
    await rename(from, to);
  };
  return { fn, calls: () => calls };
}

// A poller, as the dashboard is; a back-to-back loop would hold the file open without a gap.
const READ_PAUSE_MS = 2;
// The overwrite loop is bounded by count and by wall time, so a slow runner ends it early instead
// of reaching the per-test timeout; a Windows runner took over 5 s for 50 overwrites.
const OVERWRITES = 20;
const OVERWRITE_BUDGET_MS = 2000;
// The retry tests only need the retry path taken, not the production attempt count.
const FEW_ATTEMPTS = 2;
const ALWAYS = Number.POSITIVE_INFINITY;
const READ_ONLY_MODE = 0o444;
const WRITABLE_MODE = 0o644;

describe("writeStateFileAtomic", () => {
  it("leaves only the target after success, with a trailing newline", async () => {
    const target = join(root, "status.json");
    await writeStateFileAtomic(target, { a: 1 });
    expect(await readdir(root)).toEqual(["status.json"]);
    expect(await readFile(target, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  it("creates a missing parent directory", async () => {
    const target = join(root, "sessions", "S1.json");
    await writeStateFileAtomic(target, { ok: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ ok: true });
  });

  it("replaces an existing file completely", async () => {
    const target = join(root, "status.json");
    await writeFile(target, "x".repeat(5000));
    await writeStateFileAtomic(target, { short: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ short: true });
  });

  it("removes the temp file and names the path when the rename fails", async () => {
    const target = join(root, "occupied");
    await mkdir(target);
    const run = writeStateFileAtomic(target, { a: 1 }, { retryDelayMs: 0 });
    await expect(run).rejects.toThrow(StateFileError);
    await expect(run).rejects.toThrow(target);
    expect(await readdir(root)).toEqual(["occupied"]);
  });

  it("wraps a failure before the rename and leaves no temp file", async () => {
    const blocker = join(root, "blocker");
    await writeFile(blocker, "");
    const run = writeStateFileAtomic(join(blocker, "x.json"), {});
    await expect(run).rejects.toMatchObject({ kind: "write-failed" });
    await expect(run).rejects.toThrow(/cannot write .*x\.json/);
    expect(await readdir(root)).toEqual(["blocker"]);
  });

  it("reports a temp file that cannot be removed without hiding the original error", async () => {
    const { fn: rejecting } = flaky("EXDEV", ALWAYS);
    const busy = (): Promise<void> =>
      Promise.reject(Object.assign(new Error("x"), { code: "EBUSY" }));
    const target = join(root, "t.json");
    await expect(
      writeStateFileAtomic(target, {}, { rename: rejecting, remove: busy }),
    ).rejects.toThrow(/EXDEV.*not removed: EBUSY/s);
    const noCode = (): Promise<void> => Promise.reject(new Error("no code"));
    await expect(
      writeStateFileAtomic(target, {}, { rename: rejecting, remove: noCode }),
    ).rejects.toThrow(/not removed: UNKNOWN/);
  });

  it.each(["ENOTDIR", "ENOENT"])(
    "adds no cleanup note when the temp file is not there (%s)",
    async (code) => {
      const { fn: rejecting } = flaky("EXDEV", ALWAYS);
      const absent = (): Promise<void> => Promise.reject(Object.assign(new Error("x"), { code }));
      const run = writeStateFileAtomic(
        join(root, "t.json"),
        {},
        { rename: rejecting, remove: absent },
      );
      await expect(run).rejects.toThrow(/EXDEV/);
      await expect(run).rejects.not.toThrow(/not removed/);
    },
  );

  it("never lets a concurrent reader see a partial file across bounded overwrites", async () => {
    const target = join(root, "status.json");
    await writeStateFileAtomic(target, { n: 0, pad: "p".repeat(4000) });
    let writing = true;
    const torn: string[] = [];
    let reads = 0;
    // Runs while the writes happen; a plain truncate-and-write would be caught mid-way.
    const reader = (async (): Promise<void> => {
      while (writing) {
        try {
          JSON.parse(await readFile(target, "utf8"));
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, READ_PAUSE_MS));
        } catch (error: unknown) {
          const code = (error as { code?: string }).code;
          // A Windows sharing violation on open is not a torn read; a parse error is.
          if (code === undefined || !RENAME_RETRY_CODES.includes(code)) torn.push(String(error));
        }
      }
    })();
    // On Windows a polling reader can make a rename fail for longer than any sane retry budget
    // (see RENAME_MAX_ATTEMPTS); that is a dropped write, not a torn read, and the retry budget
    // has its own tests. A small budget here keeps the test fast while the reader keeps polling.
    const quickRetry = { maxAttempts: 3, retryDelayMs: 2 };
    let dropped = 0;
    let attempted = 0;
    const deadline = Date.now() + OVERWRITE_BUDGET_MS;
    for (let n = 1; n <= OVERWRITES && (n === 1 || Date.now() < deadline); n += 1) {
      attempted += 1;
      const pad = "p".repeat(n % 2 === 0 ? 10 : 4000);
      await writeStateFileAtomic(target, { n, pad }, quickRetry).catch((error: unknown) => {
        const retryable =
          error instanceof StateFileError && ["write-failed", "busy"].includes(error.kind);
        if (!retryable) throw error;
        dropped += 1;
      });
    }
    writing = false;
    await reader;
    expect(torn).toEqual([]);
    expect(reads).toBeGreaterThan(0);
    expect(dropped).toBeLessThan(attempted);
    expect(await readdir(root)).toEqual(["status.json"]);
  });

  it("hands a reader the previous complete content at the moment of the rename", async () => {
    // Deterministic check of the old-or-new guarantee: no timing, no reader loop. A writer that
    // touched the target before the rename (a plain writeFile) would fail the first assertion.
    const target = join(root, "status.json");
    const before = { n: 0, pad: "p".repeat(4000) };
    await writeStateFileAtomic(target, before);
    const previous = await readFile(target, "utf8");
    const seen: { target: string; temp: string }[] = [];
    const inspecting: RenameFn = async (from, to) => {
      seen.push({ target: await readFile(to, "utf8"), temp: await readFile(from, "utf8") });
      await rename(from, to);
    };
    await writeStateFileAtomic(target, { n: 1, pad: "q" }, { rename: inspecting });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toBe(previous);
    expect(JSON.parse(seen[0]?.temp ?? "")).toEqual({ n: 1, pad: "q" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ n: 1, pad: "q" });
  });

  it("uses distinct temp names for concurrent writers", async () => {
    const target = join(root, "status.json");
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => writeStateFileAtomic(target, { n }, { retryDelayMs: 1 })),
    );
    expect(await readdir(root)).toEqual(["status.json"]);
  });
});

describe("rename retry (Windows sharing violations)", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("succeeds after two %s failures", async (code) => {
    const { fn, calls } = flaky(code, 2);
    await writeStateFileAtomic(
      join(root, "status.json"),
      { a: 1 },
      { rename: fn, retryDelayMs: 0 },
    );
    expect(calls()).toBe(3);
    expect(await readdir(root)).toEqual(["status.json"]);
  });

  it("fails after exactly the configured attempts, naming path and code", async () => {
    const { fn, calls } = flaky("EPERM", ALWAYS);
    const target = join(root, "status.json");
    const run = writeStateFileAtomic(target, {}, { rename: fn, maxAttempts: 3, retryDelayMs: 0 });
    await expect(run).rejects.toThrow(`cannot replace ${target}: EPERM after 3 attempt(s)`);
    expect(calls()).toBe(3);
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a rename that stays blocked as busy, so callers can retry later", async () => {
    for (const code of RENAME_RETRY_CODES) {
      const { fn } = flaky(code, ALWAYS);
      const run = writeStateFileAtomic(
        join(root, "b.json"),
        {},
        { rename: fn, retryDelayMs: 0, maxAttempts: FEW_ATTEMPTS },
      );
      await expect(run).rejects.toMatchObject({ kind: "busy" });
    }
  });

  it("reports a read-only target as write-failed, since retrying cannot help", async () => {
    // Read-only attribute on Windows, mode 444 on Linux. The blocked rename is injected so the
    // test behaves the same on both: only the stat of the target tells the two cases apart.
    const target = join(root, "status.json");
    await writeFile(target, "{}\n");
    await chmod(target, READ_ONLY_MODE);
    try {
      for (const code of RENAME_RETRY_CODES) {
        const { fn } = flaky(code, ALWAYS);
        const run = writeStateFileAtomic(
          target,
          { a: 1 },
          { rename: fn, retryDelayMs: 0, maxAttempts: FEW_ATTEMPTS },
        );
        await expect(run).rejects.toMatchObject({ kind: "write-failed" });
        await expect(run).rejects.toThrow(/read-only/);
      }
    } finally {
      await chmod(target, WRITABLE_MODE);
    }
  });

  // Only Windows refuses a real rename over a read-only file; POSIX checks the directory instead.
  it.skipIf(process.platform !== "win32")(
    "reports a really read-only target as write-failed with the real rename",
    async () => {
      const target = join(root, "status.json");
      await writeFile(target, "{}\n");
      await chmod(target, READ_ONLY_MODE);
      try {
        const run = writeStateFileAtomic(
          target,
          { a: 1 },
          { retryDelayMs: 0, maxAttempts: FEW_ATTEMPTS },
        );
        await expect(run).rejects.toMatchObject({ kind: "write-failed" });
        expect(await readFile(target, "utf8")).toBe("{}\n");
      } finally {
        await chmod(target, WRITABLE_MODE);
      }
    },
  );

  it("still reports busy for a writable target that exists", async () => {
    const target = join(root, "status.json");
    await writeFile(target, "{}\n");
    const { fn } = flaky("EBUSY", ALWAYS);
    const run = writeStateFileAtomic(target, { a: 1 }, { rename: fn, retryDelayMs: 0 });
    await expect(run).rejects.toMatchObject({ kind: "busy" });
  });

  it("keeps a permanent failure as write-failed, not busy", async () => {
    const { fn } = flaky("ENOSPC", ALWAYS);
    const run = writeStateFileAtomic(join(root, "b.json"), {}, { rename: fn });
    await expect(run).rejects.toMatchObject({ kind: "write-failed" });
  });

  it("uses the default attempt count", async () => {
    const { fn, calls } = flaky("EBUSY", ALWAYS);
    const run = writeStateFileAtomic(join(root, "s.json"), {}, { rename: fn, retryDelayMs: 0 });
    await expect(run).rejects.toThrow(/EBUSY/);
    expect(calls()).toBe(RENAME_MAX_ATTEMPTS);
  });

  it("does not retry other codes", async () => {
    const { fn, calls } = flaky("ENOSPC", ALWAYS);
    await expect(writeStateFileAtomic(join(root, "s.json"), {}, { rename: fn })).rejects.toThrow(
      /ENOSPC/,
    );
    expect(calls()).toBe(1);
  });

  it("reports UNKNOWN when the failure has no code", async () => {
    const fn: RenameFn = () => Promise.reject(new Error("odd"));
    await expect(writeStateFileAtomic(join(root, "s.json"), {}, { rename: fn })).rejects.toThrow(
      /UNKNOWN/,
    );
  });
});

describe("backoff", () => {
  it("doubles from the base and scales by jitter between the floor and 1", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => renameBackoffMs(n, 20, () => 1))).toEqual([
      20, 40, 80, 160, 320, 640,
    ]);
    expect([1, 2, 3].map((n) => renameBackoffMs(n, 20, () => 0))).toEqual([10, 20, 40]);
    expect(renameBackoffMs(3, 0, () => 0.7)).toBe(0);
  });

  it("sleeps the scheduled delays between attempts, about a second in total", async () => {
    const { fn, calls } = flaky("EPERM", ALWAYS);
    const slept: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    };
    const run = writeStateFileAtomic(
      join(root, "s.json"),
      {},
      { rename: fn, sleep, random: () => 1 },
    );
    await expect(run).rejects.toThrow(/EPERM after 7 attempt\(s\)/);
    expect(calls()).toBe(RENAME_MAX_ATTEMPTS);
    expect(slept).toEqual([20, 40, 80, 160, 320, 640]);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1300);
  });

  it("uses real Math.random and setTimeout by default and still succeeds", async () => {
    const { fn } = flaky("EBUSY", 1);
    await writeStateFileAtomic(join(root, "s.json"), { ok: 1 }, { rename: fn, retryDelayMs: 1 });
    expect(await readdir(root)).toEqual(["s.json"]);
  });
});

describe("values that have no JSON form", () => {
  it("rejects undefined as write-failed and writes nothing", async () => {
    const target = join(root, "s.json");
    await expect(writeStateFileAtomic(target, undefined)).rejects.toMatchObject({
      kind: "write-failed",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a BigInt (and a cycle) as a StateFileError, not a bare TypeError", async () => {
    const target = join(root, "s.json");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const value of [{ n: 1n }, cyclic]) {
      const run = writeStateFileAtomic(target, value);
      await expect(run).rejects.toThrow(StateFileError);
      await expect(run).rejects.toMatchObject({ kind: "write-failed" });
    }
    expect(await readdir(root)).toEqual([]);
  });
});

describe("stale temp files", () => {
  const TEN_MINUTES_S = (STALE_TEMP_MS / 1000) * 2;
  async function makeTemp(dir: string, name: string, ageSeconds: number): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), "partial");
    const then = new Date(Date.now() - ageSeconds * 1000);
    await utimes(join(dir, name), then, then);
  }

  it("a write removes old temp files of its own target and leaves the rest", async () => {
    const dir = join(root, "sessions");
    await makeTemp(dir, ".S1.json.40856.60e6318c.tmp", TEN_MINUTES_S);
    await makeTemp(dir, ".S1.json.40857.aaaaaaaa.tmp", 1);
    await makeTemp(dir, ".S2.json.40858.bbbbbbbb.tmp", TEN_MINUTES_S);
    await writeStateFileAtomic(join(dir, "S1.json"), { ok: true });
    expect((await readdir(dir)).sort()).toEqual([
      ".S1.json.40857.aaaaaaaa.tmp",
      ".S2.json.40858.bbbbbbbb.tmp",
      "S1.json",
    ]);
  });

  it("ensureStateLayout removes old temp files in the root and sessions/", async () => {
    await makeTemp(root, ".status.json.1.abcdef01.tmp", TEN_MINUTES_S);
    await makeTemp(join(root, "sessions"), ".S3.json.2.abcdef02.tmp", TEN_MINUTES_S);
    await makeTemp(join(root, "sessions"), ".S4.json.3.abcdef03.tmp", 2);
    await ensureStateLayout(root);
    expect(await readdir(join(root, "sessions"))).toEqual([".S4.json.3.abcdef03.tmp"]);
    expect((await readdir(root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
