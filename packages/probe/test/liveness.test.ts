import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import { LivenessPayloadSchema } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execCalls = vi.hoisted(
  () => [] as { file: string; args: string[]; opts: Record<string, unknown> }[],
);
const execFail = vi.hoisted(() => ({ err: undefined as { code: string } | undefined }));
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
      if (execFail.err) {
        cb(Object.assign(new Error("boom"), execFail.err), "");
        return;
      }
      const script = args[args.length - 1] ?? "";
      cb(
        null,
        script.includes("ForEach-Object")
          ? "50|40|bash.exe|638000000000000000\r\n40|30|sh.exe|638000000000000000\r\n30|1|claude.exe|638000000000000001\r\n"
          : "4321|pwsh.exe|638000000000000000\r\n",
      );
    },
  };
});

import { buildEnvelope } from "../src/envelope.ts";
import {
  LivenessMonitor,
  LOOKUP_BURST,
  MAX_ENTRIES,
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
  PS_PATH,
  pidAlive,
  psLookup,
  resolvePowerShell,
  ticksToMs,
  windowsLookup,
  type ProcInfo,
  type ProcLookup,
} from "../src/daemon/proc-info.ts";
import {
  MAX_FILE_BYTES,
  sameIdentity,
  SessionsReader,
  parseSessionFile,
  readRegularFileCapped,
} from "../src/daemon/sessions-file.ts";
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
    bootTime: () => 1_000_000,
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

  it("a sessions file naming this session on the process-path pid confirms it", async () => {
    const p = fakeProcs({ 50: { ppid: 777, name: "bash" }, 777: { ppid: 1, name: "claude" } });
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
      startMs: Date.parse("Mon Oct 20 12:00:00 2026"),
      name: "bash",
    });
    expect(parsePs("", 9)).toBeUndefined();
    expect(parseWinLine("612|bash.exe|638000000000000000\r\n", 9)).toEqual({
      pid: 9,
      ppid: 612,
      name: "bash",
      start: "638000000000000000",
      startMs: ticksToMs("638000000000000000"),
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

describe("U3-fix: which pid is trusted (findings A, C)", () => {
  const sdir = (): string => join(tmp, "sessions");
  const put = (name: string, body: unknown): void => {
    mkdirSync(sdir(), { recursive: true });
    writeFileSync(join(sdir(), name), JSON.stringify(body));
  };

  it("A: a stale sessions file of a crashed run is not tracked; the live resumed process is", async () => {
    const p = fakeProcs({ 200: { ppid: 1, name: "claude" } });
    put("100.json", { pid: 100, sessionId: SID_A, procStart: "1" }); // crashed run, pid 100 dead
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 200, 1000)); // --resume: same id, new process, no 200.json yet
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ pid: 200, source: "process", state: "tracking" });
    expect(out).toHaveLength(0); // no alive:true for the dead pid 100
    await vi.advanceTimersByTimeAsync(40_000);
    expect(deaths()).toHaveLength(0);
    await m.stop();
  });

  it("A: a sessions file whose pid was reused by an unrelated process is not tracked", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "explorer" }, 200: { ppid: 1, name: "claude" } });
    put("100.json", { pid: 100, sessionId: SID_A });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 200, 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ pid: 200 });
    // and discovery of a file-only pid refuses a shell or an unreadable process
    put("300.json", { pid: 300, sessionId: SID_B });
    p.alive.add(300);
    m.onSpoolLine(hookEnv(SID_B, "PostToolUse", 2000));
    await flush();
    expect(m.snapshot().find((e) => e.session_id === SID_B)).toBeUndefined();
    await m.stop();
  });

  it("C: a process younger than the hook line is not the hook's ancestor", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude", startMs: 10_000 } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 5000)); // pid 100 started 5 s after the line: a reused pid
    await flush();
    expect(m.snapshot()[0]?.state).toBe("unconfirmed");
    p.alive.clear();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(out).toHaveLength(0);
    await m.stop();
  });

  it("C: a node shim that exits right away is dropped on probation with no alive:false", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "node" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ state: "tracking", probation: true });
    p.alive.delete(100); // the shim exits when the hook returns
    await vi.advanceTimersByTimeAsync(40_000);
    expect(out).toHaveLength(0);
    expect(m.snapshot()[0]?.state).toBe("unconfirmed");
    await m.stop();
  });

  it("C: a node-named pid that is alive on the first tick is tracked and then reported", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "node" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.snapshot()[0]).not.toHaveProperty("probation");
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 100, alive: false }]);
    await m.stop();
  });
});

describe("U3-fix: pid reuse without a cheap start (finding B)", () => {
  it("a boot-time shift forces a start re-check: a live pid with an unchanged start stays alive", async () => {
    const store = memStore();
    const table: Record<number, Omit<ProcInfo, "pid">> = {
      100: { ppid: 1, name: "claude", start: "AAA" },
    };
    const p = fakeProcs(table);
    const procs: ProcLookup = { lookup: p.procs.lookup, spawns: true }; // no cheapStart
    const m1 = mk({ store, procs, isAlive: p.isAlive, bootTime: () => 1_000_000 });
    await m1.start();
    m1.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    await m1.stop();
    // a wall-clock step of 2 min while the daemon restarts: not a reboot, the pid is still claude
    const m2 = mk({ store, procs, isAlive: p.isAlive, bootTime: () => 1_120_000 });
    await m2.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(deaths()).toHaveLength(0);
    expect(m2.snapshot()[0]).toMatchObject({ state: "tracking", pid: 100 });
    expect(m2.snapshot()[0]).not.toHaveProperty("recheck"); // done: the OS answered
    await m2.stop();
  });

  it("a boot-time shift plus a changed start (a reused pid) is a death", async () => {
    const store = memStore();
    const table: Record<number, Omit<ProcInfo, "pid">> = {
      100: { ppid: 1, name: "claude", start: "AAA" },
    };
    const p = fakeProcs(table);
    const procs: ProcLookup = { lookup: p.procs.lookup, spawns: true };
    const m1 = mk({ store, procs, isAlive: p.isAlive, bootTime: () => 1_000_000 });
    await m1.start();
    m1.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    await m1.stop();
    table[100] = { ppid: 1, name: "svchost", start: "BBB" }; // rebooted: the pid is somebody else's
    const m2 = mk({ store, procs, isAlive: p.isAlive, bootTime: () => 9_000_000 });
    await m2.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 100, alive: false }]);
    await m2.stop();
  });

  it("with a cheap start (Linux) a boot-time shift is ignored: starttime already decides", async () => {
    const store = memStore();
    const p = fakeProcs({ 100: { ppid: 1, name: "claude", start: "5000" } }, { 100: "5000" });
    const m1 = mk({ store, procs: p.procs, isAlive: p.isAlive, bootTime: () => 1_000_000 });
    await m1.start();
    m1.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    await m1.stop();
    const m2 = mk({ store, procs: p.procs, isAlive: p.isAlive, bootTime: () => 9_000_000 });
    await m2.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deaths()).toHaveLength(0);
    await m2.stop();
  });

  it("Windows/macOS: a live pid whose start changed is a death, found by a rate-limited lookup", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {
      100: { ppid: 1, name: "claude", start: "AAA" },
    };
    const p = fakeProcs(table);
    const procs: ProcLookup = { lookup: p.procs.lookup, spawns: true }; // no cheapStart
    const m = mk({ store: memStore(), procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    expect(m.snapshot()[0]?.proc_start).toBe("AAA");
    const before = m.stats.lookups;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(deaths()).toHaveLength(0);
    expect(m.stats.lookups - before).toBeLessThanOrEqual(2); // not one per tick
    table[100] = { ppid: 1, name: "svchost", start: "BBB" }; // pid handed to another process
    await vi.advanceTimersByTimeAsync(80_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 100, alive: false }]);
    await m.stop();
  });
});

describe("U3-fix: limits on spool input (findings F, K)", () => {
  it("F: a flood of registrations is capped, rate-limited, and persisted in few writes", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i < 1000; i += 1) table[10_000 + i] = { ppid: 1, name: "claude" };
    const p = fakeProcs(table);
    let lookups = 0;
    const procs: ProcLookup = {
      ...p.procs,
      spawns: true,
      lookup: (pid) => {
        lookups += 1;
        return p.procs.lookup(pid);
      },
    };
    let saves = 0;
    const store = memStore();
    const save = store.save;
    store.save = (t) => {
      saves += 1;
      return save(t);
    };
    const m = mk({ store, procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < 1000; i += 1) {
      m.onSpoolLine(liveEnv(`sess-${i}`, 10_000 + i, 1000 + i));
    }
    await flush();
    expect(m.snapshot().length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(m.stats.regDropped).toBeGreaterThan(0); // counted, parked, replayed as the queue drains
    expect(lookups).toBeLessThanOrEqual(LOOKUP_BURST + 2);
    expect(saves).toBeLessThanOrEqual(8);
    expect(logs.filter((l) => l.includes("rate-limited"))).toHaveLength(1);
    expect(logs.filter((l) => l.includes("queue is full"))).toHaveLength(1);
    await m.stop();
  });

  it("F: a lookup the bucket dropped is retried on a later tick, not treated as dead", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i < 30; i += 1) table[500 + i] = { ppid: 1, name: "claude" };
    const p = fakeProcs(table);
    const procs: ProcLookup = { ...p.procs, spawns: true };
    const m = mk({ store: memStore(), procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < 30; i += 1) await m.registerSession(`s-${i}`, 500 + i, 1000 + i);
    const tracked = (): number => m.snapshot().filter((e) => e.state === "tracking").length;
    expect(tracked()).toBeLessThan(30);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tracked()).toBe(30);
    expect(out.filter((l) => (l.payload as { alive: boolean }).alive === false)).toHaveLength(0);
    await m.stop();
  });

  it("F: the registry is capped; the oldest entry that is not tracking goes first", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i <= MAX_ENTRIES; i += 1) table[2000 + i] = { ppid: 1, name: "claude" };
    const p = fakeProcs(table);
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < MAX_ENTRIES; i += 1) await m.registerSession(`s-${i}`, 2000 + i, 1000 + i);
    expect(m.snapshot()).toHaveLength(MAX_ENTRIES);
    await m.endSession("s-3", 6000);
    await m.registerSession("overflow", 2000 + MAX_ENTRIES, 7000);
    expect(m.snapshot()).toHaveLength(MAX_ENTRIES);
    expect(m.snapshot().find((e) => e.session_id === "s-3")).toBeUndefined();
    expect(m.snapshot().find((e) => e.session_id === "overflow")?.state).toBe("tracking");
    expect(m.stats.evictedTracking).toBe(0);
    await m.stop();
  });

  it("F: repeat registrations of an unconfirmed session are coalesced into one lookup", async () => {
    let lookups = 0;
    const procs: ProcLookup = {
      lookup: () => {
        lookups += 1;
        return Promise.resolve(undefined);
      },
    };
    const m = mk({ store: memStore(), procs, isAlive: () => true });
    await m.start();
    for (let i = 0; i < 20; i += 1) await m.registerSession(SID_A, 77, 1000 + i);
    expect(lookups).toBe(1);
    await m.stop();
  });

  it("F: the Windows walk is one PowerShell however deep the chain", async () => {
    execCalls.length = 0;
    const w = windowsLookup();
    const chain = await w.ancestry!(50);
    expect(chain.map((c) => c.pid)).toEqual([50, 40, 30]);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.opts).toMatchObject({ windowsHide: true });
    expect(await findParentPID(50, w, () => true)).toBe(30);
    expect(execCalls).toHaveLength(1); // the burst shares one snapshot (see finding 11)
  });

  it("K: an invalid or oversize session id is ignored and never reaches the log raw", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    const evil = "x\n[error] forged line";
    m.onSpoolLine(liveEnv(evil, 100, 1000));
    m.onSpoolLine(liveEnv("a".repeat(5000), 100, 1000));
    await m.registerSession(evil, 100, 2000);
    await flush();
    expect(m.snapshot()).toHaveLength(0);
    expect(logs.some((l) => l.includes("forged line\n") || l.includes("\n[error]"))).toBe(false);
    expect(logs.every((l) => l.length < 300)).toBe(true);
    // ids as they appear in the fixtures and the contract still work
    m.onSpoolLine(liveEnv("fef17e22-168c-4fef-8964-9af573b7f2e9", 100, 3000));
    await flush();
    expect(m.snapshot()).toHaveLength(1);
    await m.stop();
  });
});

describe("U3-fix: lifecycle and discovery (findings G, H)", () => {
  it("G: stop clears the dying set, and start twice leaves one interval", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(10_100); // tick sees the death, grace timer pending
    await m.stop(); // grace timer cancelled
    expect(deaths()).toHaveLength(0);
    await m.start(); // a stale `dying` entry would suppress this
    const spy = vi.spyOn(m, "tick");
    await m.start(); // second start: the first interval must be gone
    spy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deaths()).toHaveLength(1);
    await m.stop();
  });

  it("H: a session whose file was not there for the first hook is found on a later hook", async () => {
    const p = fakeProcs({ 600: { ppid: 1, name: "claude" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(hookEnv(SID_A, "UserPromptSubmit", 1000)); // claude has not written 600.json yet
    await flush();
    expect(m.snapshot()).toHaveLength(0);
    mkdirSync(join(tmp, "sessions"), { recursive: true });
    writeFileSync(
      join(tmp, "sessions", "600.json"),
      JSON.stringify({ pid: 600, sessionId: SID_A }),
    );
    m.onSpoolLine(hookEnv(SID_A, "PreToolUse", 1500)); // too soon: backed off
    await flush();
    expect(m.snapshot()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_500);
    m.onSpoolLine(hookEnv(SID_A, "PostToolUse", 12_000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ pid: 600, state: "tracking" });
    await m.stop();
  });
});

describe("U3-fix: sessions dir reads and process paths (findings I, J)", () => {
  const sdir = (): string => join(tmp, "sessions");

  it.skipIf(process.platform === "win32")(
    "I: a FIFO, a symlink to /dev/zero, and an oversize file are skipped without blocking",
    () => {
      mkdirSync(sdir(), { recursive: true });
      execFileSync("mkfifo", [join(sdir(), "1.json")]);
      symlinkSync("/dev/zero", join(sdir(), "2.json"));
      writeFileSync(join(sdir(), "5.json"), JSON.stringify({ pid: 5, sessionId: "ok" }));
      writeFileSync(join(sdir(), "6.json"), " ".repeat(MAX_FILE_BYTES + 1));
      writeFileSync(join(sdir(), "7.json"), JSON.stringify({ pid: 7, sessionId: "real" }));
      symlinkSync(join(sdir(), "7.json"), join(sdir(), "8.json")); // a link to a good file: still skipped
      const r = new SessionsReader(sdir(), () => undefined);
      expect(
        r
          .readAll()
          .map((e) => e.pid)
          .sort(),
      ).toEqual([5, 7]);
      expect(r.readPid(1)).toBeUndefined();
      expect(r.readPid(2)).toBeUndefined();
      expect(r.readPid(8)).toBeUndefined();
      expect(readRegularFileCapped(join(sdir(), "6.json"))).toBeUndefined();
      expect(readRegularFileCapped(join(sdir(), "5.json"))).toContain("ok");
    },
  );

  it("J: PowerShell is the pinned C:/Windows path; the env var only when its file exists", () => {
    const pinned = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const evil = "D:/evil/System32/WindowsPowerShell/v1.0/powershell.exe";
    expect(resolvePowerShell({ SystemRoot: "D:\\evil" }, (f) => f === pinned || f === evil)).toBe(
      pinned,
    );
    expect(resolvePowerShell({ SystemRoot: "D:\\evil" }, (f) => f === evil)).toBe(evil);
    expect(resolvePowerShell({ SystemRoot: "D:\\evil" }, () => false)).toBe(pinned);
    expect(resolvePowerShell({}, () => false)).toBe(pinned);
  });

  it("J: ps is the absolute /bin/ps, not looked up through PATH", async () => {
    execCalls.length = 0;
    await psLookup().lookup(4321);
    expect(PS_PATH).toBe("/bin/ps");
    expect(execCalls[0]?.file).toBe("/bin/ps");
  });
});

/** A process table without cheapStart (Windows/macOS shape) that counts its lookups. */
function spawnProcs(table: Record<number, Omit<ProcInfo, "pid">>) {
  const alive = new Set<number>(Object.keys(table).map(Number));
  const n = { lookup: 0, many: 0 };
  const lookup = (pid: number): Promise<ProcInfo | undefined> => {
    n.lookup += 1;
    const t = table[pid];
    return Promise.resolve(t && alive.has(pid) ? { pid, ...t } : undefined);
  };
  const procs: ProcLookup = {
    spawns: true,
    lookup,
    lookupMany: (pids) => {
      n.many += 1;
      const m = new Map<number, ProcInfo>();
      for (const pid of pids) {
        const t = table[pid];
        if (t && alive.has(pid)) m.set(pid, { pid, ...t });
      }
      return Promise.resolve(m);
    },
  };
  return { alive, procs, isAlive: (pid: number): boolean => alive.has(pid), n, table };
}

describe("U3-fix iteration 3: start re-check, probation, retry (findings 1, 3, 4, 5)", () => {
  const sdir = (): string => join(tmp, "sessions");
  const put = (name: string, body: unknown): void => {
    mkdirSync(sdir(), { recursive: true });
    writeFileSync(join(sdir(), name), JSON.stringify(body));
  };

  it("1: a sessions file that still matches does not stop the start re-check (reused pid, file left behind)", async () => {
    const p = spawnProcs({ 100: { ppid: 1, name: "claude", start: "AAA" } });
    put("100.json", { pid: 100, sessionId: SID_A, procStart: "1" });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({
      source: "sessions",
      file_start: "1",
      proc_start: "AAA",
    });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(deaths()).toHaveLength(0);
    // claude crashed, its file stays, and the pid went to another process within a tick
    p.table[100] = { ppid: 1, name: "svchost", start: "BBB" };
    await vi.advanceTimersByTimeAsync(80_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 100, alive: false }]);
    await m.stop();
  });

  it("3: a probation death is reported when the start was verified", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "node", startMs: 500 } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ probation: true, start_ok: true });
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 100, alive: false }]);
    await m.stop();
  });

  it("3: a probation death is reported when an alive:true correction already went out", async () => {
    const p = fakeProcs({ 50: { ppid: 30, name: "bash" }, 30: { ppid: 1, name: "node" } });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 50, 1000));
    await flush();
    expect(out.map((l) => l.payload)).toEqual([{ pid: 30, alive: true }]);
    p.alive.clear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.payload)).toEqual([{ pid: 30, alive: false }]);
    await m.stop();
  });

  it("4: a retry flag is cleared when the next resolve fails for a real reason", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i < LOOKUP_BURST; i += 1) table[300 + i] = { ppid: 1, name: "claude" };
    const p = spawnProcs(table);
    p.alive.add(999); // alive, but the process table cannot read it
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < LOOKUP_BURST; i += 1) await m.registerSession(`s-${i}`, 300 + i, 1000 + i);
    await m.registerSession("late", 999, 2000); // bucket empty: dropped, flagged for retry
    expect(m.snapshot().find((e) => e.session_id === "late")).toMatchObject({ retry: true });
    await vi.advanceTimersByTimeAsync(10_000); // tick: the lookup works now and finds nothing
    expect(m.snapshot().find((e) => e.session_id === "late")).not.toHaveProperty("retry");
    const lookups = m.stats.lookups;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.stats.lookups - lookups).toBeLessThanOrEqual(1); // only the periodic re-checks
    await m.stop();
  });

  it("5: due re-checks share one process read per tick (one snapshot, not one spawn per entry)", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i < 8; i += 1) table[400 + i] = { ppid: 1, name: "claude", start: `S${i}` };
    const p = spawnProcs(table);
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < 8; i += 1) await m.registerSession(`s-${i}`, 400 + i, 1000 + i);
    const single = p.n.lookup;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(p.n.lookup).toBe(single); // no per-entry lookups afterwards
    expect(p.n.many).toBeGreaterThanOrEqual(2);
    expect(p.n.many).toBeLessThanOrEqual(3);
    expect(deaths()).toHaveLength(0);
    await m.stop();
  });

  it("5/11: a hung process lookup and a stalled registration queue do not delay a death past 15 s", async () => {
    const p = spawnProcs({ 100: { ppid: 1, name: "claude", start: "AAA" } });
    let release: () => void = () => undefined;
    const hang = new Promise<undefined>((r) => (release = () => r(undefined)));
    const procs: ProcLookup = {
      spawns: true,
      lookup: (pid) => (pid === 200 ? hang : p.procs.lookup(pid)),
      lookupMany: () => hang.then(() => new Map()),
    };
    p.alive.add(200);
    const m = mk({ store: memStore(), procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    m.onSpoolLine(liveEnv(SID_B, 200, 1001)); // its lookup never answers: the work queue is stuck
    await flush();
    const diedAt = Date.now();
    p.alive.delete(100);
    await vi.advanceTimersByTimeAsync(15_000);
    const d = deaths();
    expect(d).toHaveLength(1);
    expect(d[0]!.ts - diedAt).toBeLessThanOrEqual(15_000);
    release();
    await m.stop();
  });

  it("5: a hung start re-check does not delay another entry's death", async () => {
    const p = spawnProcs({
      100: { ppid: 1, name: "claude", start: "AAA" },
      101: { ppid: 1, name: "claude", start: "BBB" },
    });
    const m0 = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m0.start();
    m0.onSpoolLine(liveEnv(SID_A, 100, 1000));
    m0.onSpoolLine(liveEnv(SID_B, 101, 1001));
    await flush();
    let release: () => void = () => undefined;
    const hang = new Promise<Map<number, ProcInfo>>((r) => (release = () => r(new Map())));
    // swap the lookup under the same registry: re-checks now hang
    (p.procs as { lookupMany: ProcLookup["lookupMany"] }).lookupMany = () => hang;
    await vi.advanceTimersByTimeAsync(60_000); // a re-check is due and hangs
    const diedAt = Date.now();
    p.alive.delete(101);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths().map((d) => d.session_id)).toEqual([SID_B]);
    expect(deaths()[0]!.ts - diedAt).toBeLessThanOrEqual(15_000);
    release();
    await m0.stop();
  });
});

describe("U3-fix iteration 3: file candidates, parking, eviction, load, snapshot (findings 6-11)", () => {
  const sdir = (): string => join(tmp, "sessions");
  const put = (name: string, body: unknown): void => {
    mkdirSync(sdir(), { recursive: true });
    writeFileSync(join(sdir(), name), JSON.stringify(body));
  };

  it("6: of two files for one session the one whose procStart matches the OS start is watched", async () => {
    const p = fakeProcs({
      100: { ppid: 1, name: "claude", start: "OLD" }, // crashed run's pid, now a long-running process
      200: { ppid: 1, name: "claude", start: "NEW" },
    });
    put("100.json", { pid: 100, sessionId: SID_A, procStart: "STALE", startedAt: 5 });
    put("200.json", { pid: 200, sessionId: SID_A, procStart: "NEW", startedAt: 9 });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(hookEnv(SID_A, "PostToolUse", 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ pid: 200, state: "tracking" });
    await m.stop();
  });

  it("6: with no procStart match the newest startedAt wins; with no clear winner nothing is watched", async () => {
    const p = fakeProcs({ 100: { ppid: 1, name: "claude" }, 200: { ppid: 1, name: "claude" } });
    put("100.json", { pid: 100, sessionId: SID_A, startedAt: 5 });
    put("200.json", { pid: 200, sessionId: SID_A, startedAt: 9 });
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(hookEnv(SID_A, "PostToolUse", 1000));
    await flush();
    expect(m.snapshot()[0]).toMatchObject({ pid: 200, state: "tracking" });
    put("300.json", { pid: 300, sessionId: SID_B });
    put("400.json", { pid: 400, sessionId: SID_B });
    const q = fakeProcs({ 300: { ppid: 1, name: "claude" }, 400: { ppid: 1, name: "claude" } });
    const m2 = mk({ store: memStore(), procs: q.procs, isAlive: q.isAlive });
    await m2.start();
    m2.onSpoolLine(hookEnv(SID_B, "PostToolUse", 1000));
    await flush();
    expect(m2.snapshot()).toHaveLength(0);
    expect(logs.some((l) => l.includes("several sessions files"))).toBe(true);
    await m.stop();
    await m2.stop();
  });

  it("7: registrations past the queue cap are parked, counted, logged rate-limited, and replayed", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i < 200; i += 1) table[5000 + i] = { ppid: 1, name: "claude" };
    const p = fakeProcs(table);
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < 200; i += 1) m.onSpoolLine(liveEnv(`sess-${i}`, 5000 + i, 1000 + i));
    expect(m.stats.regDropped).toBe(72);
    await flush();
    await flush();
    expect(m.stats.regReplayed).toBe(72);
    expect(m.snapshot().filter((e) => e.state === "tracking")).toHaveLength(200);
    expect(logs.filter((l) => l.includes("queue is full"))).toHaveLength(1);
    await m.stop();
  });

  it("8: a full registry of tracking entries evicts one (non-claude first) instead of refusing", async () => {
    const table: Record<number, Omit<ProcInfo, "pid">> = {};
    for (let i = 0; i <= MAX_ENTRIES; i += 1)
      table[2000 + i] = { ppid: 1, name: i === 7 ? "node" : "claude" };
    const p = fakeProcs(table);
    const m = mk({ store: memStore(), procs: p.procs, isAlive: p.isAlive });
    await m.start();
    for (let i = 0; i < MAX_ENTRIES; i += 1) await m.registerSession(`s-${i}`, 2000 + i, 1000 + i);
    await m.registerSession("overflow", 2000 + MAX_ENTRIES, 5000);
    const ids = m.snapshot().map((e) => e.session_id);
    expect(ids).toHaveLength(MAX_ENTRIES);
    expect(ids).toContain("overflow");
    expect(ids).not.toContain("s-7");
    expect(m.stats.evictedTracking).toBe(1);
    expect(m.stats.capRefused).toBe(0);
    expect(logs.some((l) => l.includes("registry full"))).toBe(true);
    await m.stop();
  });

  it("9: a persisted registry is validated entry by entry and capped to the newest", async () => {
    const store = memStore();
    const base = { pid: 0, reported_pid: 0, state: "ended", ts: 1 };
    const sessions: Record<string, unknown> = {
      good: { ...base, session_id: "good", at: Date.now() },
      "key-mismatch": { ...base, session_id: "other", at: 5 },
      numeric: { ...base, session_id: 5, at: 5 },
      "bad state": { ...base, session_id: "bad state", at: 5 },
      "bad-pid": { ...base, session_id: "bad-pid", pid: "7", at: 5 },
      "no-at": { ...base, session_id: "no-at" },
      null: null,
    };
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1)
      sessions[`old-${i}`] = { ...base, session_id: `old-${i}`, at: Date.now() - 100_000 + i };
    store.text = JSON.stringify({ v: 1, boot: 1_000_000, sessions });
    const m = mk({ store, procs: fakeProcs({}).procs, isAlive: () => false });
    await m.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const ids = m.snapshot().map((e) => e.session_id);
    expect(ids).toHaveLength(MAX_ENTRIES);
    expect(ids).toContain("good");
    expect(ids).toContain(`old-${MAX_ENTRIES + 49}`);
    expect(ids).not.toContain("old-0");
    for (const bad of ["key-mismatch", "numeric", "bad state", "bad-pid", "no-at", "null"])
      expect(ids).not.toContain(bad);
    expect(logs.filter((l) => l.startsWith("error"))).toEqual([]);
    await m.stop();
  });

  it("10: win32 identity check: dev and ino must match the lstat's", () => {
    expect(sameIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n })).toBe(true);
    expect(sameIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 3n })).toBe(false);
    expect(sameIdentity({ dev: 1n, ino: 2n }, { dev: 9n, ino: 2n })).toBe(false);
    mkdirSync(sdir(), { recursive: true });
    const f = join(sdir(), "5.json");
    writeFileSync(f, '{"pid":5,"sessionId":"x"}');
    expect(readRegularFileCapped(f, MAX_FILE_BYTES, true)).toContain("sessionId");
    expect(readRegularFileCapped(f, MAX_FILE_BYTES, false)).toContain("sessionId");
  });

  it("11: a burst of Windows lookups shares one snapshot for about 2 s, then reads again", async () => {
    execCalls.length = 0;
    let t = 1_000_000;
    const w = windowsLookup(8000, undefined, undefined, () => t);
    const results = await Promise.all([
      w.ancestry!(50),
      w.ancestry!(50),
      w.lookupMany!([30, 40, 999]),
      w.lookupMany!([50]),
    ]);
    expect(execCalls).toHaveLength(1);
    expect(results[0]?.map((c) => c.pid)).toEqual([50, 40, 30]);
    expect([...results[2]!.keys()]).toEqual([30, 40]);
    t += 1000;
    await w.lookupMany!([30]);
    expect(execCalls).toHaveLength(1);
    t += 3000;
    await w.lookupMany!([30]);
    expect(execCalls).toHaveLength(2);
    // a cached snapshot that lacks the pid being walked is refreshed (the process is newer than it)
    t += 1000;
    expect(await w.ancestry!(77_777)).toEqual([]);
    expect(execCalls).toHaveLength(3); // the 1 s old snapshot lacked the pid: read again
    expect(await w.ancestry!(77_777)).toEqual([]);
    expect(execCalls).toHaveLength(3); // but not again within 300 ms
  });

  it("11: a snapshot over the buffer or a failed one is logged and never cached", async () => {
    execCalls.length = 0;
    const msgs: string[] = [];
    const w = windowsLookup(
      8000,
      undefined,
      (m) => msgs.push(m),
      () => 5_000_000,
    );
    execFail.err = { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" };
    try {
      expect(await w.lookupMany!([30])).toBeUndefined();
      expect(msgs.some((m) => m.includes("exceeded"))).toBe(true);
      execFail.err = undefined;
      expect([...(await w.lookupMany!([30]))!.keys()]).toEqual([30]); // retried, not cached
      expect(execCalls).toHaveLength(2);
    } finally {
      execFail.err = undefined;
    }
  });
});

describe("U3-fix iteration 4 (review iteration 3 findings 1-5)", () => {
  /** Persists a registration, then returns the saved state with its boot time moved (forces recheck). */
  async function shiftedStore(procs: ProcLookup, isAlive: (p: number) => boolean) {
    const store = memStore();
    const m0 = mk({ store, procs, isAlive });
    await m0.start();
    await m0.registerSession(SID_A, 100, 1000);
    await m0.stop();
    return store;
  }

  it("1: ancestry takes a new snapshot when the cached one began before the hook line", async () => {
    execCalls.length = 0;
    let t = 1_000_000;
    const w = windowsLookup(8000, undefined, undefined, () => t);
    await w.ancestry!(50, t);
    expect(execCalls).toHaveLength(1);
    t += 500; // still inside the 2 s reuse window
    await w.ancestry!(50, t - 400); // the line (1_000_100) is newer than the snapshot (1_000_000)
    expect(execCalls).toHaveLength(2);
    await w.ancestry!(50, t - 400);
    expect(execCalls).toHaveLength(2); // the new snapshot (at t) is newer than the line: reused
    await w.ancestry!(50); // no ts: ordinary reuse
    expect(execCalls).toHaveLength(2);
  });

  it("1: the monitor passes the hook line ts to ancestry", async () => {
    const seen: (number | undefined)[] = [];
    const procs: ProcLookup = {
      spawns: true,
      lookup: () => Promise.resolve(undefined),
      ancestry: (pid, nb) => {
        seen.push(nb);
        return Promise.resolve([{ pid, ppid: 1, name: "claude" }]);
      },
    };
    const m = mk({ store: memStore(), procs, isAlive: () => true });
    await m.start();
    await m.registerSession(SID_A, 100, 4242);
    expect(seen).toEqual([4242]);
    await m.stop();
  });

  it("2: a SessionEnd stuck behind slow queued work still wins over the grace death check", async () => {
    const p = spawnProcs({ 100: { ppid: 1, name: "claude", start: "AAA" } });
    let release: () => void = () => undefined;
    const hang = new Promise<undefined>((r) => (release = () => r(undefined)));
    const procs: ProcLookup = {
      spawns: true,
      lookup: (pid) => (pid === 200 ? hang : p.procs.lookup(pid)),
      lookupMany: p.procs.lookupMany!,
    };
    p.alive.add(200);
    const m = mk({ store: memStore(), procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 100, 1000));
    await flush();
    m.onSpoolLine(liveEnv(SID_B, 200, 1001)); // stalls the work queue
    await flush();
    p.alive.delete(100);
    m.onSpoolLine(hookEnv(SID_A, "SessionEnd", Date.now())); // queued behind the stall
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deaths()).toHaveLength(0);
    release();
    await flush();
    expect(m.snapshot().find((e) => e.session_id === SID_A)?.state).toBe("ended");
    await m.stop();
  });

  it("3: a failed process snapshot does not count as a completed re-check", async () => {
    const p = spawnProcs({ 100: { ppid: 1, name: "claude", start: "AAA" } });
    const store = await shiftedStore(p.procs, p.isAlive);
    const s = JSON.parse(store.text!) as { boot: number };
    s.boot = 9_000_000;
    store.text = JSON.stringify(s);
    let fail = true;
    const procs: ProcLookup = {
      ...p.procs,
      lookupMany: (pids) => (fail ? Promise.resolve(undefined) : p.procs.lookupMany!(pids)),
    };
    const m = mk({ store, procs, isAlive: p.isAlive });
    await m.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.snapshot()[0]).toMatchObject({ recheck: true }); // still owed
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.snapshot()[0]).not.toHaveProperty("recheck");
    expect(deaths()).toHaveLength(0);
    await m.stop();
  });

  it("4: work queued behind a hung task does not run after stop() gave up", async () => {
    const p = spawnProcs({
      200: { ppid: 1, name: "claude" },
      300: { ppid: 1, name: "claude" },
    });
    let release: () => void = () => undefined;
    const hang = new Promise<undefined>((r) => (release = () => r(undefined)));
    const looked: number[] = [];
    const procs: ProcLookup = {
      spawns: true,
      lookup: (pid) => {
        looked.push(pid);
        return pid === 200 ? hang : p.procs.lookup(pid);
      },
    };
    const m = mk({ store: memStore(), procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 200, 1000));
    await flush();
    m.onSpoolLine(liveEnv(SID_B, 300, 1001)); // queued behind the hung one
    await flush();
    const stopped = m.stop();
    await vi.advanceTimersByTimeAsync(3000);
    await stopped;
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(looked).toEqual([200]); // 300 never started
  });

  it("start() after a stop() that gave up works again and stop() drops pending SessionEnds", async () => {
    const p = spawnProcs({
      200: { ppid: 1, name: "claude" },
      300: { ppid: 1, name: "claude" },
    });
    let release: () => void = () => undefined;
    const hang = new Promise<undefined>((r) => (release = () => r(undefined)));
    const looked: number[] = [];
    const procs: ProcLookup = {
      spawns: true,
      lookup: (pid) => {
        looked.push(pid);
        return pid === 200 ? hang : p.procs.lookup(pid);
      },
    };
    const m = mk({ store: memStore(), procs, isAlive: p.isAlive });
    await m.start();
    m.onSpoolLine(liveEnv(SID_A, 200, 1000));
    await flush();
    const stopped = m.stop();
    await vi.advanceTimersByTimeAsync(3000);
    await stopped;
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect((m as unknown as { pendingEnd: Map<string, number> }).pendingEnd.size).toBe(0);
    await m.start();
    m.onSpoolLine(liveEnv(SID_B, 300, 2000));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(looked).toContain(300);
    await m.stop();
  });

  it("5: a forced re-check flag is dropped on an entry with no recorded OS start", async () => {
    const p = spawnProcs({ 100: { ppid: 1, name: "claude" } }); // no start token
    const store = await shiftedStore(p.procs, p.isAlive);
    const s = JSON.parse(store.text!) as { boot: number };
    s.boot = 9_000_000;
    store.text = JSON.stringify(s);
    const m = mk({ store, procs: p.procs, isAlive: p.isAlive });
    await m.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.snapshot()[0]).toMatchObject({ state: "tracking" });
    expect(m.snapshot()[0]).not.toHaveProperty("recheck");
    await m.stop();
  });
});
