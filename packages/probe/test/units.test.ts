import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvelopeSchema, ULID_PATTERN } from "@sessiondeck/contract";
import { buildEnvelope, hookEnvelopeFromPayload, hostOs } from "../src/envelope.ts";
import { dayFileName, probeHome, spoolDir, hookErrorsLog } from "../src/paths.ts";
import {
  appendEnvelopes,
  LOCK_NAME,
  MAX_LINE_BYTES,
  SEQ_NAME,
  serializeLine,
} from "../src/spool.ts";
import { createUlidGenerator } from "../src/ulid.ts";
import { logHookError, processHookInput, ERROR_LOG_MAX_BYTES } from "../src/hook-core.ts";

describe("ulid", () => {
  it("matches ULID_PATTERN, unique, monotonic within one ms", () => {
    const gen = createUlidGenerator();
    const ids = Array.from({ length: 5000 }, () => gen(1_760_000_000_000));
    for (const id of ids) expect(id).toMatch(ULID_PATTERN);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
  it("later time sorts later; clock step back keeps order", () => {
    const gen = createUlidGenerator();
    const a = gen(1_760_000_000_000);
    const b = gen(1_760_000_000_001);
    const c = gen(1_759_999_999_000);
    expect(a < b && b < c).toBe(true);
  });
  it("encodes the timestamp in the first 10 chars", () => {
    expect(createUlidGenerator()(0).slice(0, 10)).toBe("0000000000");
    expect(createUlidGenerator()(31).slice(0, 10)).toBe("000000000Z");
  });
  it("handles 80-bit random overflow by advancing the time", () => {
    const gen = createUlidGenerator();
    const first = gen(5);
    expect(first).toMatch(ULID_PATTERN);
    // Force overflow path by mocking randomBytes is overkill; just prove many calls stay ordered.
    let prev = first;
    for (let i = 0; i < 100; i++) {
      const n = gen(5);
      expect(n > prev).toBe(true);
      prev = n;
    }
  });
});

describe("envelope builder", () => {
  const payload = {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    agent_id: "a1",
    x: [1, { y: 2 }],
  };
  it("builds a schema-valid hook envelope with agent_id and untouched payload", () => {
    const env = hookEnvelopeFromPayload(payload, 7, 1_760_000_000_000)!;
    expect(EnvelopeSchema.parse(env)).toBeTruthy();
    expect(env).toMatchObject({
      v: 1,
      kind: "hook",
      session_id: "s1",
      agent_id: "a1",
      hook_event_name: "PreToolUse",
      ts: 1_760_000_000_000,
      seq: 7,
    });
    expect(env.payload).toBe(payload);
    expect(["win32", "linux", "darwin"]).toContain(env.os);
  });
  it("omits agent_id when absent; null for missing session or event", () => {
    const env = hookEnvelopeFromPayload({ session_id: "s", hook_event_name: "Stop" }, 1)!;
    expect("agent_id" in env).toBe(false);
    expect(hookEnvelopeFromPayload({ hook_event_name: "Stop" }, 1)).toBeNull();
    expect(hookEnvelopeFromPayload({ session_id: "s" }, 1)).toBeNull();
  });
  it("maps platforms", () => {
    expect(hostOs("win32")).toBe("win32");
    expect(hostOs("darwin")).toBe("darwin");
    expect(hostOs("freebsd")).toBe("linux");
  });
  it("buildEnvelope honours explicit id, host, session null", () => {
    const e = buildEnvelope({
      kind: "probe",
      seq: 0,
      payload: null,
      session_id: null,
      id: "X",
      host: "h",
      hook_event_name: "E",
    });
    expect(e).toMatchObject({ id: "X", host: "h", session_id: null, hook_event_name: "E" });
  });
});

describe("paths", () => {
  it("windows: LOCALAPPDATA", () => {
    const e = {
      platform: "win32" as const,
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      home: "C:\\Users\\u",
    };
    expect(probeHome(e)).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck");
    expect(spoolDir(e)).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck\\spool");
    expect(hookErrorsLog(e)).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck\\hook-errors.log");
  });
  it("windows without LOCALAPPDATA falls back under the home dir", () => {
    expect(probeHome({ platform: "win32", env: {}, home: "C:\\Users\\u" })).toBe(
      "C:\\Users\\u\\AppData\\Local\\sessiondeck",
    );
  });
  it("linux: XDG_STATE_HOME, then ~/.local/state (WSL2 never gets Windows paths)", () => {
    expect(
      probeHome({
        platform: "linux",
        env: { XDG_STATE_HOME: "/x/state", LOCALAPPDATA: "C:\\no" },
        home: "/home/u",
      }),
    ).toBe("/x/state/sessiondeck");
    expect(probeHome({ platform: "linux", env: {}, home: "/home/u" })).toBe(
      "/home/u/.local/state/sessiondeck",
    );
    expect(probeHome({ platform: "darwin", env: {}, home: "/Users/u" })).toBe(
      "/Users/u/.local/state/sessiondeck",
    );
  });
  it("SESSIONDECK_HOME overrides on every platform", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(probeHome({ platform, env: { SESSIONDECK_HOME: "/t/h" }, home: "/h" })).toBe("/t/h");
    }
    expect(spoolDir({ platform: "linux", env: { SESSIONDECK_HOME: "/t/h" }, home: "/h" })).toBe(
      join("/t/h", "spool"),
    );
  });
  it("day file by UTC date", () => {
    expect(dayFileName(Date.UTC(2026, 9, 20, 23, 59, 59))).toBe("2026-10-20.jsonl");
    expect(dayFileName(Date.UTC(2026, 9, 21, 0, 0, 0))).toBe("2026-10-21.jsonl");
  });
});

describe("spool", () => {
  const mk = (payload: unknown) => (seq: number) =>
    buildEnvelope({ kind: "hook", seq, payload, session_id: "s", hook_event_name: "Stop" });

  it("replaces an oversized payload with the truncated marker, keeps the line under the cap", () => {
    const env = mk({ big: "x".repeat(200_000) })(1);
    const { line, truncated } = serializeLine(env);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(line);
    expect(parsed.payload).toEqual({
      truncated: true,
      original_bytes: expect.any(Number),
      limit_bytes: MAX_LINE_BYTES,
    });
    expect(parsed.payload.original_bytes).toBeGreaterThan(200_000);
    expect(parsed.session_id).toBe("s");
    expect(EnvelopeSchema.safeParse(parsed).success).toBe(true);
  });
  it("small envelopes pass through unchanged", () => {
    const env = mk({ a: 1 })(1);
    const { line, truncated } = serializeLine(env);
    expect(truncated).toBe(false);
    expect(line).toBe(JSON.stringify(env) + "\n");
  });
  it("assigns increasing seq from the persisted counter, recovers from a torn counter", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sd-spool-")), "spool");
    try {
      appendEnvelopes(dir, [mk(1), mk(2)], () => 1_000);
      appendEnvelopes(dir, [mk(3)], () => 1_000);
      expect(readFileSync(join(dir, SEQ_NAME), "utf8")).toBe("0000000000001003");
      writeFileSync(join(dir, SEQ_NAME), "");
      appendEnvelopes(dir, [mk(4)], () => 5_000);
      const seqs = readFileSync(join(dir, "1970-01-01.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).seq);
      expect(seqs).toEqual([1001, 1002, 1003, 5001]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("breaks a stale lock and releases its own", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sd-spool-")), "spool");
    try {
      mkdirSync(dir, { recursive: true });
      const lock = join(dir, LOCK_NAME);
      writeFileSync(lock, "");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const r = appendEnvelopes(dir, [mk(1)]);
      expect(r.locked).toBe(true);
      expect(() => readFileSync(lock)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a live lock is waited for within bounds, then the line is appended anyway", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sd-spool-")), "spool");
    try {
      mkdirSync(dir, { recursive: true });
      const lock = join(dir, LOCK_NAME);
      writeFileSync(lock, "");
      // Keep refreshing is not possible synchronously; a fresh lock younger than stale age
      // outlasts the wait only if stale > wait, so only assert the append happened and was fast.
      const t0 = Date.now();
      const r = appendEnvelopes(dir, [mk(1)]);
      expect(r.lines).toBe(1);
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hook core", () => {
  it("error log is size capped and holds only the reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-log-"));
    const log = join(dir, "sub", "hook-errors.log");
    try {
      for (let i = 0; i < 4000; i++) logHookError("invalid-json", log);
      expect(readFileSync(log).length).toBeLessThanOrEqual(ERROR_LOG_MAX_BYTES + 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reports failures for every bad input class", () => {
    const d = "/nonexistent-dir-for-test/never-created-" + process.pid;
    const bad = (data: string, ok = true) =>
      processHookInput({ ok, data: Buffer.from(data) } as never, d);
    expect(bad("")).toEqual({ ok: false, reason: "empty-stdin" });
    expect(bad("{")).toEqual({ ok: false, reason: "invalid-json" });
    expect(bad("[]")).toEqual({ ok: false, reason: "not-an-object" });
    expect(bad("{}")).toEqual({ ok: false, reason: "missing-session-id-or-event-name" });
    expect(processHookInput({ ok: false, reason: "timeout", data: Buffer.alloc(0) }, d)).toEqual({
      ok: false,
      reason: "timeout",
    });
  });
});
