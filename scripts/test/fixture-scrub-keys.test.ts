import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRIGGER_HINTS } from "../lib/fixture-inventory-core.mjs";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import { byCapture, pickGolden } from "../lib/fixture-select.mjs";
import { Scrubber } from "../lib/fixture-scrub-core.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";
import { INVENTORY, SCRUB, SID_A, makeRaw, runNode } from "./fixture-raw-helpers";

afterEach(cleanupTempDirs);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

describe("Scrubber key names are default-deny", () => {
  it("keeps known keys and replaces others with <KEY_n>, reporting paths without names", () => {
    const s = new Scrubber();
    const out = s.value({
      hook_event_name: "Stop",
      workspace: { repos: { "my-private-repo": { name: "x" } }, current_dir: "<HOME>" },
      mcp_servers: ["a"],
      "other-thing": 1,
    }) as Out;
    expect(Object.keys(out)).toEqual(["hook_event_name", "workspace", "<KEY_1>", "<KEY_2>"]);
    expect(Object.keys(out.workspace)).toEqual(["<KEY_1>", "current_dir"]);
    expect(Object.keys(out.workspace["<KEY_1>"])).toEqual(["<KEY_1>"]);
    expect(JSON.stringify(out)).not.toContain("my-private-repo");
    expect(JSON.stringify(out)).not.toContain("other-thing");
    expect([...s.unknownKeys.keys()].sort()).toEqual([
      "<KEY_1>",
      "<KEY_2>",
      "workspace.<KEY_1>",
      "workspace.<key>.<KEY_1>",
    ]);
  });

  it("denies the values below an unknown key, since no keep rule can match", () => {
    const out = new Scrubber().value({ widget: { source: "startup", reason: "other" } }) as Out;
    expect(out["<KEY_1>"]).toEqual({ source: "<TEXT 7>", reason: "<TEXT 5>" });
  });

  it("still maps identifier-unsafe and user-keyed names to <TEXT n> without reporting them", () => {
    const s = new Scrubber();
    const out = s.value({ answers: { "which database?": "a" }, "weird key!": 1 }) as Out;
    expect(Object.keys(out.answers)).toEqual(["<TEXT 15>"]);
    expect(Object.keys(out)).toContain("<TEXT 10>");
    expect(s.unknownKeys.size).toBe(0);
  });
});

describe("Scrubber numbers and tool-scoped enums", () => {
  it("zeroes numbers under id-like and account-like keys, keeps other numbers", () => {
    const out = new Scrubber().value({
      session_name: "<TEXT 1>",
      tool_response: { tabId: 1360566803, taskId: 5, duration_ms: 1234 },
      workspace: { repo: { owner: 77 } },
      rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1760000000 } },
      cost: { total_cost_usd: 0.25 },
      project_id: 9,
    }) as Out;
    expect(out.tool_response).toEqual({ tabId: 0, taskId: 0, duration_ms: 1234 });
    expect(out.workspace.repo.owner).toBe(0);
    expect(out.project_id).toBe(0);
    expect(out.rate_limits.five_hour).toEqual({ used_percentage: 12.5, resets_at: 1760000000 });
    expect(out.cost.total_cost_usd).toBe(0.25);
  });

  it("keeps tool_response enums for built-in tools only", () => {
    const s = new Scrubber();
    const builtin = s.value({ tool_name: "Bash", tool_response: { status: "async_launched" } });
    const custom = s.value({
      tool_name: "mcp__srv__tool",
      tool_response: { status: "private-project-slug", type: "text" },
    }) as Out;
    expect(builtin).toEqual({ tool_name: "Bash", tool_response: { status: "async_launched" } });
    expect(custom.tool_response).toEqual({ status: "<TEXT 20>", type: "<TEXT 4>" });
  });

  it("keeps content block kinds from a closed set for every tool", () => {
    const out = new Scrubber().value({
      tool_name: "mcp__srv__tool",
      tool_response: [
        { type: "text", text: "secret" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        { type: "my-private-kind" },
      ],
    }) as Out;
    expect(out.tool_response[0]).toEqual({ type: "text", text: "<TEXT 6>" });
    expect(out.tool_response[1].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "<TEXT 3>",
    });
    expect(out.tool_response[2]).toEqual({ type: "<TEXT 15>" });
  });

  it("keeps only the built-in output style names", () => {
    const s = new Scrubber();
    expect(s.value({ output_style: { name: "Explanatory" } })).toEqual({
      output_style: { name: "Explanatory" },
    });
    expect(s.value({ output_style: { name: "My Private Style" } })).toEqual({
      output_style: { name: "<TEXT 16>" },
    });
  });
});

describe("fixture-scrub CLI", () => {
  function rawWithUnknownKey(): string {
    const raw = makeRaw();
    writeFileSync(
      join(raw, "Stop", "55-11111111-unk.json"),
      JSON.stringify({
        session_id: SID_A,
        hook_event_name: "Stop",
        workspace: { repos: { "my-private-repo": 1 } },
      }),
    );
    return raw;
  }

  it("exits 1 after writing, listing key paths and never key names", () => {
    const out = makeTempDir();
    const r = runNode(SCRUB, ["--raw", rawWithUnknownKey(), "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("UNKNOWN KEYS");
    expect(r.stderr).toContain("workspace.<KEY_1>");
    expect(r.stdout + r.stderr).not.toContain("my-private-repo");
    expect(readFileSync(join(out, "sessions", "golden-session.jsonl"), "utf8")).not.toContain(
      "my-private-repo",
    );
  });

  it("exits 0 when every key is known", () => {
    expect(runNode(SCRUB, ["--raw", makeRaw(), "--out", makeTempDir()]).status).toBe(0);
  });
});

describe("golden session tie-break", () => {
  const item = (file: string, epoch: number, sid = "s1") => ({
    file,
    epoch,
    short: "",
    payload: { session_id: sid },
  });

  it("orders events in the same millisecond by cause, not by the random file suffix", () => {
    const t = 1_000;
    const byEvent = new Map([
      ["SessionEnd", [item("1000-a-aaa.json", t)]],
      ["PostToolUse", [item("1000-a-bbb.json", t)]],
      ["Stop", [item("1000-a-ccc.json", t)]],
      ["PreToolUse", [item("1000-a-zzz.json", t)]],
      ["SessionStart", [item("1000-a-yyy.json", t)]],
      ["Notification", [item("1000-a-ddd.json", t)]],
    ]);
    const golden = pickGolden(byEvent, 100);
    expect(golden?.events.map((e) => e.event)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SessionEnd",
    ]);
  });

  it("still orders by epoch first, and by file name when event and epoch are equal", () => {
    const a = { event: "Stop", item: item("1-a-b.json", 5) };
    const b = { event: "SessionStart", item: item("1-a-a.json", 6) };
    expect(byCapture(a, b)).toBeLessThan(0);
    const c = { event: "Stop", item: item("1-a-a.json", 5) };
    expect(byCapture(a, c)).toBeGreaterThan(0);
    expect(byCapture(a, a)).toBe(0);
  });
});

describe("inventory zero-capture report", () => {
  it("lists registered events with no captures, each with a trigger hint", () => {
    const raw = makeRaw();
    mkdirSync(join(raw, "Stop"), { recursive: true });
    const r = runNode(INVENTORY, [raw]);
    const missing = r.stdout.split("\n").filter((l) => l.startsWith("NO CAPTURES\t"));
    const names = missing.map((l) => l.split("\t")[1]);
    expect(names).toEqual(
      expect.arrayContaining(["TaskCreated", "TaskCompleted", "PermissionDenied", "StopFailure"]),
    );
    expect(names).not.toContain("Stop");
    expect(missing.every((l) => /\ttrigger: \S/.test(l))).toBe(true);
  });

  it("has a hint for every registered hook event", () => {
    expect(Object.keys(TRIGGER_HINTS).sort()).toEqual([...HOOK_EVENTS].sort());
  });
});
