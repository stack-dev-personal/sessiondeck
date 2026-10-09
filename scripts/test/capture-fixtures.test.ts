import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import {
  HOOK_MAX_FILES_PER_DIR,
  STATUSLINE_FULL_TEXT,
  STATUSLINE_TEXT,
} from "../lib/capture-config.mjs";
import { captureOnce } from "../lib/capture-core.mjs";
import { CAPTURE_SCRIPT, cleanupTempDirs, makeTempDir, runScript } from "./helpers";

afterAll(cleanupTempDirs);

type Mode = "hook" | "statusline" | "subagents";
const NOW = 1_700_000_000_000;

function capture(sandbox: string, out: string, input: string, flags: string[] = []) {
  return runScript(CAPTURE_SCRIPT, [...flags, "--out", out], { input, sandbox });
}

/** In-process capture for per-case checks; the spawned tests below prove the entry point. */
function captureIn(out: string, text: string, mode: Mode = "hook", now = Date.now()) {
  return captureOnce({ mode, out, text, truncated: false, now });
}

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const status = (extra: object = {}) =>
  JSON.stringify({ session_id: "sl-session-1", model: { id: "m" }, ...extra });

describe("every registered event is stored in-process", () => {
  it.each(HOOK_EVENTS.map((e) => [e]))("%s: one file, same content", async (event) => {
    const out = join(makeTempDir(), "out");
    const payload = { hook_event_name: event, session_id: "sess-1234567890", extra: { n: [1, 2] } };
    await captureIn(out, JSON.stringify(payload));
    const files = readdirSync(join(out, event));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-sess-123-[0-9a-f]+\.json$/);
    expect(readJson(join(out, event, files[0]!))).toEqual(payload);
  });
});

describe("hostile input in-process", () => {
  const hostile: [string, string][] = [
    ["malformed JSON", "{not json"],
    ["empty stdin", ""],
    ["a JSON array", "[1,2]"],
    ["traversal event name", JSON.stringify({ hook_event_name: "../../evil", session_id: "s" })],
    ["drive letter event", JSON.stringify({ hook_event_name: "C:\\evil", session_id: "s" })],
    ["slash event", JSON.stringify({ hook_event_name: "a/b/c", session_id: "../../x" })],
    ["non-string event", JSON.stringify({ hook_event_name: { a: 1 }, session_id: 5 })],
  ];

  it.each(hostile)("%s: nothing outside out", async (_name, input) => {
    const sandbox = makeTempDir();
    mkdirSync(join(sandbox, "work"));
    const out = join(sandbox, "work", "out");
    await captureIn(out, input);
    const outside = listAll(sandbox).filter(
      (p) => p !== "work" && !p.startsWith(join("work", "out")),
    );
    expect(outside).toEqual([]);
    expect(listAll(out).some((p) => p.includes("evil"))).toBe(false);
    expect(listAll(out).length).toBeGreaterThan(0);
  });
});

describe("caps and the visible full state", () => {
  it("allows at least 3000 files per event; the byte budget is the real bound", () => {
    expect(HOOK_MAX_FILES_PER_DIR).toBeGreaterThanOrEqual(3000);
  });

  it("status-line mode reports full once ANY hook directory cap has refused a write", async () => {
    const out = join(makeTempDir(), "out");
    expect((await captureIn(out, status(), "statusline", NOW)).full).toBe(false);
    // The line a refused PreToolUse write leaves (capture-hardening.test.ts proves a real cap writes it).
    writeFileSync(
      join(out, "_capture-errors.log"),
      `${new Date().toISOString()} full-cap-PreToolUse FULL
`,
    );
    const later = status({ session_id: "other" });
    expect((await captureIn(out, later, "statusline", NOW)).full).toBe(true);
    expect((await captureIn(out, later, "statusline", NOW)).full).toBe(true);
  });

  it("an unrelated error-log line does not make the status line say full", async () => {
    const out = join(makeTempDir(), "out");
    mkdirSync(out);
    writeFileSync(join(out, "_capture-errors.log"), "2026-01-01T00:00:00.000Z capture EACCES\n");
    expect((await captureIn(out, status(), "statusline", NOW)).full).toBe(false);
  });
});

describe("hook mode (spawned)", () => {
  it("exits 0 with no stdout and stores one file", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const payload = { hook_event_name: "PostToolUse", session_id: "sess-1234567890" };
    const r = await capture(sandbox, out, JSON.stringify(payload));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    const files = readdirSync(join(out, "PostToolUse"));
    expect(files).toHaveLength(1);
    expect(readJson(join(out, "PostToolUse", files[0]!))).toEqual(payload);
  });

  it("hostile input: exit 0, silent, nothing outside out", async () => {
    const sandbox = makeTempDir();
    mkdirSync(join(sandbox, "work"));
    const out = join(sandbox, "work", "out");
    const r = await capture(sandbox, out, JSON.stringify({ hook_event_name: "../../evil" }));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    const outside = listAll(sandbox).filter(
      (p) => p !== "work" && !p.startsWith(join("work", "out")),
    );
    expect(outside).toEqual([]);
  });

  it("saves unparsable input as text under _unparsed", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const r = await capture(sandbox, out, "{broken");
    expect(r.code).toBe(0);
    const files = readdirSync(join(out, "_unparsed"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(out, "_unparsed", files[0]!), "utf8")).toBe("{broken");
  });

  it("exits 0 and stays silent on stdout and stderr when out is unwritable", async () => {
    const sandbox = makeTempDir();
    const blocker = join(sandbox, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const r = await capture(sandbox, join(blocker, "out"), '{"hook_event_name":"Stop"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("logs errors without payload content", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    mkdirSync(out);
    // A file where the event directory should be makes the write fail.
    writeFileSync(join(out, "Stop"), "x");
    const r = await capture(sandbox, out, '{"hook_event_name":"Stop","prompt":"SECRET-PROMPT"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const log = readFileSync(join(out, "_capture-errors.log"), "utf8");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain("SECRET-PROMPT");
  });

  it("honours SESSIONDECK_CAPTURE_DIR when --out is absent", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "envout");
    const r = await runScript(CAPTURE_SCRIPT, [], {
      sandbox,
      input: '{"hook_event_name":"Stop","session_id":"a"}',
      env: { SESSIONDECK_CAPTURE_DIR: out },
    });
    expect(r.code).toBe(0);
    expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
  });

  it("50 concurrent hooks produce 50 intact distinct files", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const payloads = Array.from({ length: 50 }, (_, i) => ({
      hook_event_name: "PostToolUse",
      session_id: "same-session",
      i,
    }));
    const results = await Promise.all(
      payloads.map((p) => capture(sandbox, out, JSON.stringify(p))),
    );
    expect(results.every((r) => r.code === 0 && r.stdout === "")).toBe(true);
    const dir = join(out, "PostToolUse");
    const files = readdirSync(dir);
    expect(files).toHaveLength(50);
    expect(files.every((f) => f.endsWith(".json"))).toBe(true);
    const seen = files
      .map((f) => (readJson(join(dir, f)) as { i: number }).i)
      .sort((a, b) => a - b);
    expect(seen).toEqual(payloads.map((p) => p.i));
  });
});

describe("statusline and subagent modes (spawned)", () => {
  it("statusline prints exactly one line and writes a file", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const r = await capture(sandbox, out, status({ prompt: "SECRET-PROMPT" }), ["--statusline"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^[^\r\n]+\r?\n$/);
    expect(r.stdout.trim()).toBe(STATUSLINE_TEXT);
    expect(r.stdout).not.toContain("SECRET-PROMPT");
    expect(readdirSync(join(out, "statusLine"))).toHaveLength(1);
  });

  it("statusline still prints one line on garbage input", async () => {
    const sandbox = makeTempDir();
    const r = await capture(sandbox, join(sandbox, "out"), "nope", ["--statusline"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("prints the full text once a hook directory cap has refused a write", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    mkdirSync(out);
    writeFileSync(
      join(out, "_capture-errors.log"),
      `${new Date().toISOString()} full-cap-Stop FULL
`,
    );
    const r = await capture(sandbox, out, status(), ["--statusline"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(STATUSLINE_FULL_TEXT);
  });

  it("subagents mode prints nothing and writes under subagentStatusLine", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const r = await capture(sandbox, out, status(), ["--subagents"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readdirSync(join(out, "subagentStatusLine"))).toHaveLength(1);
  });
});

describe("status throttle in-process", () => {
  it("throttles per session but records when keys or rate_limits change", async () => {
    const out = join(makeTempDir(), "out");
    const count = () => readdirSync(join(out, "statusLine")).length;
    const run = (extra: object) => captureIn(out, status(extra), "statusline", NOW);
    await run({});
    await run({});
    expect(count()).toBe(1);
    await run({ rate_limits: { five_hour: {} } });
    expect(count()).toBe(2);
    await run({ rate_limits: { five_hour: {} } });
    expect(count()).toBe(2);
    await run({ rate_limits: null, brand_new_key: 1 });
    expect(count()).toBe(3);
    await run({ session_id: "another-session" });
    expect(count()).toBe(4);
  });
});
