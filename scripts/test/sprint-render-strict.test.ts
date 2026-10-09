import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, listPackages, loadSources, renderPrompt } from "../sprint/render-prompt.mjs";
import { extractPackageBlocks, sectionLines } from "../sprint/lib/markdown-extract.mjs";
import type { RenderError } from "../sprint/lib/render-errors.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const real = loadSources(repoRoot);
const SHA = "0123abc";

interface Sources {
  promptBook: string;
  order: string;
}

function failure(sources: Sources, sprintId: string): RenderError {
  try {
    renderPrompt({ sources, sprintId, contractSha: SHA });
  } catch (error) {
    expect((error as Error).name).toBe("RenderError");
    return error as RenderError;
  }
  throw new Error("expected the renderer to fail, but it produced a prompt");
}

function withBook(edit: (text: string) => string): Sources {
  return { promptBook: edit(real.promptBook), order: real.order };
}

/** Replaces the first match of `from` after the "### Sprint <id>:" heading. */
function editBlock(sprintId: string, from: string | RegExp, to: string): Sources {
  const start = real.order.indexOf(`### Sprint ${sprintId}:`);
  expect(start).toBeGreaterThan(-1);
  const tail = real.order.slice(start);
  const edited = tail.replace(from, to);
  expect(edited).not.toBe(tail);
  return { promptBook: real.promptBook, order: real.order.slice(0, start) + edited };
}

describe("sprint renderer strictness: placeholder-shaped tokens in the template", () => {
  it.each([
    "{CONTRACT_SHA1}",
    "{Sprint_Id}",
    "{SPRINT-ID}",
    "{SPRINT_ID }",
    "{n}",
    "{timestamp}",
    "{}",
    "{ }",
  ])("fails on the typo or lower-case token %s", (token) => {
    const sources = withBook((t) =>
      t.replace(
        "- Max parallel phase managers: {MAX_PARALLEL}",
        `- Max parallel phase managers: {MAX_PARALLEL} ${token}`,
      ),
    );
    const err = failure(sources, "2");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain(token);
  });

  it("still fails when the typo sits inside the preamble", () => {
    const sources = withBook((t) => t.replace("{CONTRACT_SHA} (after", "{CONTRACT_SHA1} (after"));
    expect(failure(sources, "2").message).toContain("{CONTRACT_SHA1}");
  });
});

describe("sprint renderer strictness: placeholder names inside package values", () => {
  it("rejects a real placeholder name in notes, naming the sprint and key", () => {
    const sources = editBlock(
      "2",
      /^notes: "/m,
      'notes: "gate output goes to /state/{SPRINT_ID}/gate/ ',
    );
    const err = failure(sources, "2");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain("sprint 2");
    expect(err.message).toContain('"notes"');
    expect(err.message).toContain("{SPRINT_ID}");
  });

  it("rejects a pass-through name in an integration check", () => {
    const sources = editBlock("2", '  - "normalizer golden', '  - "run {SESSION_ID} golden');
    expect(failure(sources, "2").message).toMatch(/sprint 2.*"integration_checks".*\{SESSION_ID\}/);
  });

  it("accepts shell syntax with a dollar sign and lower-case braces", () => {
    const sources = editBlock("2", "user_gates: []", 'user_gates: ["use ${HOME} and {n} files"]');
    expect(renderPrompt({ sources, sprintId: "2", contractSha: SHA })).toContain(
      "use ${HOME} and {n} files",
    );
  });
});

describe("sprint renderer strictness: unknown keys", () => {
  it("rejects user_gates on a session (the top-level spelling), naming session and key", () => {
    const sources = editBlock("0", "    user_gate:", "    user_gates:");
    const err = failure(sources, "0");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/sprint 0, sessions\[2\] \(S0b\).*unknown key "user_gates"/);
  });

  it("rejects need_laptop and note at the top level", () => {
    const a = editBlock("1", /^needs_laptop:/m, "need_laptop:");
    expect(failure(a, "1").message).toMatch(/sprint 1.*unknown key "need_laptop"/);
    const b = editBlock("1", /^notes:/m, "note:");
    expect(failure(b, "1").message).toMatch(/sprint 1.*unknown key "note"/);
  });
});

describe("sprint renderer strictness: cross-checks inside a block", () => {
  it("requires merge_order to name every session", () => {
    const err = failure(editBlock("2", "merge_order: [S7, S8]", "merge_order: [S7]"), "2");
    expect(err.message).toMatch(/sprint 2.*"merge_order".*S8/);
  });

  it("rejects an empty or repeating merge_order", () => {
    expect(
      failure(editBlock("2", "merge_order: [S7, S8]", "merge_order: []"), "2").message,
    ).toMatch(/sprint 2.*"merge_order"/);
    expect(
      failure(editBlock("2", "merge_order: [S7, S8]", "merge_order: [S7, S7, S8]"), "2").message,
    ).toMatch(/sprint 2.*"merge_order".*S7/);
  });

  it("rejects an empty integration_checks", () => {
    const sources = editBlock(
      "2",
      /^integration_checks:\n( {2}- .*\n)+/m,
      "integration_checks: []\n",
    );
    expect(failure(sources, "2").message).toMatch(/sprint 2.*"integration_checks".*at least one/);
  });

  it("rejects a session depends_on that names no session", () => {
    const sources = editBlock("2", "depends_on: [S7]", "depends_on: [S33]");
    expect(failure(sources, "2").message).toMatch(
      /sprint 2, sessions\[1\] \(S8\).*"depends_on".*S33/,
    );
  });

  it("rejects a session that depends on itself", () => {
    const sources = editBlock("2", "depends_on: [S7]", "depends_on: [S8]");
    expect(failure(sources, "2").message).toMatch(/"depends_on".*S8/);
  });

  it("requires branch to equal sprint/<sprint>-<slug>", () => {
    const sources = editBlock("1", "slug: mvp", "slug: core");
    const err = failure(sources, "1");
    expect(err.message).toMatch(/sprint 1.*"branch"/);
    expect(err.message).toContain("sprint/1-core");
    expect(err.message).toContain("sprint/1-mvp");
  });
});

describe("sprint renderer strictness: multi-line values", () => {
  it("rejects a block scalar in an integration check", () => {
    const sources = editBlock(
      "2",
      '  - "normalizer golden tests on all fixture transcripts; unknown-row fallback renders"',
      "  - |\n    first line\n    second line",
    );
    const err = failure(sources, "2");
    expect(err.message).toMatch(/sprint 2.*"integration_checks".*single line/);
  });

  it("rejects a folded scalar in notes and a multi-line name", () => {
    const notes = editBlock("1", /^notes: ".*"$/m, "notes: >\n  folded\n  text");
    expect(failure(notes, "1").message).toMatch(/sprint 1.*"notes".*single line/);
    const name = editBlock("1", "name: mvp", 'name: "a\\nb"');
    expect(failure(name, "1").message).toMatch(/sprint 1.*"name".*single line/);
  });
});

describe("sprint renderer strictness: every package block is seen", () => {
  it("has one yaml fence in section 3 per package block", () => {
    const lines = sectionLines(real.order, 3);
    expect(lines).not.toBeNull();
    const fences = (lines ?? []).filter((l) => /^```yaml\s*$/.test(l));
    expect(fences.length).toBe(listPackages(real.order).length);
    expect(extractPackageBlocks(real.order)).toHaveLength(fences.length);
  });

  it("errors on a yaml block whose heading is not '### Sprint <id>:'", () => {
    const order = real.order.replace("### Sprint 5: cockpit", "### Sprint 5 - cockpit");
    expect(order).not.toBe(real.order);
    expect(() => listPackages(order)).toThrow(/not under a "### Sprint <id>:" heading/);
  });
});
