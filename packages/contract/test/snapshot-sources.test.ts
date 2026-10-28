import { describe, expect, it } from "vitest";
import {
  FIGURE_SOURCES,
  createSnapshot,
  isFigureSource,
  mergeSource,
  type SnapshotSources,
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
