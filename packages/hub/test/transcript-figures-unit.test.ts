import { describe, expect, it } from "vitest";
import { createSnapshot, reduce, type Envelope } from "@sessiondeck/contract";
import { truncateMessage, applyFigures, applyCost } from "../src/derive/apply.ts";
import { EMPTY_FIGURES, foldBackward, foldForward, readRow } from "../src/derive/figures.ts";

const assistant = (over: Record<string, unknown>): string =>
  JSON.stringify({
    type: "assistant",
    gitBranch: "b1",
    message: {
      model: "claude-x",
      usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5 },
      content: [{ type: "text", text: "hello" }],
    },
    ...over,
  });

describe("last_assistant_message cap mirrors the contract", () => {
  const stop = (text: string): string | null => {
    const snap = createSnapshot({ session_id: "s", host: "h", cwd: "/", ts: 1 });
    const env = {
      v: 1,
      id: "i",
      kind: "hook",
      host: "h",
      os: "linux",
      session_id: "s",
      hook_event_name: "Stop",
      ts: 2,
      seq: 1,
      payload: { session_id: "s", hook_event_name: "Stop", last_assistant_message: text },
    } as unknown as Envelope<"hook">;
    return reduce(snap, env).last_assistant_message;
  };
  it.each([
    ["short", "abc"],
    ["exact", "x".repeat(2000)],
    ["over", "y".repeat(5000)],
    ["split surrogate", `${"z".repeat(1985)}\u{1F600}${"w".repeat(100)}`],
  ])("%s", (_n, text) => {
    expect(truncateMessage(text)).toBe(stop(text));
  });
});

describe("readRow", () => {
  it("reads the facts of an assistant row", () => {
    const r = readRow(assistant({}), () => undefined);
    expect(r).toEqual({
      branch: "b1",
      model: "claude-x",
      contextTokens: 12,
      message: "hello",
      effort: null,
    });
  });
  it("ignores synthetic and sidechain rows (branch aside)", () => {
    const syn = assistant({ message: { model: "<synthetic>", content: [] } });
    expect(readRow(syn, () => undefined).model).toBeNull();
    expect(readRow(assistant({ isSidechain: true }), () => undefined).model).toBeNull();
  });
  it("counts malformed assistant-looking lines and never throws", () => {
    let n = 0;
    expect(readRow('{"type":"assistant", nope', () => n++).model).toBeNull();
    expect(n).toBe(1);
  });
  it("a text-less assistant row keeps the previous text", () => {
    const lines = [
      { line_no: 0, raw: assistant({}) },
      {
        line_no: 1,
        raw: assistant({ message: { model: "claude-y", content: [{ type: "tool_use" }] } }),
      },
    ];
    const f = foldForward(EMPTY_FIGURES, lines).figures;
    expect(f.message).toBe("hello");
    expect(f.model).toBe("claude-y");
    expect(f.maxLine).toBe(1);
  });
  it("backward and forward folds agree", () => {
    const lines = [
      { line_no: 0, raw: assistant({ gitBranch: "old" }) },
      { line_no: 1, raw: '{"type":"user","gitBranch":"mid"}' },
      {
        line_no: 2,
        raw: assistant({ message: { model: "claude-y", content: [{ type: "tool_use" }] } }),
      },
    ];
    const fwd = foldForward(EMPTY_FIGURES, lines).figures;
    const back = foldBackward(EMPTY_FIGURES, [...lines].reverse()).figures;
    expect(back).toEqual(fwd);
  });
});

describe("apply", () => {
  const base = createSnapshot({ session_id: "s", host: "h", cwd: "/", ts: 1 });
  it("returns the same object when nothing changes", () => {
    const f = foldForward(EMPTY_FIGURES, [{ line_no: 0, raw: assistant({}) }]).figures;
    const once = applyFigures(base, f);
    expect(applyFigures(once, f)).toBe(once);
    expect(applyCost(applyCost(once, 1.5), 1.5).cost.usd).toBe(1.5);
  });
  it("does not touch statusline-owned fields", () => {
    const owned = {
      ...base,
      model: { id: "live", display_name: "Live" },
      sources: { model: "statusline" as const, cost: "statusline" as const },
    };
    const f = foldForward(EMPTY_FIGURES, [{ line_no: 0, raw: assistant({}) }]).figures;
    expect(applyFigures(owned, f).model).toEqual(owned.model);
    expect(applyCost(owned, 9)).toBe(owned);
  });
});
