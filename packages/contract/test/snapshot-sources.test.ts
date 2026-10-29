import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FIGURE_SOURCES,
  SUBAGENT_FIGURE_SOURCES,
  createSnapshot,
  isFigureSource,
  isSubagentFigureSource,
  mergeSource,
  type SnapshotSources,
  type SubagentFigureSource,
  type SubagentSnapshot,
} from "../src/index";

describe("FIGURE_SOURCES and isFigureSource", () => {
  it("lists statusline and transcript", () => {
    expect([...FIGURE_SOURCES]).toEqual(["statusline", "transcript"]);
  });

  it("accepts known sources and rejects everything else", () => {
    expect(isFigureSource("statusline")).toBe(true);
    expect(isFigureSource("transcript")).toBe(true);
    expect(isFigureSource("hook")).toBe(false);
    expect(isFigureSource("")).toBe(false);
    expect(isFigureSource(null)).toBe(false);
    expect(isFigureSource(undefined)).toBe(false);
    expect(isFigureSource(1)).toBe(false);
  });
});

describe("SubagentSnapshot figures_source and effort (R2.13)", () => {
  it("lists subagent_statusline and transcript", () => {
    expect([...SUBAGENT_FIGURE_SOURCES]).toEqual(["subagent_statusline", "transcript"]);
  });

  it("guards subagent sources", () => {
    expect(isSubagentFigureSource("subagent_statusline")).toBe(true);
    expect(isSubagentFigureSource("transcript")).toBe(true);
    expect(isSubagentFigureSource("statusline")).toBe(false);
    expect(isSubagentFigureSource(null)).toBe(false);
    expect(isSubagentFigureSource(2)).toBe(false);
  });

  it("types figures_source and effort as optional", () => {
    expectTypeOf<SubagentSnapshot["figures_source"]>().toEqualTypeOf<
      SubagentFigureSource | undefined
    >();
    expectTypeOf<SubagentSnapshot["effort"]>().toEqualTypeOf<string | null | undefined>();
    const row: SubagentSnapshot = {
      agent_id: "a",
      agent_type: "t",
      started_at: 1,
      ended_at: null,
      tokens: null,
      context_window: null,
      model: null,
    };
    expect(row.effort).toBeUndefined();
  });
});

describe("mergeSource", () => {
  it("returns a new object and does not mutate the input", () => {
    const before: SnapshotSources = { model: "statusline" };
    const frozen = Object.freeze({ ...before });
    const after = mergeSource(frozen, "cost", "transcript");
    expect(after).not.toBe(frozen);
    expect(after).toEqual({ model: "statusline", cost: "transcript" });
    expect(frozen).toEqual({ model: "statusline" });
  });

  it("starts from undefined", () => {
    expect(mergeSource(undefined, "context", "transcript")).toEqual({ context: "transcript" });
  });

  it("lets statusline win over transcript, never the reverse", () => {
    const fromTranscript = mergeSource({ model: "transcript" }, "model", "statusline");
    expect(fromTranscript.model).toBe("statusline");
    const kept = mergeSource({ model: "statusline" }, "model", "transcript");
    expect(kept.model).toBe("statusline");
  });
});

describe("createSnapshot and sources", () => {
  it("has no sources key", () => {
    const snap = createSnapshot({ session_id: "s", host: "h", cwd: "c", ts: 1 });
    expect("sources" in snap).toBe(false);
  });
});
