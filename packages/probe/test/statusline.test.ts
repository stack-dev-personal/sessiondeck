import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSnapshot, reduce, HOOK_EVENTS } from "@sessiondeck/contract";
import { dayFileName } from "../src/paths.ts";
import { deriveState, stateForHook } from "../src/statusline/state.ts";
import { parseSpoolLine } from "../src/spool.ts";
import { oneLine, renderStatusLine } from "../src/statusline/render.ts";
import { setWindowsUtf8, system32Dir } from "../src/win-utf8.ts";
import { fixturesDir, probeRoot, readSpoolLines, runHook } from "./helpers.ts";

const statuslinePath = join(probeRoot, "dist", "statusline.mjs");
const subagentsPath = join(probeRoot, "dist", "subagents.mjs");
const run = (stdin: Buffer | string | null, home: string, script = statuslinePath) =>
  runHook(stdin, { home, host: "testhost" }, script);

const FIX = join(fixturesDir, "statusLine");
const fixtureFiles = readdirSync(FIX)
  .filter((f) => f.endsWith(".json"))
  .sort();
const load = (
  f: string,
): Record<
  string,
  any // eslint-disable-line @typescript-eslint/no-explicit-any
> => JSON.parse(readFileSync(join(FIX, f), "utf8"));

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sd-sl-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const lines = (b: Buffer): string[] => b.toString("utf8").split("\n").filter(Boolean);
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
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

describe("R1.9 statusline fixtures", () => {
  it("has fixtures", () => expect(fixtureFiles.length).toBe(20));
  for (const f of fixtureFiles) {
    it(`${f}: exit 0, one line with state, ctx and 5h, spool line appended`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-f-"));
      try {
        const raw = readFileSync(join(FIX, f));
        const sid = JSON.parse(raw.toString("utf8")).session_id as string;
        // Without a hook line for the session: n/a.
        const r = await run(raw, h);
        expect(r.code).toBe(0);
        const out = lines(r.stdout);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/^n\/a \| /);
        // With a preceding PermissionRequest hook line: waiting_permission.
        seedHook(h, sid, "PermissionRequest");
        const r2 = await run(raw, h);
        expect(lines(r2.stdout)[0]).toMatch(/^waiting_permission \| /);
        expect(out[0]).toContain("ctx");
        expect(out[0]).toContain("5h");
        expect(r.stderr.length).toBe(0);
        const sp = readSpoolLines(join(h, "spool"));
        const r0 = parseSpoolLine(sp[0] as string);
        const parsed = r0.ok ? r0.line : null;
        expect(parsed?.kind).toBe("statusline");
        expect(parsed?.host).toBe("testhost");
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }

  it("rate_limits with a future reset shows numbers", async () => {
    const p = load("16-max-five-hour.json");
    p.rate_limits.five_hour = { used_percentage: 78, resets_at: future };
    p.rate_limits.seven_day = { used_percentage: 35, resets_at: future };
    const r = await run(JSON.stringify(p), home);
    expect(lines(r.stdout)[0]).toMatch(/^n\/a \| .*\| ctx 38% \| 5h 78% \| 7d 35%/);
    expect(lines(r.stdout)[0]).toContain("Fable 5.1");
  });

  it("stale resets_at shows n/a", async () => {
    const p = load("16-max-five-hour.json");
    p.rate_limits.five_hour = { used_percentage: 78, resets_at: past };
    const r = await run(JSON.stringify(p), home);
    expect(lines(r.stdout)[0]).toContain("5h n/a");
  });

  it("absent rate_limits shows 5h n/a", async () => {
    const p = load("16-max-five-hour.json");
    delete p.rate_limits;
    const r = await run(JSON.stringify(p), home);
    expect(lines(r.stdout)[0]).toContain("5h n/a");
  });
});

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
  it.skipIf(process.platform !== "win32")("non-ASCII model name survives", async () => {
    const r = await run(JSON.stringify({ session_id: "s", model: "Modèle 日本語" }), home);
    expect(r.stdout.toString("utf8")).toContain("Modèle 日本語");
  });
});

const FALLBACK = "sessiondeck\n";

describe("robustness (both entries)", () => {
  const bad: [string, Buffer | string | null][] = [
    ["empty", ""],
    ["closed stdin", null],
    ["malformed", "{not json"],
    ["array", "[]"],
    ["invalid utf-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["1 MB junk", Buffer.alloc(1024 * 1024, "x")],
    ["1 MB valid object", JSON.stringify({ session_id: "s", pad: "x".repeat(1024 * 1024) })],
  ];
  for (const [name, input] of bad) {
    it(`statusline: ${name} -> fallback line, exit 0`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-b-"));
      try {
        const r = await run(input, h);
        expect(r.code).toBe(0);
        if (name === "1 MB valid object") expect(lines(r.stdout)[0]).toContain("ctx");
        else expect(r.stdout.toString()).toBe(FALLBACK);
        expect(r.stderr.length).toBe(0);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
    it(`subagents: ${name} -> nothing, exit 0`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sa-b-"));
      try {
        const r = await run(input, h, subagentsPath);
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
        expect(r.stderr.length).toBe(0);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }

  it("unwritable home (a file) -> still prints, exit 0", async () => {
    const h = mkdtempSync(join(tmpdir(), "sd-sl-u-"));
    const file = join(h, "notadir");
    writeFileSync(file, "x");
    try {
      const p = JSON.stringify({ session_id: "s", model: "M" });
      const a = await run(p, file);
      expect(a.code).toBe(0);
      expect(lines(a.stdout)[0]).toContain("ctx");
      const b = await run(p, file, subagentsPath);
      expect(b.code).toBe(0);
      expect(b.stdout.length).toBe(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  for (const [label, script, expectOut] of [
    ["statusline", statuslinePath, FALLBACK],
    ["subagents", subagentsPath, ""],
  ] as const) {
    it(`${label}: never-closing stdin is bounded`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-h-"));
      try {
        const t0 = Date.now();
        const child = spawn(process.execPath, [script, "--home", h, "--host", "t"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const out: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stdin.write("{");
        const code = await new Promise((res) => child.on("close", res));
        expect(code).toBe(0);
        expect(Date.now() - t0).toBeLessThan(8000);
        expect(Buffer.concat(out).toString()).toBe(expectOut);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }
});

describe("subagents spool", () => {
  it("appends one subagents line per call and prints nothing", async () => {
    const h = mkdtempSync(join(tmpdir(), "sd-sa-"));
    try {
      const raw = readFileSync(
        join(
          fixturesDir,
          "subagentStatusLine",
          readdirSync(join(fixturesDir, "subagentStatusLine")).sort()[0] as string,
        ),
      );
      for (let i = 0; i < 2; i += 1) {
        const r = await run(raw, h, subagentsPath);
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
      }
      const sp = readSpoolLines(join(h, "spool"));
      expect(sp).toHaveLength(2);
      const r0 = parseSpoolLine(sp[0] as string);
      const p = r0.ok ? r0.line : null;
      expect(p?.kind).toBe("subagents");
      expect(p?.session_id).toBe("fdafa657-e191-4646-88ad-7ae634752456");
      expect((p?.payload as { tasks: unknown[] }).tasks.length).toBeGreaterThan(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
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

  it("mirrors the contract reduce() for a single event, per event", () => {
    const base = { session_id: sid, host: "t", cwd: "/x", ts: 1 };
    for (const ev of HOOK_EVENTS) {
      const payload = {
        session_id: sid,
        hook_event_name: ev,
        notification_type: "permission_prompt",
      };
      const env = {
        v: 1 as const,
        id: "i",
        kind: "hook" as const,
        host: "t",
        os: "linux" as const,
        session_id: sid,
        ts: 2,
        hook_event_name: ev,
        payload,
      };
      const after = reduce(createSnapshot(base), env as never);
      const mine = stateForHook(ev, payload, false);
      expect(mine ?? "starting", ev).toBe(after.state);
    }
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
