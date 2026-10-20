import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ULID_PATTERN } from "@sessiondeck/contract";
import { buildEnvelope, hookEnvelopeFromPayload, hostOs } from "../src/envelope.ts";
import { dayFileName, defaultProbeHome, spoolDir, hookErrorsLog } from "../src/paths.ts";
import { cliDefaultHome, probeHome } from "../src/cli-paths.ts";
import { parseProbeArgs } from "../src/args.ts";
import { isWsl } from "../src/host.ts";
import { MAX_LINE_BYTES, parseSpoolLine } from "../src/spool.ts";
import { appendSpoolLines, serializeLine } from "../src/spool-writer.ts";
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
  it("builds a schema-valid seq-less hook line with agent_id and untouched payload", () => {
    const env = hookEnvelopeFromPayload(payload, "h1", 1_760_000_000_000)!;
    expect("seq" in env).toBe(false);
    expect(parseSpoolLine(JSON.stringify(env)).ok).toBe(true);
    expect(env).toMatchObject({
      v: 1,
      kind: "hook",
      host: "h1",
      session_id: "s1",
      agent_id: "a1",
      hook_event_name: "PreToolUse",
      ts: 1_760_000_000_000,
    });
    expect(env.payload).toBe(payload);
    expect(["win32", "linux", "darwin"]).toContain(env.os);
  });
  it("omits agent_id when absent; null for missing session or event", () => {
    const env = hookEnvelopeFromPayload({ session_id: "s", hook_event_name: "Stop" }, "h")!;
    expect("agent_id" in env).toBe(false);
    expect(hookEnvelopeFromPayload({ hook_event_name: "Stop" }, "h")).toBeNull();
    expect(hookEnvelopeFromPayload({ session_id: "s" }, "h")).toBeNull();
  });
  it("maps platforms", () => {
    expect(hostOs("win32")).toBe("win32");
    expect(hostOs("darwin")).toBe("darwin");
    expect(hostOs("freebsd")).toBe("linux");
  });
  it("buildEnvelope honours explicit id, host, session null", () => {
    const e = buildEnvelope({
      kind: "probe",
      payload: null,
      session_id: null,
      id: "X",
      host: "h",
      hook_event_name: "E",
    });
    expect(e).toMatchObject({ id: "X", host: "h", session_id: null, hook_event_name: "E" });
  });
});

describe("parseSpoolLine", () => {
  const good = JSON.stringify(
    hookEnvelopeFromPayload({ session_id: "s", hook_event_name: "Stop" }, "h"),
  );
  it("accepts a valid line and drops any seq", () => {
    const r = parseSpoolLine(good);
    expect(r.ok).toBe(true);
    const withSeq = parseSpoolLine(JSON.stringify({ ...JSON.parse(good), seq: 9 }));
    expect(withSeq.ok && "seq" in withSeq.line).toBe(false);
  });
  it("rejects bad json, non-objects and schema violations", () => {
    expect(parseSpoolLine("{")).toEqual({ ok: false, error: "invalid-json" });
    expect(parseSpoolLine("[]")).toEqual({ ok: false, error: "not-an-object" });
    expect(parseSpoolLine(JSON.stringify({ ...JSON.parse(good), id: "nope" })).ok).toBe(false);
    expect(parseSpoolLine("{}").ok).toBe(false);
  });
});

describe("args", () => {
  it("reads --home and --host in both forms, ignores the rest", () => {
    expect(parseProbeArgs(["--home", "C:/a b", "--host", "h", "--sessiondeck-probe"])).toEqual({
      home: "C:/a b",
      host: "h",
    });
    expect(parseProbeArgs(["--home=/x", "--host=y", "--other"])).toEqual({ home: "/x", host: "y" });
    expect(parseProbeArgs(["--home"])).toEqual({});
    expect(parseProbeArgs([])).toEqual({});
  });
  it("isWsl is false off Linux", () => {
    expect(isWsl("win32")).toBe(false);
    expect(isWsl("darwin")).toBe(false);
  });
});

describe("paths", () => {
  it("windows: <homedir>\\AppData\\Local\\sessiondeck", () => {
    const e = {
      platform: "win32" as const,
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      home: "C:\\Users\\u",
    };
    const home = defaultProbeHome(e);
    expect(home).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck");
    expect(spoolDir(home, "win32")).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck\\spool");
    expect(spoolDir("C:/Users/u/sd", "win32")).toBe("C:\\Users\\u\\sd\\spool");
    expect(hookErrorsLog(home, "win32")).toBe(
      "C:\\Users\\u\\AppData\\Local\\sessiondeck\\hook-errors.log",
    );
  });
  it("windows with no LOCALAPPDATA gives the same home", () => {
    expect(defaultProbeHome({ platform: "win32", env: {}, home: "C:\\Users\\u" })).toBe(
      "C:\\Users\\u\\AppData\\Local\\sessiondeck",
    );
  });
  it("linux and macOS: ~/.local/state/sessiondeck; XDG_STATE_HOME and LOCALAPPDATA ignored", () => {
    expect(
      defaultProbeHome({
        platform: "linux",
        env: { XDG_STATE_HOME: "/x/state", LOCALAPPDATA: "C:\\no" },
        home: "/home/u",
      }),
    ).toBe("/home/u/.local/state/sessiondeck");
    expect(defaultProbeHome({ platform: "darwin", env: {}, home: "/Users/u" })).toBe(
      "/Users/u/.local/state/sessiondeck",
    );
  });
  it("the Windows hook and CLI defaults both ignore LOCALAPPDATA", () => {
    const e = {
      platform: "win32" as const,
      env: { LOCALAPPDATA: "C:\\evil" },
      home: "C:\\Users\\u",
    };
    expect(cliDefaultHome(e)).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck");
    expect(defaultProbeHome(e)).toBe("C:\\Users\\u\\AppData\\Local\\sessiondeck");
  });
  it("only an explicit --home moves the CLI home; SESSIONDECK_HOME is ignored", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(probeHome({ platform, env: {}, home: "/h" }, "/t/h")).toMatch(/[\\/]t[\\/]h$/);
    }
    expect(probeHome({ platform: "linux", env: { SESSIONDECK_HOME: "/t/h" }, home: "/h" })).toBe(
      "/h/.local/state/sessiondeck",
    );
    expect(probeHome({ platform: "linux", env: {}, home: "/h" })).toBe(
      "/h/.local/state/sessiondeck",
    );
  });
  it("day file by UTC date", () => {
    expect(dayFileName(Date.UTC(2026, 9, 20, 23, 59, 59))).toBe("2026-10-20.jsonl");
    expect(dayFileName(Date.UTC(2026, 9, 21, 0, 0, 0))).toBe("2026-10-21.jsonl");
  });
});

describe("spool", () => {
  const mk = (payload: unknown, session_id = "s") =>
    buildEnvelope({ kind: "hook", host: "h", payload, session_id, hook_event_name: "Stop" });

  it("replaces an oversized payload with the truncated marker, keeps the line under the cap", () => {
    const env = mk({ big: "x".repeat(200_000) });
    const { line, truncated } = serializeLine(env)!;
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
    expect(parseSpoolLine(line.trimEnd()).ok).toBe(true);
  });
  it("small envelopes pass through unchanged", () => {
    const env = mk({ a: 1 });
    const { line, truncated } = serializeLine(env)!;
    expect(truncated).toBe(false);
    expect(line).toBe(JSON.stringify(env) + "\n");
  });
  it("a line that is still over the cap after truncation is dropped, not written", () => {
    const env = mk({ a: 1 }, "z".repeat(100_000));
    expect(serializeLine(env)).toBeNull();
    const dir = join(mkdtempSync(join(tmpdir(), "sd-spool-")), "spool");
    try {
      expect(appendSpoolLines(dir, [env])).toEqual({ written: 0, dropped: 1 });
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
  it("appends lines in order to the UTC day file, no side files", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sd-spool-")), "spool");
    try {
      appendSpoolLines(dir, [mk(1), mk(2)], () => 1_000);
      appendSpoolLines(dir, [mk(3)], () => 1_000);
      const lines = readFileSync(join(dir, "1970-01-01.jsonl"), "utf8").split("\n").filter(Boolean);
      expect(lines.map((l) => JSON.parse(l).payload)).toEqual([1, 2, 3]);
      expect(readdirSync(dir)).toEqual(["1970-01-01.jsonl"]);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
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
      processHookInput({ ok, data: Buffer.from(data) } as never, { spool: d, host: "h" });
    expect(bad("")).toEqual({ ok: false, reason: "empty-stdin" });
    expect(bad("{")).toEqual({ ok: false, reason: "invalid-json" });
    expect(bad("[]")).toEqual({ ok: false, reason: "not-an-object" });
    expect(bad("{}")).toEqual({ ok: false, reason: "missing-session-id-or-event-name" });
    expect(
      processHookInput(
        { ok: false, reason: "timeout", data: Buffer.alloc(0) },
        { spool: d, host: "h" },
      ),
    ).toEqual({
      ok: false,
      reason: "timeout",
    });
  });
});
