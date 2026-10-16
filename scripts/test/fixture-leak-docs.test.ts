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

describe("expected-timeline files next to the golden session", () => {
  it("get the text checks but not the payload structure check", () => {
    const clean = dirWith({
      "sessions/g.timeline.json": { events: 3, changes: [{ index: 1, state_detail: "x y" }] },
    });
    expect(leakCheck(clean).byCategory).toEqual({});
    const dirty = dirWith({ "sessions/g.timeline.json": { note: "C:/Users/someone/x" } });
    expect(leakCheck(dirty).byCategory).toEqual({ "home-path-shape": 1 });
  });

  it("other json under sessions/ is still a payload", () => {
    const root = dirWith({ "sessions/other.json": { events: 3, note: "free text" } });
    expect(Object.keys(leakCheck(root).byCategory).length).toBeGreaterThan(0);
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
