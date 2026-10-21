import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSnapshot, reduce, HOOK_EVENTS } from "@sessiondeck/contract";
import { dayFileName } from "../src/paths.ts";
import { deriveState, readTail, stepState, type Track } from "../src/statusline/state.ts";
import { oneLine, renderStatusLine } from "../src/statusline/render.ts";
import { maybeUtf8, setWindowsUtf8, system32Dir } from "../src/win-utf8.ts";

function seedHook(h: string, sid: string, event: string, extra: object = {}, ts = Date.now()) {
  const dir = join(h, "spool");
  mkdirSync(dir, { recursive: true });
  const line = {
    v: 1,
    id: "x",
    kind: "hook",
    host: "t",
    os: "linux",
    session_id: sid,
    ts,
    hook_event_name: event,
    payload: { session_id: sid, hook_event_name: event },
    ...extra,
  };
  writeFileSync(join(dir, dayFileName(ts)), JSON.stringify(line) + "\n", { flag: "a" });
}

describe("renderStatusLine", () => {
  const now = 1_000_000_000_000;
  it("computes context % when used_percentage is missing", () => {
    const s = renderStatusLine(
      {
        model: { display_name: "M" },
        context_window: {
          context_window_size: 1000,
          current_usage: { input_tokens: 100, cache_read_input_tokens: 150 },
        },
      },
      now,
    );
    expect(s).toBe("n/a | M | ctx 25% | 5h n/a | 7d n/a");
  });
  it("out-of-range used_percentage is n/a", () => {
    const s = renderStatusLine(
      { rate_limits: { five_hour: { used_percentage: 1792101600 } } },
      now,
    );
    expect(s).toContain("5h n/a");
  });
  it("strips control characters from the model name and shows cost and effort", () => {
    const s = renderStatusLine(
      { model: "a\nb\u001b[31m", effort: { level: "high" }, cost: { total_cost_usd: 1.234 } },
      now,
    );
    expect(s.split("\n")).toHaveLength(1);
    expect(s).toContain("high");
    expect(s).toContain("$1.23");
    expect(s).not.toContain("\u001b");
  });
  it("strips whole escape sequences, bidi and zero-width characters", () => {
    const m = (model: string) => renderStatusLine({ model }, now).split(" | ")[1];
    expect(m("x\u001b[31m")).toBe("x");
    expect(m("a\u001b[1;31mb\u001b]0;title\u0007c")).toBe("abc");
    expect(m("a\u202eb\u200bc\ufeffd")).toBe("a b c d");
  });
  it("truncates by code points, not UTF-16 units", () => {
    const out = oneLine("\u{1F600}".repeat(50), 40);
    expect(Array.from(out)).toHaveLength(40);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it.each([null, 5, "x", [], undefined, { model: 7, context_window: 3, rate_limits: 4 }])(
    "garbage %j still renders a line",
    (v) => {
      const s = renderStatusLine(v, now);
      expect(s.length).toBeGreaterThan(0);
    },
  );
});

describe("win-utf8", () => {
  type Call = { file: string; args: string[]; cwd: string; env: object };
  const spy =
    (calls: Call[], fail = false) =>
    (file: string, args: string[], o: { cwd: string; env: object }) => {
      calls.push({ file, args, cwd: o.cwd, env: o.env });
      if (fail) throw new Error("denied");
    };
  it("is a no-op off win32", () => {
    const calls: Call[] = [];
    setWindowsUtf8("linux", spy(calls), {}, () => true);
    expect(calls).toEqual([]);
  });
  it("runs the absolute System32 chcp.com, cwd System32, minimal env, and swallows failure", () => {
    const calls: Call[] = [];
    setWindowsUtf8("win32", spy(calls, true), { SystemRoot: "D:\\WinRoot", PATH: "x" }, () => true);
    expect(calls).toEqual([
      {
        file: "D:\\WinRoot\\System32\\chcp.com",
        args: ["65001"],
        cwd: "D:\\WinRoot\\System32",
        env: { SystemRoot: "D:\\WinRoot" },
      },
    ]);
  });
  it("never uses a bare name or the cwd; rejects a relative or odd SystemRoot", () => {
    for (const sr of [undefined, "", "..\\evil", "C:\\a%b", "\\\\host\\share", 'C:\\a"b']) {
      expect(system32Dir(sr === undefined ? {} : { SystemRoot: sr })).toBe("C:\\Windows\\System32");
    }
    const calls: Call[] = [];
    setWindowsUtf8("win32", spy(calls), {}, () => true);
    expect(calls[0]?.file).toMatch(/^[A-Za-z]:\\.*\\chcp\.com$/);
  });
  it("skips when chcp.com is missing or under Git Bash (MSYSTEM)", () => {
    const calls: Call[] = [];
    setWindowsUtf8("win32", spy(calls), {}, () => false);
    setWindowsUtf8("win32", spy(calls), { MSYSTEM: "MINGW64" }, () => true);
    expect(calls).toEqual([]);
  });
});

describe("state derivation", () => {
  const sid = "sess-1";
  const dirs: string[] = [];
  const mk = () => {
    const h = mkdtempSync(join(tmpdir(), "sd-st-"));
    dirs.push(h);
    return h;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // Event variants whose transitions depend on payload, agent or prior state.
  const variants: { ev: string; payload: Record<string, unknown>; agent: string | null }[] = [];
  for (const ev of HOOK_EVENTS) {
    for (const agent of [null, "agent-1"]) {
      variants.push({ ev, payload: {}, agent });
    }
  }
  for (const agent of [null, "agent-1"]) {
    for (const tool of ["AskUserQuestion", "ExitPlanMode", "Bash"]) {
      variants.push({ ev: "PreToolUse", payload: { tool_name: tool }, agent });
    }
    for (const t of ["permission_prompt", "elicitation_dialog", "idle_prompt"]) {
      variants.push({ ev: "Notification", payload: { notification_type: t }, agent });
    }
  }
  variants.push({ ev: "SessionStart", payload: { source: "compact" }, agent: null });
  variants.push({ ev: "SessionStart", payload: { source: "resume" }, agent: null });
  const envOf = (v: (typeof variants)[number], ts: number) => ({
    v: 1 as const,
    id: "i",
    kind: "hook" as const,
    host: "t",
    os: "linux" as const,
    session_id: sid,
    ts,
    hook_event_name: v.ev,
    ...(v.agent === null ? {} : { agent_id: v.agent }),
    payload: { session_id: sid, hook_event_name: v.ev, ...v.payload },
  });
  const fresh = () => createSnapshot({ session_id: sid, host: "t", cwd: "/x", ts: 1 });
  const freshTrack: Track = { state: "starting", lastTool: null, permission: null };

  it("mirrors the contract reduce() for every pair of events (state after each step)", () => {
    for (const a of variants) {
      for (const b of variants) {
        const s1 = reduce(fresh(), envOf(a, 2) as never);
        const s2 = reduce(s1, envOf(b, 3) as never);
        const t1 = stepState(freshTrack, a.ev, envOf(a, 2).payload, a.agent);
        const t2 = stepState(t1, b.ev, envOf(b, 3).payload, b.agent);
        const label = `${a.ev}${a.agent ? "(sub)" : ""} -> ${b.ev}${b.agent ? "(sub)" : ""}`;
        expect(t1.state, label).toBe(s1.state);
        expect(t2.state, label).toBe(s2.state);
      }
    }
  });
  it("mirrors reduce() over every sequence of three events", () => {
    // Plain comparisons with mismatches collected: a per-case expect() with a
    // formatted label costs far more than reduce() itself over ~N^3 cases.
    const envs = variants.map((v) => ({ v, e2: envOf(v, 2), e9: envOf(v, 9) }));
    const bad: string[] = [];
    for (const a of envs) {
      for (const b of envs) {
        const snap = reduce(reduce(fresh(), a.e2 as never), envOf(b.v, 3) as never);
        const t = stepState(
          stepState(freshTrack, a.v.ev, a.e2.payload, a.v.agent),
          b.v.ev,
          b.e2.payload,
          b.v.agent,
        );
        for (const c of envs) {
          const s3 = reduce(snap, c.e9 as never);
          const t3 = stepState(t, c.v.ev, c.e9.payload, c.v.agent);
          if (t3.state !== s3.state) bad.push(`${a.v.ev} ${b.v.ev} ${c.v.ev}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
  it("after Stop following AskUserQuestion or ExitPlanMode the bar says waiting_input", () => {
    for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
      const h = mk();
      seedHook(h, sid, "UserPromptSubmit");
      seedHook(h, sid, "PreToolUse", { payload: { tool_name: tool } });
      seedHook(h, sid, "Stop");
      expect(deriveState(join(h, "spool"), sid), tool).toBe("waiting_input");
    }
    const h = mk();
    seedHook(h, sid, "PreToolUse", { payload: { tool_name: "AskUserQuestion" } });
    seedHook(h, sid, "UserPromptSubmit");
    seedHook(h, sid, "PreToolUse", { payload: { tool_name: "Bash" } });
    seedHook(h, sid, "Stop");
    expect(deriveState(join(h, "spool"), sid)).toBe("idle");
  });
  it("PostCompact from idle keeps idle; from working it stays working; alone it is unknown", () => {
    const h = mk();
    seedHook(h, sid, "Stop");
    seedHook(h, sid, "PostCompact");
    expect(deriveState(join(h, "spool"), sid)).toBe("idle");
    const w = mk();
    seedHook(w, sid, "UserPromptSubmit");
    seedHook(w, sid, "PostCompact");
    expect(deriveState(join(w, "spool"), sid)).toBe("working");
    const u = mk();
    seedHook(u, sid, "PostCompact");
    expect(deriveState(join(u, "spool"), sid)).toBe("n/a");
  });
  it("uses the last hook line of the session, ignores other sessions and non-hook lines", () => {
    const h = mk();
    seedHook(h, sid, "PreToolUse");
    seedHook(h, sid, "Stop");
    seedHook(h, "other", "PermissionRequest");
    expect(deriveState(join(h, "spool"), sid)).toBe("idle");
    seedHook(h, sid, "SessionEnd");
    expect(deriveState(join(h, "spool"), sid)).toBe("ended");
  });
  it("falls back to yesterday's file", () => {
    const h = mk();
    seedHook(h, sid, "UserPromptSubmit", {}, Date.now() - 86_400_000);
    expect(deriveState(join(h, "spool"), sid)).toBe("working");
  });
  it("replays yesterday then today when today is read whole (final review)", () => {
    const h = mk();
    const y = Date.now() - 86_400_000;
    seedHook(h, sid, "UserPromptSubmit", {}, y);
    seedHook(h, sid, "PreToolUse", { payload: { tool_name: "AskUserQuestion" } }, y + 1);
    seedHook(h, sid, "Stop");
    expect(deriveState(join(h, "spool"), sid)).toBe("waiting_input");
  });
  it("only looks at the last 64 KB and survives garbage and a missing file", () => {
    const h = mk();
    seedHook(h, sid, "Stop");
    const f = join(h, "spool", dayFileName(Date.now()));
    writeFileSync(f, "x".repeat(70 * 1024) + "\nnot json " + sid + ' "hook"\n', { flag: "a" });
    expect(deriveState(join(h, "spool"), sid)).toBe("n/a");
    expect(deriveState(join(h, "nope"), sid)).toBe("n/a");
    expect(deriveState(join(h, "spool"), undefined)).toBe("n/a");
  });
  it.skipIf(process.platform === "win32")("refuses a symlinked day file", () => {
    const h = mk();
    mkdirSync(join(h, "spool"));
    const real = join(h, "real.jsonl");
    writeFileSync(
      real,
      JSON.stringify({ kind: "hook", session_id: sid, hook_event_name: "Stop", payload: {} }) +
        "\n",
    );
    symlinkSync(real, join(h, "spool", dayFileName(Date.now())));
    expect(deriveState(join(h, "spool"), sid)).toBe("n/a");
  });
});

describe("day file handling (review round 2)", () => {
  const sid = "sess-1";
  const dirs: string[] = [];
  const mk = () => {
    const h = mkdtempSync(join(tmpdir(), "sd-st2-"));
    dirs.push(h);
    mkdirSync(join(h, "spool"));
    return h;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const hookLine = (id: string, event: string): string =>
    JSON.stringify({ kind: "hook", session_id: id, hook_event_name: event, payload: {} }) + "\n";
  const today = (h: string): string => join(h, "spool", dayFileName(Date.now()));

  it("a symlinked day file is n/a, and fast", () => {
    const h = mk();
    const real = join(h, "real.jsonl");
    writeFileSync(real, hookLine(sid, "Stop"));
    try {
      symlinkSync(real, today(h));
    } catch {
      return; // symlinks need a privilege on some Windows setups
    }
    const t0 = Date.now();
    expect(deriveState(join(h, "spool"), sid)).toBe("n/a");
    expect(readTail(today(h))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("a directory named as the day file is n/a", () => {
    const h = mk();
    mkdirSync(today(h));
    expect(deriveState(join(h, "spool"), sid)).toBe("n/a");
  });
  it("a session id that is a substring of other ids matches only its own lines", () => {
    const h = mk();
    writeFileSync(today(h), hookLine("sess-12", "Stop") + hookLine("xsess-1", "StopFailure"));
    expect(deriveState(join(h, "spool"), "sess-1")).toBe("n/a");
    writeFileSync(today(h), hookLine("sess-12", "Stop") + hookLine("sess-1", "UserPromptSubmit"), {
      flag: "a",
    });
    expect(deriveState(join(h, "spool"), "sess-1")).toBe("working");
    expect(deriveState(join(h, "spool"), "sess-12")).toBe("idle");
  });
  it("yesterday is read when today's file is absent or whole, not when it is larger than the tail", () => {
    const now = Date.now();
    const yesterday = (h: string): string => join(h, "spool", dayFileName(now - 86_400_000));
    const a = mk();
    writeFileSync(yesterday(a), hookLine(sid, "UserPromptSubmit"));
    expect(deriveState(join(a, "spool"), sid, now)).toBe("working"); // today absent
    writeFileSync(today(a), hookLine("other", "Stop"));
    expect(deriveState(join(a, "spool"), sid, now)).toBe("working"); // today whole, no line for us
    const b = mk();
    writeFileSync(yesterday(b), hookLine(sid, "UserPromptSubmit"));
    writeFileSync(today(b), hookLine("other", "Stop").repeat(2000)); // > 64 KB, no line for us
    expect(deriveState(join(b, "spool"), sid, now)).toBe("n/a");
    const c = mk();
    writeFileSync(yesterday(c), hookLine(sid, "UserPromptSubmit"));
    writeFileSync(today(c), "x".repeat(70 * 1024) + "\n"); // one line longer than the tail
    expect(readTail(today(c))).toBe("");
    expect(deriveState(join(c, "spool"), sid, now)).toBe("n/a");
  });
  it("indeterminate lines today continue from yesterday's state", () => {
    const now = Date.now();
    const h = mk();
    writeFileSync(join(h, "spool", dayFileName(now - 86_400_000)), hookLine(sid, "Stop"));
    writeFileSync(today(h), hookLine(sid, "PostCompact"));
    expect(deriveState(join(h, "spool"), sid, now)).toBe("idle");
  });
});

describe("maybeUtf8 (review round 2)", () => {
  it("does not call the code page setter for an ASCII line", () => {
    let calls = 0;
    expect(maybeUtf8("idle | Opus | ctx 38%", () => (calls += 1))).toBe(false);
    expect(calls).toBe(0);
  });
  it("calls it once for a non-ASCII line", () => {
    let calls = 0;
    expect(maybeUtf8("idle | Modèle 日本語", () => (calls += 1))).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("escape stripping (review round 2)", () => {
  it("strips CSI with private parameter bytes, 8-bit CSI, DCS/APC strings and OSC", () => {
    const cases: [string, string][] = [
      ["a\u001b[<1;2mb", "ab"],
      ["a\u001b[=3;4hb", "ab"],
      ["a\u001b[>5cb", "ab"],
      ["a\u001b[?25lb", "ab"],
      ["a\u009b31;1mb", "ab"],
      ["a\u009b<1mb", "ab"],
      ["a\u001bPq#0;2;0;0;0\u001b\\b", "ab"],
      ["a\u001b_Gf=24;AAAA\u001b\\b", "ab"],
      ["a\u001bXsos text\u001b\\b", "ab"],
      ["a\u001b]0;title\u0007b", "ab"],
    ];
    for (const [input, want] of cases) expect(oneLine(input), JSON.stringify(input)).toBe(want);
  });
});
