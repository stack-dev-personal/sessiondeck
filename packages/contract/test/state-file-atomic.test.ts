import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RENAME_MAX_ATTEMPTS,
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

const ALWAYS = Number.POSITIVE_INFINITY;

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

  it("never lets a reader see a partial file across 50 overwrites", async () => {
    const target = join(root, "status.json");
    await writeStateFileAtomic(target, { n: 0, pad: "p".repeat(4000) });
    for (let n = 1; n <= 50; n += 1) {
      await writeStateFileAtomic(target, { n, pad: "p".repeat(n % 2 === 0 ? 10 : 4000) });
      const parsed = JSON.parse(await readFile(target, "utf8")) as { n: number };
      expect(parsed.n).toBe(n);
    }
    expect(await readdir(root)).toEqual(["status.json"]);
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
