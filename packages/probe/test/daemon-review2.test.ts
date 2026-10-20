import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@sessiondeck/contract";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.ts";
import { acquireLock } from "../src/daemon/lock.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { spoolDir } from "../src/paths.ts";
import type { SpoolLine } from "../src/spool-format.ts";
import { appendSpoolLines } from "../src/spool-writer.ts";

let home: string;
const open: DaemonHandle[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sd-review2-"));
});
afterEach(async () => {
  for (const d of open.splice(0)) await d.kill();
  rmSync(home, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(10);
  if (!cond()) throw new Error("timed out waiting");
}
function line(n: number, ts = Date.now(), pad = 0): SpoolLine {
  return buildEnvelope({
    kind: "hook",
    host: "h",
    session_id: "s1",
    hook_event_name: "PostToolUse",
    payload: { n, pad: "x".repeat(pad) },
    ts,
  });
}
const nOf = (e: { payload: unknown }): number => (e.payload as { n: number }).n;
interface Req {
  envs: Envelope[];
}
function recordingFetch(answer: (r: Req) => number) {
  const reqs: Req[] = [];
  const f = (async (_u: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { envelopes: Envelope[] };
    const r: Req = { envs: body.envelopes };
    const status = answer(r);
    reqs.push(r);
    return new Response("{}", { status });
  }) as typeof fetch;
  return { f, reqs };
}
const cfg = { hubUrl: "http://127.0.0.1:9", token: "secret-token", host: "h" };
const fast = { pollMs: 5, batchMs: 20, heartbeatMs: 0, rng: () => 0 };
const lockPath = (): string => join(home, "daemon", "daemon.lock");
const logText = (): string => readFileSync(join(home, "daemon", "daemon.log"), "utf8");
const bootNow = Date.now() - 3_600_000;
const deps = { bootMs: () => bootNow };

function writeLock(path: string, text: string, ageMs = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
}
const otherLock = JSON.stringify({ pid: process.ppid, boot: bootNow, token: "other" });

describe("R1.4 lock: no half-written state, tolerant touch, safe removal", () => {
  it("leaves no temp or aside files behind, and the content is complete JSON", () => {
    const l = acquireLock(lockPath(), deps)!;
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock"]);
    l.release();
    expect(readdirSync(join(home, "daemon"))).toEqual([]);
  });

  it("an empty or unparseable lock is live while young and stale once old", () => {
    writeLock(lockPath(), "", 0);
    expect(acquireLock(lockPath(), deps)).toBeUndefined();
    expect(readFileSync(lockPath(), "utf8")).toBe("");
    writeLock(lockPath(), "{not json", 60_000);
    expect(acquireLock(lockPath(), deps)).toBeDefined();
  });

  it("touch survives a read error and recreates a vanished lock with the same token", () => {
    const l = acquireLock(lockPath(), deps)!;
    const token = JSON.parse(readFileSync(lockPath(), "utf8")).token;
    rmSync(lockPath());
    expect(l.touch()).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).token).toBe(token);
    rmSync(lockPath());
    mkdirSync(lockPath()); // reading it fails with EISDIR: a transient, not a takeover
    expect(l.touch()).toBe(true);
    expect(l.verify()).toBe(true);
    rmSync(lockPath(), { recursive: true });
    l.release();
  });

  it("verify and touch are false only for a parsed foreign token", () => {
    const l = acquireLock(lockPath(), deps)!;
    writeLock(lockPath(), otherLock);
    expect(l.verify()).toBe(false);
    expect(l.touch()).toBe(false);
    expect(readFileSync(lockPath(), "utf8")).toBe(otherLock);
  });

  it("a lock replaced by a live one during the takeover is put back, not deleted", () => {
    writeLock(lockPath(), JSON.stringify({ pid: 2147483000, boot: bootNow, token: "x" }));
    const l = acquireLock(lockPath(), {
      ...deps,
      duringTakeover: () => writeLock(lockPath(), otherLock),
    });
    expect(l).toBeUndefined(); // a live daemon holds it
    expect(readFileSync(lockPath(), "utf8")).toBe(otherLock);
    expect(readdirSync(join(home, "daemon"))).toEqual(["daemon.lock"]);
  });

  it("a takeover mutex left by a crash: an old one is cleared at once", () => {
    writeLock(lockPath(), JSON.stringify({ pid: 2147483000, boot: bootNow, token: "x" }));
    writeLock(`${lockPath()}.takeover`, "dead", 60_000);
    expect(acquireLock(lockPath(), deps)).toBeDefined();
    expect(readdirSync(join(home, "daemon")).sort()).toEqual(["daemon.lock"]);
  });

  it("a fresh mutex is waited out (restart within 10 s of a crash), not reported as running", () => {
    writeLock(lockPath(), JSON.stringify({ pid: 2147483000, boot: bootNow, token: "x" }));
    writeLock(`${lockPath()}.takeover`, "dead", 9_300); // goes stale in ~0.7 s
    const t0 = Date.now();
    expect(acquireLock(lockPath(), deps)).toBeDefined();
    expect(Date.now() - t0).toBeGreaterThan(300);
  });

  it("a mutex that never clears ends in a distinct error, not 'already running'", () => {
    writeLock(lockPath(), JSON.stringify({ pid: 2147483000, boot: bootNow, token: "x" }));
    writeLock(`${lockPath()}.takeover`, "dead", 0);
    expect(() => acquireLock(lockPath(), { ...deps, takeoverWaitMs: 200 })).toThrow(
      /takeover in progress/,
    );
  });
});

describe("R1.4 fencing: a daemon that lost the lock stops writing and sending", () => {
  it("the lock timer notices a foreign token: onLockLost fires, the lock is unchanged", async () => {
    let lost = 0;
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      lockTouchMs: 30,
      onLockLost: () => (lost += 1),
    }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && fx.reqs.length >= 1);
    writeLock(lockPath(), otherLock);
    await waitFor(() => lost === 1);
    const reqs = fx.reqs.length;
    const state = readFileSync(join(home, "daemon", "state.json"), "utf8");
    appendSpoolLines(spoolDir(home), [line(1)]);
    await sleep(200);
    expect(fx.reqs.length).toBe(reqs);
    expect(readFileSync(join(home, "daemon", "state.json"), "utf8")).toBe(state);
    expect(readFileSync(lockPath(), "utf8")).toBe(otherLock);
    expect(lost).toBe(1);
  });

  it("the forwarder checks the token before each state write and POST, between touches", async () => {
    let lost = 0;
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      onLockLost: () => (lost += 1),
    }))!; // the 10 s touch never runs in this test
    open.push(d);
    await waitFor(() => d.pending() === 0 && fx.reqs.length >= 1);
    writeLock(lockPath(), otherLock);
    const reqs = fx.reqs.length;
    const state = readFileSync(join(home, "daemon", "state.json"), "utf8");
    appendSpoolLines(spoolDir(home), [line(1)]);
    await waitFor(() => lost === 1);
    await sleep(150);
    expect(fx.reqs.length).toBe(reqs);
    expect(readFileSync(join(home, "daemon", "state.json"), "utf8")).toBe(state);
    expect(readFileSync(lockPath(), "utf8")).toBe(otherLock);
    expect(logText()).toContain("fenced");
  });
});

describe("R1.4 seq stays contiguous around envelopes the hub rejects", () => {
  it("a stand-in probe envelope takes the seq of a rejected envelope", async () => {
    appendSpoolLines(spoolDir(home), [line(0, 1000), line(1, 1001, 5000), line(2, 1002)]);
    const fx = recordingFetch((r) =>
      r.envs.some((e) => e.kind === "hook" && nOf(e) === 1) ? 413 : 200,
    );
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 200 }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && d.nextSeq() >= 4);
    const got = new Map<number, Envelope>();
    for (const r of fx.reqs) {
      if (r.envs.some((e) => e.kind === "hook" && nOf(e) === 1)) continue;
      for (const e of r.envs) got.set(e.seq, e);
    }
    const seqs = [...got.keys()].sort((a, b) => a - b);
    expect(seqs).toEqual([...seqs.keys()]);
    const stand = [...got.values()].filter(
      (e) => (e.payload as { type?: string }).type === "rejected",
    );
    expect(stand).toHaveLength(1);
    expect(stand[0]).toMatchObject({ kind: "probe", session_id: null });
    const rejFile = readdirSync(join(home, "daemon", "rejected"))[0]!;
    const orig = JSON.parse(
      readFileSync(join(home, "daemon", "rejected", rejFile), "utf8").trim(),
    ) as Envelope;
    expect((stand[0]!.payload as { original_id: string }).original_id).toBe(orig.id);
    expect(stand[0]!.seq).toBe(orig.seq);
  });

  it("a 413-split half that is then rejected keeps seq contiguous", async () => {
    appendSpoolLines(
      spoolDir(home),
      Array.from({ length: 8 }, (_, i) => line(i, 1000 + i)),
    );
    const fx = recordingFetch((r) => {
      if (r.envs.length > 3) return 413;
      return r.envs.some((e) => e.kind === "hook" && nOf(e) === 5) ? 400 : 200;
    });
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 200 }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && d.nextSeq() >= 9);
    const got = new Map<number, Envelope>();
    for (const r of fx.reqs) {
      if (r.envs.some((e) => e.kind === "hook" && nOf(e) === 5)) continue;
      for (const e of r.envs) got.set(e.seq, e);
    }
    const seqs = [...got.keys()].sort((a, b) => a - b);
    expect(seqs).toEqual([...seqs.keys()]);
    expect(seqs).toHaveLength(9);
  });

  it("the stand-in id is stable across a resend and a valid ULID", async () => {
    appendSpoolLines(spoolDir(home), [line(0, 1000), line(1, 1001)]);
    const fx = recordingFetch((r) =>
      r.envs.some((e) => e.kind === "hook" && nOf(e) === 1) ? 413 : 200,
    );
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 200 }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && d.nextSeq() >= 3);
    const ids = fx.reqs
      .flatMap((r) => r.envs)
      .filter((e) => (e.payload as { type?: string }).type === "rejected")
      .map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });
});

describe("log hygiene: no received values in parse errors", () => {
  it("an enum value that looks like a secret is not written to daemon.log", async () => {
    const bad = { ...line(0), kind: "sk-ant-SECRET-VALUE" };
    mkdirSync(spoolDir(home), { recursive: true });
    writeFileSync(
      join(spoolDir(home), "2026-10-20.jsonl"),
      `${JSON.stringify(bad)}\n${JSON.stringify(line(1))}\n`,
    );
    const fx = recordingFetch(() => 200);
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && fx.reqs.length >= 1);
    const log = logText();
    expect(log).toContain("skipped invalid line");
    expect(log).toContain("schema:kind");
    expect(log).not.toContain("SECRET");
    expect(existsSync(join(home, "daemon", "daemon.log"))).toBe(true);
    expect(statSync(join(home, "daemon", "daemon.log")).size).toBeGreaterThan(0);
  });
});
