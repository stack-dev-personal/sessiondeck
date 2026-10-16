import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderProvisionalTable, renderStateDiagram, renderTransitionTable } from "../src/diagram";
import { DOC_BLOCK_NAMES, extractBlock, renderDocBlocks, replaceBlock } from "../src/docblocks";
import { ROW_STATES, SESSION_STATES, TRANSITIONS } from "../src/state";
import { parseEnvelope } from "../src/envelope";
import { makeEnvelope } from "./helpers";
import { observedRows, renderObservedTable } from "./observed";

const DOC_PATH = join(import.meta.dirname, "..", "..", "..", "docs", "CONTRACT.md");
const REGEN_HINT = "run: pnpm -F @sessiondeck/contract gen:doc";

const DOC_TEXT = readFileSync(DOC_PATH, "utf8");
const doc = (): string => DOC_TEXT;

// Computed once per file: the fixture walk is the slow part and its results are never mutated.
const OBSERVED_ROWS = Object.freeze(observedRows());
const EXPECTED_OBSERVED_TABLE: readonly string[] = Object.freeze(
  renderObservedTable(OBSERVED_ROWS).split("\n"),
);
const DOC_BLOCKS = Object.freeze(renderDocBlocks());

describe("renderStateDiagram", () => {
  it("is deterministic and mentions every state", () => {
    const a = renderStateDiagram(TRANSITIONS);
    expect(renderStateDiagram(TRANSITIONS)).toBe(a);
    for (const s of SESSION_STATES) expect(a).toContain(s);
    expect(a.startsWith("```mermaid\nstateDiagram-v2\n")).toBe(true);
    expect(a.endsWith("\n```")).toBe(true);
  });

  it("renders one edge per source and uses an any-state node for near-full from-sets", () => {
    const out = renderStateDiagram([
      { trigger: "Stop", from: ["working", "idle"], guards: [], to: "idle", detail: "clear" },
      {
        trigger: "SessionEnd",
        from: ROW_STATES.filter((s) => s !== "ended"),
        guards: ["main_thread"],
        to: "ended",
        detail: "clear",
      },
    ]);
    expect(out).toContain("    working --> idle : Stop\n    idle --> idle : Stop");
    expect(out).toContain('state "any state except ended" as any_except_ended');
    expect(out).toContain("any_except_ended --> ended : SessionEnd if not inside a subagent");
  });

  it("renders the transition and provisional tables", () => {
    expect(renderTransitionTable(TRANSITIONS)).toContain("| Stop | any state except ended |");
    expect(renderProvisionalTable()).toContain("| TaskCreated | state unchanged; tasks.total + 1");
  });
});

describe("docs/CONTRACT.md", () => {
  it.each(DOC_BLOCK_NAMES)("generated block '%s' is up to date", (name) => {
    const actual = extractBlock(doc(), name);
    expect(actual, `markers for ${name} missing`).not.toBeNull();
    expect(actual, `block ${name} drifted; ${REGEN_HINT}`).toBe(DOC_BLOCKS[name]);
  });

  it("detects an altered block", () => {
    const tampered = doc().replace("any_except_ended --> idle", "any_except_ended --> error");
    expect(extractBlock(tampered, "state-diagram")).not.toBe(DOC_BLOCKS["state-diagram"]);
  });

  it("compares equal after CRLF conversion", () => {
    const crlf = doc().replace(/\r?\n/g, "\r\n");
    expect(extractBlock(crlf, "state-diagram")).toBe(DOC_BLOCKS["state-diagram"]);
  });

  it("documents exactly the envelope fields the schema produces", () => {
    const parsed = parseEnvelope(makeEnvelope({ agent_id: "a1" }));
    const section = doc().split("## Envelope")[1]?.split("## Liveness")[0] ?? "";
    const documented = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(Object.keys(parsed).sort());
  });

  it("mentions the claude version and no em dashes", () => {
    expect(doc()).toContain("2.1.295");
    expect(doc()).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("block helpers", () => {
  const text = "a\n<!-- BEGIN:provisional -->\nold\n<!-- END:provisional -->\nb\n";

  it("replaceBlock swaps the region and extractBlock reads it back", () => {
    const next = replaceBlock(text, "provisional", "new");
    expect(next).toBe("a\n<!-- BEGIN:provisional -->\nnew\n<!-- END:provisional -->\nb\n");
    expect(extractBlock(next, "provisional")).toBe("new");
  });

  it("returns null or throws when markers are missing or out of order", () => {
    expect(extractBlock("nothing", "provisional")).toBeNull();
    expect(() => replaceBlock("nothing", "provisional", "x")).toThrow(/markers/);
    const reversed = "<!-- END:provisional -->\n<!-- BEGIN:provisional -->";
    expect(extractBlock(reversed, "provisional")).toBeNull();
  });
});

describe("docs/CONTRACT.md observed payloads", () => {
  const SECTION = doc().split("## Observed payloads")[1] ?? "";
  const section = (): string => SECTION;
  const tableOf = (text: string): string[] =>
    text.split("\n").filter((l) => l.startsWith("| ") || l.startsWith("| ---"));

  it("names the captured Claude Code version and host", () => {
    expect(doc()).toContain("## Observed payloads (Claude Code 2.1.301, Windows 11");
  });

  it("lists exactly the top-level fields of the committed fixtures, per event", () => {
    const table = section()
      .split("\n")
      .filter((l) => l.startsWith("| ") || l.startsWith("| ---"));
    const expected = EXPECTED_OBSERVED_TABLE;
    expect(table, "observed table drifted from fixtures; update docs/CONTRACT.md").toEqual(
      expected,
    );
  });

  it("marks the four synthetic events as not captured", () => {
    const text = section();
    expect(text).toContain("Not captured (synthetic, by conductor decision 7)");
    for (const e of ["TaskCreated", "TaskCompleted", "PermissionDenied", "StopFailure"]) {
      expect(text).toContain(`\`${e}\``);
      expect(OBSERVED_ROWS.map((r) => r.event)).not.toContain(e);
    }
  });

  it("detects a drifted field list in the doc", () => {
    const drifted = section().replace(
      "| PostCompact | 1 | `compact_summary`",
      "| PostCompact | 1 | `invented_field` `compact_summary`",
    );
    expect(drifted).not.toBe(section());
    const expected = EXPECTED_OBSERVED_TABLE;
    expect(tableOf(drifted)).not.toEqual(expected);
  });
});
