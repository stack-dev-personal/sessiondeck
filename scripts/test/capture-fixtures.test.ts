import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import { HOOK_MAX_FILES_PER_DIR } from "../lib/capture-config.mjs";
import { CAPTURE_SCRIPT, cleanupTempDirs, makeTempDir, runScript } from "./helpers";

afterAll(cleanupTempDirs);

function capture(sandbox: string, out: string, input: string, flags: string[] = []) {
  return runScript(CAPTURE_SCRIPT, [...flags, "--out", out], { input, sandbox });
}

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe.concurrent("hook mode", () => {
  it.each(HOOK_EVENTS.map((e) => [e]))("%s: one file, same content, no stdout", async (event) => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const payload = { hook_event_name: event, session_id: "sess-1234567890", extra: { n: [1, 2] } };
    const r = await capture(sandbox, out, JSON.stringify(payload));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const files = readdirSync(join(out, event));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-sess-123-[0-9a-f]+\.json$/);
    expect(readJson(join(out, event, files[0]!))).toEqual(payload);
  });

  const hostile: [string, string][] = [
    ["malformed JSON", "{not json"],
    ["empty stdin", ""],
    ["a JSON array", "[1,2]"],
    ["traversal event name", JSON.stringify({ hook_event_name: "../../evil", session_id: "s" })],
    ["drive letter event", JSON.stringify({ hook_event_name: "C:\\evil", session_id: "s" })],
    ["slash event", JSON.stringify({ hook_event_name: "a/b/c", session_id: "../../x" })],
    ["non-string event", JSON.stringify({ hook_event_name: { a: 1 }, session_id: 5 })],
  ];

  it.each(hostile)("%s: exit 0, silent, nothing outside out", async (_name, input) => {
    const sandbox = makeTempDir();
    mkdirSync(join(sandbox, "work"));
    const out = join(sandbox, "work", "out");
    const r = await capture(sandbox, out, input);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const outside = listAll(sandbox).filter(
      (p) => p !== "work" && !p.startsWith(join("work", "out")),
    );
    expect(outside).toEqual([]);
    expect(listAll(out).some((p) => p.includes("evil"))).toBe(false);
    expect(listAll(out).length).toBeGreaterThan(0);
  });

  it("saves unparsable input as text under _unparsed", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    await capture(sandbox, out, "{broken");
    const files = readdirSync(join(out, "_unparsed"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(out, "_unparsed", files[0]!), "utf8")).toBe("{broken");
  });

  it("exits 0 and stays silent when out is unwritable", async () => {
    const sandbox = makeTempDir();
    const blocker = join(sandbox, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const r = await capture(sandbox, join(blocker, "out"), '{"hook_event_name":"Stop"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
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

  it("stops writing a directory at the file cap", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    mkdirSync(join(out, "Stop"), { recursive: true });
    for (let i = 0; i < HOOK_MAX_FILES_PER_DIR; i++) {
      writeFileSync(join(out, "Stop", `${i}-x.json`), "{}");
    }
    const r = await capture(sandbox, out, '{"hook_event_name":"Stop","session_id":"a"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readdirSync(join(out, "Stop"))).toHaveLength(HOOK_MAX_FILES_PER_DIR);
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

describe("statusline and subagent modes", () => {
  const status = (extra: object = {}) =>
    JSON.stringify({ session_id: "sl-session-1", model: { id: "m" }, ...extra });

  it("statusline prints exactly one line and writes a file", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const r = await capture(sandbox, out, status({ prompt: "SECRET-PROMPT" }), ["--statusline"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^[^\r\n]+\r?\n$/);
    expect(r.stdout).not.toContain("SECRET-PROMPT");
    expect(readdirSync(join(out, "statusLine"))).toHaveLength(1);
  });

  it("statusline still prints one line on garbage input", async () => {
    const sandbox = makeTempDir();
    const r = await capture(sandbox, join(sandbox, "out"), "nope", ["--statusline"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("throttles per session but records when keys or rate_limits change", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const count = () => readdirSync(join(out, "statusLine")).length;
    const run = (extra: object) => capture(sandbox, out, status(extra), ["--statusline"]);
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

  it("subagents mode prints nothing and writes under subagentStatusLine", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const r = await capture(sandbox, out, status(), ["--subagents"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readdirSync(join(out, "subagentStatusLine"))).toHaveLength(1);
  });
});
