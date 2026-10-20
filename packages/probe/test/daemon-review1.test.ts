import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@sessiondeck/contract";
import { parseBackoffCapMs } from "../src/daemon/env-knobs.ts";
import { checkHubUrl } from "../src/daemon/hub-url.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.ts";
import { acquireLock } from "../src/daemon/lock.ts";
import { createOutbox } from "../src/daemon/outbox.ts";
import { DAY_GRACE_MS, DayFileReader } from "../src/daemon/reader.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { outboxDir, spoolDir } from "../src/paths.ts";
import type { SpoolLine } from "../src/spool-format.ts";
import { appendSpoolLines } from "../src/spool-writer.ts";

let home: string;
const open: DaemonHandle[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sd-review1-"));
});
afterEach(async () => {
  for (const d of open.splice(0)) await d.kill();
  rmSync(home, { recursive: true, force: true });
});

const noLog = (): void => undefined;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(10);
  if (!cond()) throw new Error("timed out waiting");
}

function line(n: number, ts = Date.now(), kind: "hook" | "probe" = "hook", pad = 0): SpoolLine {
  return buildEnvelope({
    kind,
    host: "h",
    session_id: kind === "hook" ? "s1" : null,
    ...(kind === "hook" ? { hook_event_name: "PostToolUse" } : {}),
    payload: { n, pad: "x".repeat(pad) },
    ts,
  });
}
const nOf = (e: { payload: unknown }): number => (e.payload as { n: number }).n;

interface Req {
  bytes: number;
  envs: Envelope[];
  redirect: RequestInit["redirect"];
}
/** Records every POST; `answer(req, count)` returns the HTTP status. */
function recordingFetch(answer: (r: Req, count: number) => number) {
  const reqs: Req[] = [];
  const f = (async (_u: URL | string, init?: RequestInit) => {
    const text = String(init?.body);
    const body = JSON.parse(text) as { envelopes: Envelope[] };
    const r: Req = {
      bytes: Buffer.byteLength(text),
      envs: body.envelopes,
      redirect: init?.redirect,
    };
    const status = answer(r, reqs.length);
    reqs.push(r);
    return new Response("{}", { status });
  }) as typeof fetch;
  return { f, reqs };
}

const cfg = { hubUrl: "http://127.0.0.1:9", token: "secret-token", host: "h" };
const fast = { pollMs: 5, batchMs: 20, heartbeatMs: 0, rng: () => 0 };
const logText = (): string => readFileSync(join(home, "daemon", "daemon.log"), "utf8");
/** Log text, or "" while the file does not exist yet (for polling). */
const logTextOrEmpty = (): string => {
  try {
    return logText();
  } catch {
    return "";
  }
};

describe("R1.5 byte budget and 413", () => {
  it("a reader takes an oversize first item only when allowed (buffer empty)", async () => {
    const dir = join(home, "spool");
    appendSpoolLines(dir, [line(1, 1, "hook", 3000)], undefined);
    const msgs: string[] = [];
    const r = new DayFileReader(dir, undefined, (_l, m) => msgs.push(m));
    const refused = await r.read(10, 1000, false);
    expect(refused.items).toHaveLength(0);
    expect(refused.full).toBe(true);
    expect(r.position?.offset ?? 0).toBe(0); // not consumed, not dropped as a torn tail
    expect(msgs).toEqual([]);
    const allowed = await r.read(10, 1000, true);
    expect(allowed.items).toHaveLength(1);
    expect(allowed.full).toBe(false);
  });

  it("bodies stay under maxBodyBytes while big lines keep arriving during the batch window", async () => {
    const max = 40_000;
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      batchMs: 150,
      maxBodyBytes: max,
    }))!;
    open.push(d);
    let n = 0;
    for (let i = 0; i < 40; i++) {
      appendSpoolLines(spoolDir(home), [line(n++, Date.now(), "hook", 9000)]);
      await sleep(8);
    }
    await waitFor(
      () => fx.reqs.flatMap((r) => r.envs).filter((e) => e.kind === "hook").length === 40,
    );
    expect(fx.reqs.length).toBeGreaterThan(1);
    for (const r of fx.reqs) expect(r.bytes).toBeLessThanOrEqual(max);
  });

  it("a 413 splits the batch and resends the halves with the same ids and seq", async () => {
    appendSpoolLines(
      spoolDir(home),
      Array.from({ length: 12 }, (_, i) => line(i, 1000 + i)),
    );
    const fx = recordingFetch((r) => (r.envs.length > 3 ? 413 : 200));
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 200 }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && d.nextSeq() >= 13);
    const ok = fx.reqs.filter((r) => r.envs.length <= 3).flatMap((r) => r.envs);
    expect(ok.map((e) => e.seq)).toEqual([...ok.keys()]);
    expect(new Set(ok.map((e) => e.id)).size).toBe(ok.length);
    expect(ok.filter((e) => e.kind === "hook").map(nOf)).toEqual([...Array(12).keys()]);
    expect(readdirSync(join(home, "daemon", "rejected"))).toEqual([]);
    expect(logText()).toContain("splitting");
  });

  it("a single envelope the hub calls too large is rejected, the rest is delivered", async () => {
    appendSpoolLines(spoolDir(home), [line(0, 1000), line(1, 1001, "hook", 5000), line(2, 1002)]);
    const fx = recordingFetch((r) => (r.envs.some((e) => nOf(e) === 1) ? 413 : 200));
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 200 }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && fx.reqs.length >= 3);
    const rej = readdirSync(join(home, "daemon", "rejected"));
    expect(rej).toHaveLength(1);
    expect(readFileSync(join(home, "daemon", "rejected", rej[0]!), "utf8")).toContain('"n":1');
    const delivered = fx.reqs
      .filter((r) => r.envs.every((e) => nOf(e) !== 1))
      .flatMap((r) => r.envs)
      .filter((e) => e.kind === "hook")
      .map(nOf);
    expect(delivered.sort()).toEqual([0, 2]);
  });
});

describe("R1.4 seq follows ts across the outbox and the spool", () => {
  it("merges both sources by ts, including across batches of a large backlog", async () => {
    appendSpoolLines(
      spoolDir(home),
      Array.from({ length: 450 }, (_, i) => line(i, 10_000 + i * 10)),
    );
    const put = createOutbox(outboxDir(home));
    for (let i = 0; i < 40; i++) put(line(1000 + i, 10_005 + i * 100, "probe"));
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 100 }))!;
    open.push(d);
    await waitFor(
      () => fx.reqs.flatMap((r) => r.envs).filter((e) => e.kind === "hook").length === 450,
    );
    await waitFor(() => d.pending() === 0);
    const all = fx.reqs.flatMap((r) => r.envs);
    expect(all.map((e) => e.seq)).toEqual([...all.keys()]);
    const mine = all.filter((e) => e.ts < 1e6); // not the heartbeat (ts = now)
    expect(mine).toHaveLength(490);
    for (let i = 1; i < mine.length; i++)
      expect(mine[i]!.ts).toBeGreaterThanOrEqual(mine[i - 1]!.ts);
    for (const r of fx.reqs) expect(r.envs.length).toBeLessThanOrEqual(200);
  });

  it("resends an older journal (spool_from, no spool_idx) and reports the right spool lines", async () => {
    const mk = (id: string, kind: "hook" | "probe", seq: number): Envelope =>
      ({ ...line(seq, 1000 + seq, kind), id, seq }) as Envelope;
    const envelopes = [mk("A", "probe", 0), mk("B", "hook", 1), mk("C", "hook", 2)];
    mkdirSync(join(home, "daemon"), { recursive: true });
    writeFileSync(
      join(home, "daemon", "state.json"),
      JSON.stringify({ v: 1, next_seq: 0, pending: { first_seq: 0, envelopes, spool_from: 1 } }),
    );
    const seen: string[] = [];
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      components: [{ name: "t", onSpoolLine: (e) => seen.push(e.id) }],
    }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && fx.reqs.length >= 1);
    expect(seen).toEqual(["B", "C"]);
    expect(fx.reqs[0]!.envs.map((e) => e.id)).toEqual(["A", "B", "C"]);
  });
});

/** Writes a lock file the way a daemon did. */
function writeLock(path: string, info: Record<string, unknown> | string, ageMs = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof info === "string" ? info : JSON.stringify(info));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
}

describe("R1.4 single-instance lock", () => {
  const lockPath = (): string => join(home, "daemon", "daemon.lock");
  const bootNow = Date.now() - 3_600_000;
  const deps = { bootMs: () => bootNow };

  it("takes over a lock whose pid is dead", () => {
    writeLock(lockPath(), { pid: 2147483000, boot: bootNow, token: "x" });
    expect(acquireLock(lockPath(), deps)).toBeDefined();
  });

  it("keeps a live lock: same pid alive, same boot, fresh", () => {
    writeLock(lockPath(), { pid: process.ppid, boot: bootNow, token: "x" });
    expect(acquireLock(lockPath(), deps)).toBeUndefined();
  });

  it("pid reuse after a reboot: a live pid with another boot time is taken over", () => {
    writeLock(lockPath(), { pid: process.ppid, boot: bootNow - 86_400_000, token: "x" });
    const l = acquireLock(lockPath(), deps);
    expect(l).toBeDefined();
    expect(JSON.parse(readFileSync(`${lockPath()}.1`, "utf8")).pid).toBe(process.pid);
  });

  it("pid reuse without a reboot: a live pid, lock not touched for 11 minutes, is taken over", () => {
    writeLock(lockPath(), { pid: process.ppid, boot: bootNow, token: "x" }, 11 * 60_000);
    expect(acquireLock(lockPath(), deps)).toBeDefined();
  });

  it.skipIf(process.platform !== "linux")(
    "pid reuse: a live pid with another process start time is taken over",
    () => {
      writeLock(lockPath(), { pid: process.ppid, boot: bootNow, start: 1, token: "x" });
      expect(acquireLock(lockPath(), deps)).toBeDefined();
    },
  );

  it("a touched lock stays live; a lock with our pid that this process does not hold is stale", () => {
    const a = acquireLock(lockPath(), deps)!;
    expect(a.touch()).toBe(true);
    expect(acquireLock(lockPath(), deps)).toBeUndefined();
    writeLock(join(home, "d2", "daemon.lock"), { pid: process.pid, boot: bootNow, token: "old" });
    expect(acquireLock(join(home, "d2", "daemon.lock"), deps)).toBeDefined();
    a.release();
  });

  it("touch reports a lost lock (higher generation) and release leaves everything alone", () => {
    const a = acquireLock(lockPath(), deps)!;
    writeLock(`${lockPath()}.2`, { pid: process.ppid, boot: bootNow, token: "other" });
    expect(a.touch()).toBe(false);
    a.release();
    expect(JSON.parse(readFileSync(`${lockPath()}.2`, "utf8")).token).toBe("other");
    expect(existsSync(`${lockPath()}.1`)).toBe(true); // skipped: we were fenced
  });

  it("taking over increments the generation and the new owner removes the old files", () => {
    writeLock(`${lockPath()}.3`, { pid: 2147483000, boot: bootNow, token: "x" });
    writeLock(`${lockPath()}.2`, { pid: 2147483000, boot: bootNow, token: "y" });
    writeLock(lockPath(), "2147483000"); // legacy generation 0
    const l = acquireLock(lockPath(), deps)!;
    expect(l).toBeDefined();
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.4"]);
    l.release();
    // tombstone (pid 0) keeps the generation number from being reused
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.4"]);
    expect(JSON.parse(readFileSync(`${lockPath()}.4`, "utf8")).pid).toBe(0);
    expect(acquireLock(lockPath(), deps)).toBeDefined();
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.5"]);
  });

  it("no lock: generation 1; an existing generation that appears first wins (EEXIST)", () => {
    const l = acquireLock(lockPath(), deps)!;
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.1"]);
    const link = (_a: string, t: string): void => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
      void t;
    };
    expect(acquireLock(join(home, "d2", "daemon.lock"), { ...deps, link })).toBeUndefined();
    l.release();
  });

  it("a legacy daemon.lock from an older build is generation 0: live blocks, stale is replaced", () => {
    writeLock(lockPath(), { pid: process.ppid, boot: bootNow, token: "old" });
    expect(acquireLock(lockPath(), deps)).toBeUndefined();
    writeLock(lockPath(), { pid: 2147483000, boot: bootNow, token: "old" });
    const l = acquireLock(lockPath(), deps)!;
    expect(l).toBeDefined();
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.1"]);
    l.release();
  });

  it("verify is false once a higher generation appears, even with our file intact", () => {
    const l = acquireLock(lockPath(), deps)!;
    expect(l.verify()).toBe(true);
    writeLock(`${lockPath()}.2`, "{}");
    expect(l.verify()).toBe(false);
    expect(l.touch()).toBe(false);
  });

  it("touch tolerates a read error on our file and recreates a vanished one", () => {
    const l = acquireLock(lockPath(), deps)!;
    const mine = `${lockPath()}.1`;
    const token = JSON.parse(readFileSync(mine, "utf8")).token;
    rmSync(mine);
    expect(l.touch()).toBe(true);
    expect(JSON.parse(readFileSync(mine, "utf8")).token).toBe(token);
    rmSync(mine);
    mkdirSync(mine); // reading it fails with EISDIR: a transient, not a takeover
    expect(l.touch()).toBe(true);
    rmSync(mine, { recursive: true });
    l.release();
  });

  it("without hard links the O_EXCL fallback creates the lock; a young empty file is live", () => {
    const link = (): void => {
      throw Object.assign(new Error("no links"), { code: "EISDIR" });
    };
    const l = acquireLock(lockPath(), { ...deps, link })!;
    expect(l).toBeDefined();
    expect(JSON.parse(readFileSync(`${lockPath()}.1`, "utf8")).pid).toBe(process.pid);
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.1"]);
    l.release();
    writeLock(`${lockPath()}.1`, "", 0);
    expect(acquireLock(lockPath(), { ...deps, link })).toBeUndefined();
    writeLock(`${lockPath()}.1`, "", 60_000);
    expect(acquireLock(lockPath(), { ...deps, link })).toBeDefined();
  });

  it("a planted maximum generation is refused loudly, never wrapped into an invisible name", () => {
    writeLock(`${lockPath()}.999999999999999`, { pid: 0 });
    expect(() => acquireLock(lockPath(), deps)).toThrow(/out of range/);
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock.999999999999999"]);
    // longer digit names still count as generations for the fence
    rmSync(`${lockPath()}.999999999999999`);
    const l = acquireLock(lockPath(), deps)!;
    writeLock(`${lockPath()}.1000000000000000`, { pid: 0 });
    expect(l.verify()).toBe(false);
  });

  it("a generation created while we stalled is not ours: tombstone and judge again", () => {
    let planted = false;
    const link = (a: string, t: string): void => {
      if (!planted) {
        planted = true;
        writeLock(`${lockPath()}.2`, { pid: process.ppid, boot: bootNow, token: "c" });
      }
      linkSync(a, t);
    };
    expect(acquireLock(lockPath(), { ...deps, link })).toBeUndefined();
    expect(JSON.parse(readFileSync(`${lockPath()}.1`, "utf8")).pid).toBe(0);
    expect(JSON.parse(readFileSync(`${lockPath()}.2`, "utf8")).token).toBe("c");
  });

  it("startDaemon in that interleaving returns undefined and leaves no live orphan", async () => {
    const dl = join(home, "daemon", "daemon.lock");
    let planted = false;
    const link = (a: string, t: string): void => {
      if (!planted) {
        planted = true;
        writeLock(`${dl}.2`, { pid: process.ppid, token: "c" });
      }
      linkSync(a, t);
    };
    mkdirSync(join(home, "daemon"), { recursive: true });
    expect(await startDaemon({ home, config: undefined, lockDeps: { link } })).toBeUndefined();
    expect(JSON.parse(readFileSync(`${dl}.1`, "utf8")).pid).toBe(0);
  });

  it("touch recreating a vanished file fails if a takeover happened meanwhile", () => {
    let armed = false;
    const link = (a: string, t: string): void => {
      if (armed) writeLock(`${lockPath()}.2`, { pid: process.ppid, token: "c" }); // C wins mid-recreate
      linkSync(a, t);
    };
    const l = acquireLock(lockPath(), { ...deps, link })!;
    rmSync(`${lockPath()}.1`);
    armed = true;
    expect(l.touch()).toBe(false);
    expect(l.verify()).toBe(false);
    expect(JSON.parse(readFileSync(`${lockPath()}.1`, "utf8")).pid).toBe(0); // tombstoned, not live
  });

  it.skipIf(process.platform === "win32")(
    "a FIFO, a symlink or an oversized file as the top generation is stale, never read",
    () => {
      mkdirSync(join(home, "daemon"), { recursive: true });
      execFileSync("mkfifo", [`${lockPath()}.3`]);
      const l = acquireLock(lockPath(), deps)!; // would hang if the FIFO were opened
      expect(l).toBeDefined();
      expect(existsSync(`${lockPath()}.4`)).toBe(true);
      l.release();
      writeFileSync(`${lockPath()}.9`, "x".repeat(10_000));
      expect(acquireLock(lockPath(), deps)).toBeDefined();
      symlinkSync("/dev/zero", `${lockPath()}.20`);
      expect(acquireLock(lockPath(), deps)).toBeDefined();
      expect(existsSync(`${lockPath()}.21`)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a loose lock directory is tightened; a symlinked one is refused",
    () => {
      const dir = join(home, "loose");
      mkdirSync(dir, { mode: 0o777 });
      chmodSync(dir, 0o777);
      acquireLock(join(dir, "daemon.lock"), deps)!.release();
      expect(statSync(dir).mode & 0o077).toBe(0);
      symlinkSync(dir, join(home, "link"));
      expect(() => acquireLock(join(home, "link", "daemon.lock"), deps)).toThrow(/plain directory/);
    },
  );

  it("old temp files are removed by the new owner", () => {
    writeLock(`${lockPath()}.tmp-old`, "x", 120_000);
    writeLock(`${lockPath()}.tmp-new`, "x", 0);
    acquireLock(lockPath(), deps)!;
    expect(readdirSync(join(home, "daemon")).sort()).toEqual([
      "daemon.lock.1",
      "daemon.lock.tmp-new",
    ]);
  });
});

describe("R1.5 day-file rollover grace", () => {
  const midnight = Date.parse("2026-10-21T00:00:00Z");

  it("the grace counts from UTC midnight even when the old file was last written long before", async () => {
    const dir = join(home, "spool");
    appendSpoolLines(dir, [line(0)], () => Date.parse("2026-10-20T23:50:00Z"));
    appendSpoolLines(dir, [line(2)], () => midnight + 50); // hook B, next UTC day
    const f1 = join(dir, "2026-10-20.jsonl");
    const old = new Date(midnight - 600_000); // last write 23:50
    utimesSync(f1, old, old);
    const clock = { now: midnight + 100 };
    const r = new DayFileReader(dir, undefined, noLog, () => clock.now);
    expect((await r.read(10, 1e6)).items.map(nOf)).toEqual([0]);
    expect(r.position?.file).toBe("2026-10-20.jsonl");
    // Hook A, slowed after computing the old name at 23:59:59.99, lands its line now.
    appendFileSync(f1, `${JSON.stringify(line(1))}\n`);
    clock.now = midnight + 5000;
    expect((await r.read(10, 1e6)).items.map(nOf)).toEqual([1]);
    expect(r.position?.file).toBe("2026-10-20.jsonl");
    const t = new Date(midnight + 5000);
    utimesSync(f1, t, t); // quiet since the last append
    clock.now = midnight + 5000 + DAY_GRACE_MS + 1000;
    expect((await r.read(10, 1e6)).items.map(nOf)).toEqual([2]);
    expect(r.position?.file).toBe("2026-10-21.jsonl");
  });

  it("moves on at once when the old file's day ended long ago", async () => {
    const dir = join(home, "spool");
    appendSpoolLines(dir, [line(0)], () => Date.parse("2026-10-10T10:00:00Z"));
    appendSpoolLines(dir, [line(1)], () => Date.parse("2026-10-11T10:00:00Z"));
    const old = new Date(Date.parse("2026-10-10T10:00:00Z"));
    utimesSync(join(dir, "2026-10-10.jsonl"), old, old);
    const r = new DayFileReader(dir, undefined, noLog, () => midnight);
    expect((await r.read(10, 1e6)).items.map(nOf)).toEqual([0, 1]);
  });
});

describe("hub URL policy (security)", () => {
  it("checkHubUrl: https anywhere, http loopback only, opt-in for other http, never userinfo", () => {
    const ok = (u: string, opt = false): boolean => checkHubUrl(u, opt).ok;
    expect(ok("https://hub.example.com")).toBe(true);
    expect(ok("http://localhost:8787")).toBe(true);
    expect(ok("http://127.0.0.1:8787")).toBe(true);
    expect(ok("http://127.8.9.10")).toBe(true);
    expect(ok("http://[::1]:8787")).toBe(true);
    expect(ok("http://192.168.1.20:8787")).toBe(false);
    expect(ok("http://hub.example.com")).toBe(false);
    expect(ok("http://127.0.0.1.evil.test")).toBe(false);
    expect(ok("http://192.168.1.20:8787", true)).toBe(true);
    expect(ok("https://user:pw@hub.example.com")).toBe(false);
    expect(ok("http://user@127.0.0.1")).toBe(false);
    expect(ok("http://user:pw@192.168.1.20", true)).toBe(false);
    expect(ok("ftp://hub.example.com")).toBe(false);
    expect(ok("not a url")).toBe(false);
    expect(checkHubUrl("http://192.168.1.20", true)).toMatchObject({ ok: true, insecure: true });
  });

  it("the daemon sends nothing to a refused URL, and logs a fixed line without URL or token", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: { hubUrl: "http://hub.example.test:8787", token: "secret-token", host: "h" },
      fetch: fx.f,
      ...fast,
      sleep: (ms) => sleep(Math.min(ms, 5)),
    }))!;
    open.push(d);
    // Wait for the line itself (the log is written asynchronously), then give
    // a short window in which a (wrong) send would show up.
    await waitFor(() => logTextOrEmpty().includes("hubUrl refused by policy"));
    await sleep(100);
    expect(fx.reqs).toHaveLength(0);
    const log = logText();
    expect(log).toContain("hubUrl refused by policy");
    expect(log).not.toContain("hub.example.test");
    expect(log).not.toContain("secret-token");
    expect(d.pending()).toBeGreaterThan(0); // held, not dropped
  }, 20_000);

  it("userinfo in the URL is refused even with allowInsecureHub", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: {
        hubUrl: "https://u:p@hub.example.test",
        token: "t",
        host: "h",
        allowInsecureHub: true,
      },
      fetch: fx.f,
      ...fast,
      sleep: (ms) => sleep(Math.min(ms, 5)),
    }))!;
    open.push(d);
    await sleep(200);
    expect(fx.reqs).toHaveLength(0);
  });

  it("allowInsecureHub sends over http to a LAN host, with one fixed warning at start", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: {
        hubUrl: "http://192.168.1.20:8787",
        token: "secret-token",
        host: "h",
        allowInsecureHub: true,
      },
      fetch: fx.f,
      ...fast,
    }))!;
    open.push(d);
    await waitFor(() => fx.reqs.length >= 1);
    const log = logText();
    expect(log.match(/allowInsecureHub is set/g)).toHaveLength(1);
    expect(log).not.toContain("192.168.1.20");
    expect(log).not.toContain("secret-token");
  });

  it("does not follow redirects: the bearer token never reaches the redirect target", async () => {
    let targetHits = 0;
    let firstHits = 0;
    const target = createServer((_q, res) => {
      targetHits += 1;
      res.end("{}");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const tport = (target.address() as AddressInfo).port;
    const first = createServer((_q, res) => {
      firstHits += 1;
      res.writeHead(307, { location: `http://127.0.0.1:${tport}/ingest` });
      res.end();
    });
    await new Promise<void>((r) => first.listen(0, "127.0.0.1", r));
    const fport = (first.address() as AddressInfo).port;
    try {
      appendSpoolLines(spoolDir(home), [line(0)]);
      const d = (await startDaemon({
        home,
        config: { hubUrl: `http://127.0.0.1:${fport}`, token: "secret-token", host: "h" },
        ...fast,
        sleep: (ms) => sleep(Math.min(ms, 5)),
      }))!;
      open.push(d);
      await waitFor(() => firstHits >= 2);
      expect(targetHits).toBe(0);
      expect(d.pending()).toBeGreaterThan(0);
    } finally {
      for (const s of [first, target] as Server[]) s.close();
    }
  });

  it("asks fetch not to follow redirects", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast }))!;
    open.push(d);
    await waitFor(() => fx.reqs.length >= 1);
    expect(fx.reqs[0]!.redirect).toBe("error");
  });
});

describe("rejected/ cap and private directories", () => {
  const rejectedFiles = (): string[] => {
    try {
      return readdirSync(join(home, "daemon", "rejected")).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return [];
    }
  };
  const rejectedText = (): string =>
    rejectedFiles()
      .map((n) => {
        try {
          return readFileSync(join(home, "daemon", "rejected", n), "utf8");
        } catch {
          return "";
        }
      })
      .join("");
  // Timeout: measured 0.5 s locally (4 daemon round trips, each with file
  // writes and a prune). CI on NTFS under concurrent suites took >5 s; 20 s is
  // a ceiling, every wait inside is bounded by waitFor.
  it("keeps at most rejectedMaxFiles files, oldest deleted first, and logs a summary", async () => {
    const fx = recordingFetch(() => 400);
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      rejectedMaxFiles: 2,
      now: (() => {
        let t = Date.now();
        return () => (t += 1);
      })(),
    }))!;
    open.push(d);
    for (let i = 0; i < 4; i++) {
      appendSpoolLines(spoolDir(home), [line(i, 1000 + i)]);
      await waitFor(() => fx.reqs.length >= i + 1 && d.pending() === 0);
      // The rejected file for this line is written and pruned after pending() is 0.
      await waitFor(() => rejectedText().includes(`"n":${i}`));
    }
    await waitFor(
      () => rejectedFiles().length <= 2 && logTextOrEmpty().includes("rejected/ cap reached"),
    );
    const left = readdirSync(join(home, "daemon", "rejected")).filter((n) => n.endsWith(".jsonl"));
    expect(left.length).toBeLessThanOrEqual(2);
    const text = left
      .map((n) => readFileSync(join(home, "daemon", "rejected", n), "utf8"))
      .join("");
    expect(text).toContain('"n":3'); // newest kept
    expect(text).not.toContain('"n":0'); // oldest deleted
    expect(logText()).toContain("rejected/ cap reached");
  }, 20_000);

  it("caps by bytes", async () => {
    const fx = recordingFetch(() => 400);
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      rejectedMaxBytes: 3000,
    }))!;
    open.push(d);
    for (let i = 0; i < 4; i++) {
      appendSpoolLines(spoolDir(home), [line(i, 1000 + i, "hook", 1500)]);
      await waitFor(() => fx.reqs.length >= i + 1 && d.pending() === 0);
      await sleep(30);
    }
    const dir = join(home, "daemon", "rejected");
    const total = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(3000 + 2000); // the newest file is always kept
  });

  it.skipIf(process.platform === "win32")(
    "the daemon makes home, daemon, outbox, rejected and spool user-only, rejected included",
    async () => {
      mkdirSync(join(home, "spool"), { recursive: true });
      chmodSync(join(home, "spool"), 0o755);
      chmodSync(home, 0o755);
      appendSpoolLines(spoolDir(home), [line(0)]);
      const fx = recordingFetch(() => 400);
      const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast }))!;
      open.push(d);
      await waitFor(() => fx.reqs.length >= 1 && d.pending() === 0);
      for (const p of [
        home,
        join(home, "daemon"),
        join(home, "daemon", "outbox"),
        join(home, "daemon", "rejected"),
        join(home, "spool"),
      ]) {
        expect(statSync(p).mode & 0o777, p).toBe(0o700);
      }
    },
  );
});

describe("log hygiene and env knobs", () => {
  it("does not copy invalid or torn line content into the log", async () => {
    const dir = join(home, "spool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01.jsonl"),
      `SECRET-PASSWORD not json\n${JSON.stringify(line(1))}\n{"v":1,"note":"SECRET-PASSWORD"}\n`,
    );
    writeFileSync(join(dir, "2026-01-02.jsonl"), `{"torn":"SECRET-PASSWORD`);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "2026-01-01.jsonl"), old, old);
    utimesSync(join(dir, "2026-01-02.jsonl"), old, old);
    writeFileSync(join(dir, "2026-01-03.jsonl"), "");
    const msgs: string[] = [];
    const r = new DayFileReader(dir, undefined, (_l, m) => msgs.push(m));
    await r.read(10, 1e6);
    await r.read(10, 1e6);
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs.join("\n")).not.toContain("SECRET-PASSWORD");
    expect(msgs[0]).toMatch(/2026-01-01\.jsonl at 0 length \d+ \(invalid-json\)/);
  });

  it("SESSIONDECK_BACKOFF_CAP_MS is clamped to at least 50 ms", () => {
    expect(parseBackoffCapMs("0")).toBe(50);
    expect(parseBackoffCapMs("10")).toBe(50);
    expect(parseBackoffCapMs("2000")).toBe(2000);
    expect(parseBackoffCapMs(undefined)).toBeUndefined();
    expect(parseBackoffCapMs("abc")).toBeUndefined();
    expect(parseBackoffCapMs("-5")).toBeUndefined();
  });
});
