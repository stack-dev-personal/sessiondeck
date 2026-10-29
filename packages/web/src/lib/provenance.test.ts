import { createSnapshot, type SessionSnapshot, type SubagentSnapshot } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import { shortModel } from "./format";
import { contextModel } from "../components/Meter";
import {
  COST_LABEL,
  TRANSCRIPT_LABEL,
  contextTokensText,
  transcriptHint,
  costAria,
  fromTranscript,
  subagentFromTranscript,
} from "./provenance";

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...createSnapshot({ session_id: "s", host: "h", cwd: "/w", ts: 1 }), ...over };
}

const headless = snap({
  context: { used_pct: null, window: null, input: 94172, output: null },
  cost: { usd: 2.0868447, duration_ms: null, lines_added: null, lines_removed: null },
  sources: { context: "transcript", cost: "transcript", model: "transcript" },
});

describe("provenance", () => {
  it("fromTranscript is true only for the transcript source", () => {
    expect(fromTranscript(headless, "cost")).toBe(true);
    expect(fromTranscript(headless, "git_branch")).toBe(false);
    expect(fromTranscript(snap({ sources: { cost: "statusline" } }), "cost")).toBe(false);
    expect(fromTranscript(snap(), "cost")).toBe(false);
  });

  it("subagentFromTranscript reads figures_source", () => {
    const base: SubagentSnapshot = {
      agent_id: "a",
      agent_type: "x",
      started_at: 1,
      ended_at: null,
      tokens: 1,
      context_window: null,
      model: "m",
    };
    expect(subagentFromTranscript({ ...base, figures_source: "transcript" })).toBe(true);
    expect(subagentFromTranscript({ ...base, figures_source: "subagent_statusline" })).toBe(false);
    expect(subagentFromTranscript(base)).toBe(false);
  });

  it("labels are the exact strings", () => {
    expect(TRANSCRIPT_LABEL).toBe("from transcript");
    expect(COST_LABEL).toBe("API-equivalent");
  });

  it("cost aria names API-equivalent, adds the transcript source, and says n/a for null", () => {
    expect(costAria(headless)).toBe("API-equivalent cost $2.09, from transcript");
    expect(costAria(snap({ cost: { ...headless.cost, usd: 1.84 } }))).toBe(
      "API-equivalent cost $1.84",
    );
    expect(costAria(snap())).toBe("API-equivalent cost n/a");
  });

  it("shortModel shortens transcript model ids and display names", () => {
    expect(shortModel("claude-opus-5-5")).toBe("Opus");
    expect(shortModel("Claude Opus 4.7")).toBe("Opus");
  });

  it("null cost with a transcript source reads n/a with no source claim", () => {
    const nullCost = snap({ sources: { cost: "transcript" } });
    expect(costAria(nullCost)).toBe("API-equivalent cost n/a");
  });

  it("transcriptHint lists only figures that hold a value", () => {
    const s = snap({
      sources: { cost: "transcript", context: "transcript", model: "transcript" },
      model: { id: "m", display_name: "m" },
    });
    expect(transcriptHint(s)).toBe("Model is from transcript");
    expect(transcriptHint(headless)).toBe("Cost and context are from transcript");
  });

  it("context tokens text: tokens only, never a percent", () => {
    expect(contextTokensText(headless)).toBe("94k tok");
    expect(contextTokensText(snap())).toBeNull();
  });
});

describe("contextModel with transcript source", () => {
  it("window null: tokens only, no percent, no bar fill, marked", () => {
    const m = contextModel(headless);
    expect(m.text).toBe("94k tok");
    expect(m.text).not.toContain("%");
    expect(m.pct).toBeNull();
    expect(m.level).toBeNull();
    expect(m.fromTranscript).toBe(true);
    expect(m.aria).toContain("94172 tokens");
    expect(m.aria).not.toContain("percent");
    expect(m.aria).toContain("from transcript");
    expect(m.title).toContain("from transcript");
  });

  it("window known: percent as usual, still marked", () => {
    const m = contextModel(
      snap({
        context: { used_pct: 47, window: 200_000, input: 94_172, output: null },
        sources: { context: "transcript" },
      }),
    );
    expect(m.text).toBe("47% of 200k");
    expect(m.fromTranscript).toBe(true);
    expect(m.aria).toContain("47 percent");
  });

  it("statusline or unsourced null stays n/a and unmarked", () => {
    const sl = contextModel(
      snap({
        context: { used_pct: null, window: null, input: 5000, output: null },
        sources: { context: "statusline" },
      }),
    );
    expect(sl.text).toBe("n/a");
    expect(sl.fromTranscript).toBe(false);
    expect(contextModel(snap()).fromTranscript).toBe(false);
  });
});
