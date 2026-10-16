import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES_ROOT } from "../lib/fixture-files.mjs";
import { leakCheck } from "../lib/fixture-leak-core.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";
import { makeRaw } from "./fixture-raw-helpers";

afterEach(cleanupTempDirs);

function dirWith(files: Record<string, unknown>): string {
  const root = makeTempDir();
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

describe("path exemption for token runs", () => {
  const scan = (text: string) => leakCheck(dirWith({ "README.md": text })).byCategory;

  it("flags a base64 secret cut into short pieces by slashes, followed by an extension", () => {
    expect(scan("keys/aB3dE5gH7jK9mN1pQ3/sT5vW7yZ9bC1dE3fG5hJ.pem")["token-run"]).toBe(1);
    expect(scan("see aB3dE5gH7jK9/mN1pQ3sT5vW7yZ9/bC1dE3fG5hJkL.txt")["token-run"]).toBe(1);
  });

  it("flags a base64 secret with + and = pieces too", () => {
    expect(scan("certs/aB3dE5gH7jK+mN1pQ3sT5v/W7yZ9bC1dE3fG5hJ=.pem")["token-run"]).toBe(1);
  });

  it("still lets ordinary long relative paths through", () => {
    for (const path of [
      "docs/research/2026-10-08-feasibility-and-oss.md",
      "packages/contract/fixtures/sessions/golden-session.timeline.md",
      "packages/contract/test/state-fixtures.test.ts",
      "scripts/lib/fixture-leak-literals.mjs",
      "docs/planning/phases/phase-0-contract.md",
    ]) {
      expect(scan(`See ${path} for details.`), path).toEqual({});
    }
  });
});

describe("text-only extra files (docs/CONTRACT.md)", () => {
  const empty = () => dirWith({ "Stop/a.json": { prompt: "<TEXT 3>" } });
  const doc = (text: string) => join(dirWith({ "CONTRACT.md": text }), "CONTRACT.md");
  const labeled = (path: string, allow?: string[]) => [{ path, label: "docs/CONTRACT.md", allow }];

  it("reports a home path, an email and a token under the label, without a payload check", () => {
    const text = "At C:/Users/someone/x, mail a@b.example, key sk-abcdefgh12345678.";
    const r = leakCheck(empty(), { textFiles: labeled(doc(text)) });
    expect(r.perFile.every((f) => f.file === "docs/CONTRACT.md")).toBe(true);
    expect(Object.keys(r.byCategory).sort()).toEqual(["email", "home-path-shape", "token-prefix"]);
  });

  it("passes clean prose and ignores a file that does not exist", () => {
    const clean = labeled(doc("Plain prose about `PostToolUse` and docs/CONTRACT.md."));
    expect(leakCheck(empty(), { textFiles: clean }).total).toBe(0);
    const missing = labeled(join(empty(), "nope.md"));
    expect(leakCheck(empty(), { textFiles: missing }).total).toBe(0);
  });

  it("flags raw-derived names in the file, except words allowed for that file", () => {
    const raw = makeRaw();
    const path = doc("The alpha project and the zed account.");
    const flagged = leakCheck(empty(), { rawRoot: raw, textFiles: labeled(path) });
    expect(flagged.perFile.map((f) => f.category).sort()).toEqual(["project-name", "user-name"]);
    const allowed = leakCheck(empty(), {
      rawRoot: raw,
      textFiles: labeled(path, ["Alpha", "zed"]),
    });
    expect(allowed.byCategory["project-name"]).toBeUndefined();
  });

  it("does not apply one file's allow list to fixture files", () => {
    const raw = makeRaw();
    const fixtures = dirWith({ "notes.md": "The alpha project." });
    const r = leakCheck(fixtures, { rawRoot: raw, textFiles: labeled(doc("x"), ["alpha"]) });
    expect(r.byCategory["project-name"]).toBe(1);
  });
});

const GOOD_TIMELINE = {
  events: 3,
  changes: [
    {
      index: 1,
      event: "UserPromptSubmit",
      context: "main",
      from: "starting",
      to: "working",
      state_detail: null,
      row: 2,
    },
    {
      index: 2,
      event: "PreToolUse",
      context: "main",
      from: "working",
      to: "working",
      state_detail: "tool:Bash",
      row: 3,
    },
  ],
  final: {
    state: "working",
    state_since_index: 1,
    state_detail: "tool:Bash",
    ended_reason: null,
    last_event_index: 2,
    compactions: 0,
    tasks: { total: 0, completed: 0, last_subject: null },
    model_id: "claude-fable-5-1",
    tracking: { last_tool: "Bash", permission: null },
    subagents: [{ agent_type: "general-purpose", started_index: 1, ended_index: null }],
  },
};

// Loose on purpose: each case edits a deep field of a cloned fixture document.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const timeline = (edit: (t: Json) => void): Record<string, unknown> => {
  const t = structuredClone(GOOD_TIMELINE) as Json;
  edit(t);
  return { "sessions/g.timeline.json": t };
};
const schemaHits = (files: Record<string, unknown>) => leakCheck(dirWith(files)).byCategory;

describe("expected-timeline files next to the golden session", () => {
  it("get the text checks and a schema check, not the payload structure check", () => {
    expect(leakCheck(dirWith(timeline(() => {}))).byCategory).toEqual({});
    const dirty = dirWith({ "sessions/g.timeline.json": { note: "C:/Users/someone/x" } });
    expect(leakCheck(dirty).byCategory).toEqual({ "home-path-shape": 1, "timeline-schema": 1 });
  });

  it("other json under sessions/ is still a payload", () => {
    const root = dirWith({ "sessions/other.json": { events: 3, note: "free text" } });
    expect(Object.keys(leakCheck(root).byCategory).length).toBeGreaterThan(0);
  });

  it("fails a stray top-level field such as a note", () => {
    expect(schemaHits(timeline((t) => (t.note = "remember this")))).toEqual({
      "timeline-schema": 1,
    });
  });

  it.each([
    ["a change", (t: Json) => (t.changes[0].why = "x")],
    ["final", (t: Json) => (t.final.extra = 1)],
    ["tasks", (t: Json) => (t.final.tasks.note = "x")],
    ["tracking", (t: Json) => (t.final.tracking.note = "x")],
    ["a subagent row", (t: Json) => (t.final.subagents[0].note = "x")],
  ])("fails a stray field inside %s", (_name, edit) => {
    expect(schemaHits(timeline(edit))).toEqual({ "timeline-schema": 1 });
  });

  it.each([
    "free text here",
    "tool:Bash --token abc",
    "tool:",
    "other:Bash",
    "tool:a/b",
    "needs input",
  ])("fails a free-text state_detail (%s) in a change and in final", (detail) => {
    expect(schemaHits(timeline((t) => (t.changes[1].state_detail = detail)))).toEqual({
      "timeline-schema": 1,
    });
    expect(schemaHits(timeline((t) => (t.final.state_detail = detail)))).toEqual({
      "timeline-schema": 1,
    });
  });

  it.each(["source:startup", "compact:auto", "tool:ExitPlanMode", null])(
    "accepts state_detail %s",
    (detail) => {
      expect(schemaHits(timeline((t) => (t.changes[1].state_detail = detail)))).toEqual({});
    },
  );

  it.each([
    ["model_id", (t: Json) => (t.final.model_id = "my-private-model")],
    ["agent_type", (t: Json) => (t.final.subagents[0].agent_type = "my-private-agent")],
    ["ended_reason", (t: Json) => (t.final.ended_reason = "because I said so")],
    ["last_tool", (t: Json) => (t.final.tracking.last_tool = "MyTool")],
    ["last_subject", (t: Json) => (t.final.tasks.last_subject = "do the thing")],
    ["permission", (t: Json) => (t.final.tracking.permission = { tool: "Bash" })],
    ["event", (t: Json) => (t.changes[0].event = "NotAnEvent")],
    ["context", (t: Json) => (t.changes[0].context = "other")],
    ["state", (t: Json) => (t.changes[0].to = "sleeping")],
    ["a count", (t: Json) => (t.final.compactions = -1)],
    ["changes type", (t: Json) => (t.changes = "text")],
    ["subagents type", (t: Json) => (t.final.subagents = "text")],
    ["top level type", (t: Json) => Object.keys(t).forEach((k) => delete t[k])],
  ])("fails an off-list %s", (_name, edit) => {
    expect(schemaHits(timeline(edit))["timeline-schema"]).toBeGreaterThan(0);
  });

  it.each([
    ["model_id", (t: Json) => (t.final.model_id = "claude-opus-4-1")],
    ["agent_type", (t: Json) => (t.final.subagents[0].agent_type = "")],
    ["ended_reason", (t: Json) => (t.final.ended_reason = "clear")],
    ["last_tool", (t: Json) => (t.final.tracking.last_tool = null)],
  ])("accepts an allowlisted %s", (_name, edit) => {
    expect(schemaHits(timeline(edit))).toEqual({});
  });

  it("is not applied to a text file that merely carries a timeline label", () => {
    const fixtures = dirWith({ "Stop/a.json": { prompt: "<TEXT 3>" } });
    const path = join(dirWith({ "x.json": { note: "free" } }), "x.json");
    const r = leakCheck(fixtures, {
      textFiles: [{ path, label: "sessions/x.timeline.json" }],
    });
    expect(r.byCategory["timeline-schema"]).toBeUndefined();
  });
});

describe("allow lists are tied to the extra file, not its label", () => {
  it("a fixture saved at fixtures/docs/CONTRACT.md gets no allow list", () => {
    const raw = makeRaw();
    const fixtures = dirWith({ "docs/CONTRACT.md": "The alpha project." });
    const extra = join(dirWith({ "CONTRACT.md": "x" }), "CONTRACT.md");
    const r = leakCheck(fixtures, {
      rawRoot: raw,
      textFiles: [{ path: extra, label: "docs/CONTRACT.md", allow: ["alpha"] }],
    });
    expect(r.byCategory["project-name"]).toBe(1);
  });

  it("the extra file itself still gets its allow list", () => {
    const raw = makeRaw();
    const extra = join(dirWith({ "CONTRACT.md": "The alpha project." }), "CONTRACT.md");
    const r = leakCheck(dirWith({ "Stop/a.json": { prompt: "<TEXT 3>" } }), {
      rawRoot: raw,
      textFiles: [{ path: extra, label: "docs/CONTRACT.md", allow: ["alpha"] }],
    });
    expect(r.byCategory["project-name"]).toBeUndefined();
  });
});

describe("path pieces that read as names", () => {
  const scan = (text: string) => leakCheck(dirWith({ "README.md": text })).byCategory;

  it("accepts camelCase and PascalCase pieces in an ordinary source path", () => {
    for (const path of [
      "packages/web/src/components/SessionCard.tsx",
      "packages/web/src/hooks/useSessionList.ts",
      "packages/hub/src/routes/HttpServerConfig.test.ts",
    ]) {
      expect(scan(`A line naming ${path} for review.`), path).toEqual({});
    }
  });

  it("still flags mixed-case random runs cut by slashes", () => {
    expect(scan("keys/aB3dE5gH7jK9mN1pQ3/sT5vW7yZ9bC1dE3fG5hJ.pem")["token-run"]).toBe(1);
    expect(scan("see aB3dE5gH/mN1pQ3sT5vW7yZ9bC1dE3fG5hJkL.txt")["token-run"]).toBe(1);
  });
});

describe("committed docs", () => {
  it("docs/CONTRACT.md passes the text checks (CI has no raw/)", () => {
    const docs = join(FIXTURES_ROOT, "..", "..", "..", "docs", "CONTRACT.md");
    const r = leakCheck(makeTempDir(), { textFiles: [{ path: docs, label: "docs/CONTRACT.md" }] });
    expect(r.files).toBe(1);
    expect(r.byCategory).toEqual({});
  });
});
