import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import { LivenessPayloadSchema } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execCalls = vi.hoisted(
  () => [] as { file: string; args: string[]; opts: Record<string, unknown> }[],
);
vi.mock("node:child_process", async (orig) => {
  const a = await orig<typeof import("node:child_process")>();
  return {
    ...a,
    execFile: (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
      cb: (e: Error | null, out: string) => void,
    ): void => {
      execCalls.push({ file, args, opts });
      cb(null, "4321|pwsh.exe|638000000000000000\r\n");
    },
  };
});

import { buildEnvelope } from "../src/envelope.ts";
import {
  LivenessMonitor,
  type LivenessOptions,
  type LivenessStore,
} from "../src/daemon/liveness.ts";
import {
  findParentPID,
  isShellProcess,
  linuxProcLookup,
  parseProcStat,
  parsePs,
  parseWinLine,
  pidAlive,
  windowsLookup,
  type ProcInfo,
  type ProcLookup,
} from "../src/daemon/proc-info.ts";
import { SessionsReader, parseSessionFile } from "../src/daemon/sessions-file.ts";
import type { SpoolLine } from "../src/spool-format.ts";

const SID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SID_B = "bbbbbbbb-0000-0000-0000-000000000002";

function memStore(): LivenessStore & { text?: string } {
  const s: LivenessStore & { text?: string } = {
    load: () => Promise.resolve(s.text),
    save: (t) => {
      s.text = t;
      return Promise.resolve();
    },
  };
  return s;
}

/** A fake process table: pid -> info; alive set controls process.kill(pid, 0). */
function fakeProcs(table: Record<number, Omit<ProcInfo, "pid">>, starts?: Record<number, string>) {
  const alive = new Set<number>(Object.keys(table).map(Number));
  const procs: ProcLookup = {
    lookup: (pid) => {
      const t = table[pid];
      return Promise.resolve(t && alive.has(pid) ? { pid, ...t } : undefined);
    },
    cheapStart: (pid) => starts?.[pid],
  };
  return { alive, procs, isAlive: (pid: number): boolean => alive.has(pid), starts };
}

function liveEnv(sid: string, pid: number, ts: number): Envelope {
  return {
    ...buildEnvelope({
      kind: "liveness",
      host: "h",
      payload: { pid, alive: true },
      session_id: sid,
      ts,
    }),
    seq: 0,
  };
}
function hookEnv(sid: string, name: string, ts: number): Envelope {
  return {
    ...buildEnvelope({
      kind: "hook",
      host: "h",
      payload: { session_id: sid },
      session_id: sid,
      hook_event_name: name,
      ts,
    }),
    seq: 0,
  };
}

let out: SpoolLine[];
let logs: string[];
let tmp: string;
const mk = (o: LivenessOptions): LivenessMonitor =>
  new LivenessMonitor({
    enqueue: (l) => void out.push(l),
    host: "h",
    log: (lv, m) => void logs.push(`${lv} ${m}`),
    sessionsDir: join(tmp, "sessions"),
    ...o,
  });
const deaths = (): SpoolLine[] =>
  out.filter((l) => l.kind === "liveness" && (l.payload as { alive: boolean }).alive === false);
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  out = [];
  logs = [];
  tmp = mkdtempSync(join(tmpdir(), "sd-liveness-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("R1.7 death detection", () => {
  it("emits one alive:false within 15 s of the pid dying, valid per the contract schema", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, Date.now()));
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deaths()).toHaveLength(0);
    const diedAt = Date.now();
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(15_000);
    const d = deaths();
    expect(d).toHaveLength(1);
    expect(d[0]?.session_id).toBe(SID_A);
    expect(LivenessPayloadSchema.parse(d[0]?.payload)).toEqual({ pid: 100, alive: false });
    expect(d[0]!.ts - diedAt).toBeLessThanOrEqual(15_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deaths()).toHaveLength(1);
    await m.stop();
  });

  it("treats EPERM as alive and ESRCH as dead", () => {
    const spy = vi.spyOn(process, "kill");
    spy.mockImplementation(() => {
      throw Object.assign(new Error("x"), { code: "EPERM" });
    });
    expect(pidAlive(4242)).toBe(true);
    spy.mockImplementation(() => {
      throw Object.assign(new Error("x"), { code: "ESRCH" });
    });
    expect(pidAlive(4242)).toBe(false);
    spy.mockImplementation(() => true);
    expect(pidAlive(4242)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
  });

  it("does not repeat a death after a restart, and finds one that happened while down", async () => {
    const store = memStore();
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" }, 200: { ppid: 1, name: "claude" } });
    const m1 = mk({ store, procs: p.procs, isAlive: p.isAlive });
    await m1.start();
    m1.onSpoolLine(liveEnv(SID_A, 100, 1000));
    m1.onSpoolLine(liveEnv(SID_B, 200, 1001));
    await flush();
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(deaths()).toHaveLength(1);
    await m1.stop();
    // restart: A already reported, B dies while the daemon is down
    p.alive.delete(200);
    const m2 = mk({ store, procs: p.procs, isAlive: p.isAlive });
    await m2.start();
    await vi.advanceTimersByTimeAsync(12_000);
    const d = deaths();
    expect(d.map((x) => x.session_id)).toEqual([SID_A, SID_B]);
    // replay of the registering line after restart does not resurrect or repeat
    m2.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deaths()).toHaveLength(2);
    await m2.stop();
  });

  it("a SessionEnd suppresses the envelope, even one that lands inside the grace window", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" }, 200: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    m.onSpoolLine(liveEnv(SID_B, 200, 1000));
    await flush();
    m.onSpoolLine(hookEnv(SID_A, "SessionEnd", 2000));
    await flush();
    p.alive.delete(100);
    p.alive.delete(200);
    await vi.advanceTimersByTimeAsync(10_000); // tick sees B dead, grace pending
    m.onSpoolLine(hookEnv(SID_B, "SessionEnd", 3000));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deaths()).toHaveLength(0);
    await m.stop();
  });

  it("a blip (pid back alive before the grace look) is not a death", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    let calls = 0;
    const isAlive = (pid: number): boolean => {
      calls += 1;
      return calls === 3 ? false : p.alive.has(pid);
    };
    const m = mk({ store: memStore(), procs: p.procs, isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(deaths()).toHaveLength(0);
    await m.stop();
  });
});

describe("same pid, new session (cleanupSamePID)", () => {
  it("retires the old session without an envelope; only the new one reports the death", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    m.onSpoolLine(liveEnv(SID_B, 100, 2000)); // /clear: same pid, new session_id
    await flush();
    expect(out).toHaveLength(0);
    expect(m.snapshot().find((e) => e.session_id === SID_A)?.state).toBe("superseded");
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.session_id)).toEqual([SID_B]);
    await m.stop();
  });
});

describe("shell pid walk (findParentPID)", () => {
  const table = {
    50: { ppid: 40, name: "bash" },
    40: { ppid: 30, name: "sh" },
    30: { ppid: 1, name: "claude" },
  };
  it("watches the first non-shell ancestor and corrects the hub's pid first", async () => {
    const p = fakeProcs(table);
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 50, 1000));
    await flush();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "liveness",
      session_id: SID_A,
      payload: { pid: 30, alive: true },
    });
    // the shells exit right after the hook returns: not a death
    p.alive.delete(50);
    p.alive.delete(40);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deaths()).toHaveLength(0);
    p.alive.delete(30);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 30, alive: false }]);
    await m.stop();
  });

  it("never reports death for a shell pid it could not map to claude", async () => {
    const p = fakeProcs({ 50: { ppid: 40, name: "bash.exe" }, 40: { ppid: 1, name: "cmd.exe" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 50, 1000));
    await flush();
    expect(m.snapshot()[0]?.state).toBe("unconfirmed");
    p.alive.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(out).toHaveLength(0);
    await m.stop();
  });

  it("does not track a pid that was already dead when registered", async () => {
    const p = fakeProcs({});
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 999, 1000));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(out).toHaveLength(0);
    await m.stop();
  });

  it("findParentPID: limit, cycle, dead ancestor, and non-shell start", async () => {
    const t = fakeProcs({ ...table, 7: { ppid: 7, name: "bash" }, 8: { ppid: 30, name: "bash" } });
    expect(await findParentPID(30, t.procs, t.isAlive)).toBe(30);
    expect(await findParentPID(50, t.procs, t.isAlive)).toBe(30);
    expect(await findParentPID(7, t.procs, t.isAlive)).toBe(0);
    t.alive.delete(30);
    expect(await findParentPID(8, t.procs, t.isAlive)).toBe(0);
    const chain: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 100; i < 140; i += 1) chain[i] = { ppid: i + 1, name: "bash" };
    const c = fakeProcs(chain);
    expect(await findParentPID(100, c.procs, c.isAlive)).toBe(0);
  });

  it("isShellProcess recognises Windows and POSIX shells and not claude or node", () => {
    for (const n of [
      "bash",
      "Bash.EXE",
      "sh",
      "zsh",
      "cmd.exe",
      "pwsh.exe",
      "powershell.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ])
      expect(isShellProcess(n), n).toBe(true);
    for (const n of ["claude", "claude.exe", "node", "node.exe", "bashful", ""])
      expect(isShellProcess(n), n).toBe(false);
  });
});

describe("sessions-file second opinion", () => {
  const sdir = (): string => join(tmp, "sessions");
  const put = (name: string, body: unknown): void => {
    mkdirSync(sdir(), { recursive: true });
    writeFileSync(join(sdir(), name), typeof body === "string" ? body : JSON.stringify(body));
  };

  it("prefers the sessionId-to-pid mapping over the reported pid", async () => {
    const p = fakeProcs({ 50: { ppid: 30, name: "node" }, 777: { ppid: 1, name: "claude" } });
    put("777.json", {
      pid: 777,
      sessionId: SID_A,
      cwd: "/x",
      startedAt: 1,
      procStart: "999",
      status: "idle",
      updatedAt: 5,
      extra: { a: 1 },
    });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 50, 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ pid: 777, source: "sessions", file_start: "999" });
    expect(out[0]?.payload).toEqual({ pid: 777, alive: true });
    p.alive.delete(777);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 777, alive: false }]);
    await m.stop();
  });

  it("malformed and unknown-shape files are ignored, logged once, and the first opinion is used", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    put("1.json", "{not json");
    put("2.json", { hello: "world" });
    put("3.json", [1, 2]);
    put("4.json", { pid: "four", sessionId: 5 });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    m.onSpoolLine(liveEnv(SID_B, 100, 1001));
    await flush();
    expect(m.snapshot().find((e) => e.session_id === SID_B)).toMatchObject({
      pid: 100,
      source: "process",
    });
    expect(logs.filter((l) => l.includes("unknown shape"))).toHaveLength(1);
    await m.stop();
  });

  it("an unconfirmed session is promoted when its file appears", async () => {
    const p = fakeProcs({ 50: { ppid: 1, name: "bash" }, 600: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 50, 1000));
    await flush();
    expect(m.snapshot()[0]?.state).toBe("unconfirmed");
    put("600.json", { pid: 600, sessionId: SID_A });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.snapshot()[0]).toMatchObject({ state: "tracking", pid: 600 });
    expect(out[0]?.payload).toEqual({ pid: 600, alive: true });
    await m.stop();
  });

  it("discovers a session the daemon never saw start, from the file alone", async () => {
    const p = fakeProcs({ 600: { ppid: 1, name: "claude" } });
    put("600.json", { pid: 600, sessionId: SID_A });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(hookEnv(SID_A, "PostToolUse", 1000));
    await flush();
    p.alive.delete(600);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths()).toHaveLength(1);
    await m.stop();
  });

  it("parseSessionFile and CLAUDE_CONFIG_DIR location", () => {
    expect(parseSessionFile('{"pid":5,"sessionId":"s","procStart":123}', "5.json")).toEqual({
      pid: 5,
      sessionId: "s",
      procStart: "123",
    });
    expect(parseSessionFile('{"sessionId":"s"}', "7.json")).toEqual({ pid: 7, sessionId: "s" });
    expect(parseSessionFile('{"pid":5,"sessionId":"s"}', "6.json")).toBeUndefined();
    put("9.json", { pid: 9, sessionId: SID_A });
    expect(new SessionsReader(sdir(), () => undefined).readPid(9)?.sessionId).toBe(SID_A);
    expect(new SessionsReader(join(tmp, "nope"), () => undefined).readAll()).toEqual([]);
  });
});

describe("pid reuse guard", () => {
  it("a changed OS start token for the pid is a death (Linux /proc starttime)", async () => {
    const starts: Record<number, string> = { 100: "5000" };
    const p = fakeProcs({ 100: { ppid: 1, name: "claude", start: "5000" } }, starts);
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    expect(m.snapshot()[0]?.proc_start).toBe("5000");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deaths()).toHaveLength(0);
    starts[100] = "9999"; // pid 100 is alive, but it is a different process now
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths()).toHaveLength(1);
    await m.stop();
  });

  it("a procStart change in the sessions file counts only when it repeats (Windows path)", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    const dir = join(tmp, "sessions");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "100.json");
    writeFileSync(f, JSON.stringify({ pid: 100, sessionId: SID_A, procStart: "1" }));
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    writeFileSync(f, JSON.stringify({ pid: 100, sessionId: SID_B, procStart: "2" }));
    await vi.advanceTimersByTimeAsync(10_000); // first mismatch
    expect(deaths()).toHaveLength(0);
    writeFileSync(f, JSON.stringify({ pid: 100, sessionId: SID_A, procStart: "1" })); // was a blip
    await vi.advanceTimersByTimeAsync(10_000);
    writeFileSync(f, JSON.stringify({ pid: 100, sessionId: SID_B, procStart: "2" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deaths()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(12_000); // second in a row, then the grace look
    expect(deaths()).toHaveLength(1);
    await m.stop();
  });
});

describe("process table parsing and lookups", () => {
  it("parseProcStat handles spaces and parentheses in comm", () => {
    const stat =
      "123 (my (weird) cmd) S 45 123 123 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 8888 1 2 3";
    expect(parseProcStat(stat)).toEqual({ ppid: 45, name: "my (weird) cmd", start: "8888" });
    expect(parseProcStat("garbage")).toBeUndefined();
  });
  it("parsePs and parseWinLine", () => {
    expect(parsePs("  45 Mon Oct 20 12:00:00 2026 /usr/bin/bash\n", 9)).toEqual({
      pid: 9,
      ppid: 45,
      start: "Mon Oct 20 12:00:00 2026",
      name: "bash",
    });
    expect(parsePs("", 9)).toBeUndefined();
    expect(parseWinLine("612|bash.exe|638000000000000000\r\n", 9)).toEqual({
      pid: 9,
      ppid: 612,
      name: "bash",
      start: "638000000000000000",
    });
    expect(parseWinLine("", 9)).toBeUndefined();
  });
  it("the Windows lookup spawns one hidden, time-limited PowerShell and parses its line", async () => {
    execCalls.length = 0;
    const info = await windowsLookup(1234).lookup(4321);
    expect(info).toMatchObject({ pid: 4321, ppid: 4321, name: "pwsh" });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.opts).toMatchObject({ windowsHide: true, timeout: 1234 });
    expect(execCalls[0]?.file).not.toContain("\\");
    expect(execCalls[0]?.args.join(" ")).toContain("ProcessId=4321");
    expect(await windowsLookup().lookup(-1)).toBeUndefined();
  });
  it.skipIf(process.platform !== "linux")("linux /proc lookup sees this process", async () => {
    const l = linuxProcLookup();
    const me = await l.lookup(process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.name).toMatch(/node|vitest|^\w+/);
    expect(l.cheapStart?.(process.pid)).toBe(me?.start);
    expect(await l.lookup(2 ** 22 + 12345)).toBeUndefined();
  });
});
