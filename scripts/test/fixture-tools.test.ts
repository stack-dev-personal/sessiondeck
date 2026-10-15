import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listEvents, readEvent, keysOf } from "../lib/fixture-files.mjs";
import { buildInventory, collectShapes } from "../lib/fixture-inventory-core.mjs";
import { listFixtureFiles } from "../lib/fixture-leak-core.mjs";
import {
  groupKey,
  pickExtras,
  pickGolden,
  pickHookGroups,
  pickStatusLine,
  pickSubagentStatus,
} from "../lib/fixture-select.mjs";
import { buildSynthetic } from "../lib/fixture-synthetic.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";
import { INVENTORY, LEAK, SCRUB, SID_A, makeRaw, runNode } from "./fixture-raw-helpers";

afterEach(cleanupTempDirs);

describe("fixture-files", () => {
  it("lists event dirs sorted, skipping _state and dot entries, and reads in capture order", () => {
    const raw = makeRaw();
    writeFileSync(join(raw, ".gitignore"), "*");
    expect(listEvents(raw)).toEqual([
      "PostCompact",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
      "statusLine",
      "subagentStatusLine",
    ]);
    expect(listEvents(join(raw, "nope"))).toEqual([]);
    const { items, bad } = readEvent(raw, "SessionStart");
    expect(items.map((i) => i.epoch)).toEqual([10, 15]);
    expect(bad).toBe(0);
  });

  it("counts unreadable files instead of throwing", () => {
    const raw = makeRaw();
    writeFileSync(join(raw, "Stop", "5-abc-x.json"), "{not json");
    expect(readEvent(raw, "Stop").bad).toBe(1);
  });

  it("keysOf returns sorted key names and nothing for non-objects", () => {
    expect(keysOf({ b: 1, a: 2 })).toEqual(["a", "b"]);
    expect(keysOf([1])).toEqual([]);
    expect(keysOf(null)).toEqual([]);
  });
});

describe("inventory", () => {
  it("prints event, count and key sets without any value", () => {
    const raw = makeRaw();
    const { text, total } = buildInventory(raw);
    expect(total).toBe(17);
    expect(text).toContain("SessionStart\t2");
    expect(text).toContain("  1\t[cwd,hook_event_name,model,session_id,source,transcript_path]");
    expect(text).not.toContain("private");
    expect(text).not.toContain("echo secret");
    expect(text).not.toContain("zed");
  });

  it("reports unreadable files and lists shapes with value types only", () => {
    const raw = makeRaw();
    writeFileSync(join(raw, "Stop", "5-abc-x.json"), "{not json");
    const { text } = buildInventory(raw, { shapes: true });
    expect(text).toContain("(1 unreadable)");
    expect(text).toContain("    ~ tool_input.command: string");
    expect(text).not.toContain("secret");
  });

  it("masks key names that are content when listing shapes", () => {
    const out = new Set<string>();
    collectShapes(
      { answers: { "Which database should we use?": "pg" }, list: [], arr: [{ a: 1 }] },
      "",
      out,
    );
    expect([...out].sort()).toEqual([
      "answers.<key>: string",
      "answers: object",
      "arr: array",
      "arr[].a: number",
      "list: array",
      "list[]: empty",
    ]);
  });

  it("CLI prints the inventory, and exits 2 for a missing directory", () => {
    const raw = makeRaw();
    const ok = runNode(INVENTORY, [raw]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("TOTAL\t17");
    const missing = runNode(INVENTORY, [join(raw, "nope")]);
    expect(missing.status).toBe(2);
  });
});

describe("selection", () => {
  it("groupKey splits tool events by tool, input shape and discriminators", () => {
    const a = groupKey("PreToolUse", { tool_name: "Bash", tool_input: { command: "x" } });
    const b = groupKey("PreToolUse", { tool_name: "Read", tool_input: { command: "x" } });
    const c = groupKey("PreToolUse", { tool_name: "mcp__s__t", tool_input: {} });
    const d = groupKey("PreToolUse", { tool_name: "mcp__other__t", tool_input: {} });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c).toBe(d);
    expect(groupKey("SessionEnd", { reason: "clear" })).not.toBe(
      groupKey("SessionEnd", { reason: "other" }),
    );
    expect(groupKey("SubagentStop", { agent_type: "" })).not.toBe(
      groupKey("SubagentStop", { agent_type: "x" }),
    );
    expect(groupKey("PostToolUseFailure", { is_interrupt: true })).not.toBe(
      groupKey("PostToolUseFailure", { is_interrupt: false }),
    );
    expect(groupKey("PostToolUse", { tool_response: "s" })).not.toBe(
      groupKey("PostToolUse", { tool_response: [] }),
    );
  });

  it("pickHookGroups takes one smallest representative per group, in a stable order", () => {
    const mk = (n: number, extra: object) => ({
      file: `${n}-a-b.json`,
      epoch: n,
      short: "a",
      payload: { k: 1, ...extra },
    });
    const items = [mk(1, { v: "xxxxxxxx" }), mk(2, { v: "x" }), mk(3, { other: 1 })];
    const picks = pickHookGroups("Stop", items);
    expect(picks.map((p) => p.item.epoch).sort()).toEqual([2, 3]);
    expect(pickHookGroups("Stop", [])).toEqual([]);
  });

  it("pickExtras finds an interrupted PostToolUse and the Stop after an AskUserQuestion", () => {
    const raw = makeRaw();
    const byEvent = new Map(listEvents(raw).map((e) => [e, readEvent(raw, e).items]));
    const extras = pickExtras(byEvent);
    expect(extras.map((e) => `${e.dir}:${e.tag}`).sort()).toEqual([
      "PostToolUse:interrupted",
      "Stop:after-ask",
    ]);
    expect(pickExtras(new Map())).toEqual([]);
  });

  it("pickGolden needs a session that starts with SessionStart and ends with SessionEnd", () => {
    const raw = makeRaw();
    const hooks = new Map(
      listEvents(raw)
        .filter((e) => !e.endsWith("tatusLine"))
        .map((e) => [e, readEvent(raw, e).items]),
    );
    const golden = pickGolden(hooks, 400);
    expect(golden?.sessionId).toBe(SID_A);
    expect(golden?.events.map((e) => e.event)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostCompact",
      "Stop",
      "SessionEnd",
    ]);
    expect(pickGolden(hooks, 3)).toBeNull();
  });

  it("pickStatusLine covers max usage, null usage, key sets and fills up to the wanted count", () => {
    const raw = makeRaw();
    const status = readEvent(raw, "statusLine").items;
    const compacts = readEvent(raw, "PostCompact").items;
    const picks = pickStatusLine(status, compacts, 4);
    expect(picks).toHaveLength(4);
    expect(picks[0]?.tag).toBe("max-used");
    expect(picks.some((p) => p.tag === "usage-null")).toBe(true);
    expect(new Set(picks.map((p) => p.item.file)).size).toBe(4);
    expect(pickStatusLine(status, compacts, 20)).toHaveLength(6);
    expect(pickStatusLine([], [], 20)).toEqual([]);
  });

  it("pickSubagentStatus prefers distinct row counts and fills with earliest", () => {
    const raw = makeRaw();
    const items = readEvent(raw, "subagentStatusLine").items;
    expect(pickSubagentStatus(items, 2).map((p) => p.tag)).toEqual(["rows-2", "rows-0"]);
    expect(pickSubagentStatus(items, 3)).toHaveLength(3);
  });
});

describe("buildSynthetic", () => {
  it("builds the four uncaptured events from a template, copying only common fields", () => {
    const template = {
      session_id: "s",
      cwd: "<HOME>",
      prompt: "<TEXT 3>",
      hook_event_name: "UserPromptSubmit",
    };
    const out = buildSynthetic(template);
    expect(out.map((o) => o.event)).toEqual([
      "TaskCreated",
      "TaskCompleted",
      "PermissionDenied",
      "StopFailure",
    ]);
    for (const o of out) {
      expect(o.payload["hook_event_name"]).toBe(o.event);
      expect(o.payload["session_id"]).toBe("s");
      expect(o.payload["prompt"]).toBeUndefined();
    }
    expect(out[3]?.payload["error"]).toBe("rate_limit");
  });
});

describe("scrub CLI end to end", () => {
  it("writes a clean, deterministic set from a raw directory and never touches raw", () => {
    const raw = makeRaw();
    const before = JSON.stringify(readdirSync(raw).sort());
    const outA = makeTempDir();
    const outB = makeTempDir();
    const a = runNode(SCRUB, ["--raw", raw, "--out", outA]);
    const b = runNode(SCRUB, ["--raw", raw, "--out", outB]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const files = listFixtureFiles(outA);
    expect(files.length).toBeGreaterThan(10);
    const names = files.map((f) => f.slice(outA.length));
    expect(names.map((n) => n.split("\\").join("/"))).toContain("/sessions/golden-session.jsonl");
    for (const f of files)
      expect(readFileSync(f, "utf8")).toBe(readFileSync(f.replace(outA, outB), "utf8"));
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).not.toContain("private thing");
    expect(all).not.toContain("echo secret");
    expect(all).not.toContain("zed");
    expect(all).not.toContain("alpha");
    expect(all).not.toContain(SID_A);
    expect(JSON.stringify(readdirSync(raw).sort())).toBe(before);
    expect(readdirSync(join(raw, "Stop")).length).toBe(1);
    // The output passes the leak check, with literals derived from the raw directory.
    const leak = runNode(LEAK, [outA, "--raw", raw]);
    expect(leak.stdout).toContain("PASS");
    expect(leak.status).toBe(0);
  });

  it("refuses to write inside the raw directory and fails on a missing raw directory", () => {
    const raw = makeRaw();
    const inside = runNode(SCRUB, ["--raw", raw, "--out", join(raw, "out")]);
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain("must not be inside the raw directory");
    const missing = runNode(SCRUB, ["--raw", join(raw, "nope"), "--out", makeTempDir()]);
    expect(missing.status).toBe(1);
  });
});
