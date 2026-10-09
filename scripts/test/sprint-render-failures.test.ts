import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, listPackages, loadSources, renderPrompt } from "../sprint/render-prompt.mjs";
import type { RenderError } from "../sprint/lib/render-errors.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const real = loadSources(repoRoot);
const SHA = "0123abc";

interface Sources {
  promptBook: string;
  order: string;
}

/** Runs the renderer and returns the RenderError it must throw. */
function failure(
  sources: Sources,
  sprintId: string,
  ...sha: [] | [string | undefined]
): RenderError {
  const contractSha = sha.length === 0 ? SHA : sha[0];
  try {
    renderPrompt({ sources, sprintId, contractSha });
  } catch (error) {
    expect((error as Error).name).toBe("RenderError");
    return error as RenderError;
  }
  throw new Error("expected the renderer to fail, but it produced a prompt");
}

function withBook(edit: (text: string) => string): Sources {
  return { promptBook: edit(real.promptBook), order: real.order };
}

/** Replaces the first match of `from` that comes after the "### Sprint <id>:" heading. */
function editBlock(sprintId: string, from: string | RegExp, to: string): Sources {
  const start = real.order.indexOf(`### Sprint ${sprintId}:`);
  expect(start).toBeGreaterThan(-1);
  const head = real.order.slice(0, start);
  const tail = real.order.slice(start);
  const edited = tail.replace(from, to);
  expect(edited).not.toBe(tail);
  return { promptBook: real.promptBook, order: head + edited };
}

describe("sprint prompt renderer: unfilled placeholders", () => {
  it("fails on an unknown placeholder in the template and names it", () => {
    const sources = withBook((t) =>
      t.replace(
        "- Max parallel phase managers: {MAX_PARALLEL}",
        "- Max: {MAX_PARALLEL} {BOGUS_THING}",
      ),
    );
    const err = failure(sources, "1");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain("{BOGUS_THING}");
  });

  it("fails on an unknown placeholder with spaces, and on one inside the preamble", () => {
    const spaced = withBook((t) => t.replace("Setup\n1.", "Setup {NOT A VALUE}\n1."));
    expect(failure(spaced, "2").message).toContain("{NOT A VALUE}");
    const inPreamble = withBook((t) =>
      t.replace("Concurrency allowed", "{GHOST_FIELD} Concurrency allowed"),
    );
    expect(failure(inPreamble, "2").message).toContain("{GHOST_FIELD}");
  });

  it("lists every unfilled placeholder once", () => {
    const sources = withBook((t) =>
      t.replace("Setup\n1.", "Setup {ALPHA_ONE} {ALPHA_ONE} {BETA_TWO}\n1."),
    );
    const msg = failure(sources, "2").message;
    expect(msg).toContain("{ALPHA_ONE}, {BETA_TWO}");
  });

  it("does not rescan filled values, so braces inside a value are not a hole", () => {
    const sources = editBlock(
      "2",
      "user_gates: []",
      'user_gates: ["wait for {SOME_THING} to land"]',
    );
    expect(renderPrompt({ sources, sprintId: "2", contractSha: SHA })).toContain(
      "wait for {SOME_THING} to land",
    );
  });

  it("fails when the template lacks the preamble placeholder or repeats it", () => {
    const none = withBook((t) =>
      t.replace("{UNIVERSAL PREAMBLE}\n\nYou are the mini-sprint", "You are the mini-sprint"),
    );
    expect(failure(none, "1").message).toMatch(/exactly once \(found 0\)/);
    const twice = withBook((t) =>
      t.replace(
        "{UNIVERSAL PREAMBLE}\n\nYou are the mini-sprint",
        "{UNIVERSAL PREAMBLE}\n{UNIVERSAL PREAMBLE}\n\nYou are the mini-sprint",
      ),
    );
    expect(failure(twice, "1").message).toMatch(/exactly once \(found 2\)/);
  });

  it("fails when needs_laptop has nowhere to go because the Package line changed", () => {
    const sources = withBook((t) =>
      t.replace("Package (from MINI-SPRINT-ORDER.md", "Bundle (from MINI-SPRINT-ORDER.md"),
    );
    expect(failure(sources, "1").message).toContain("Package (from MINI-SPRINT-ORDER.md");
  });
});

describe("sprint prompt renderer: malformed package blocks name the key and the sprint", () => {
  it("fails when merge_order is missing", () => {
    const sources = editBlock("1", /^merge_order:.*\n/m, "");
    const err = failure(sources, "1");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain("sprint 1");
    expect(err.message).toContain('"merge_order"');
  });

  it("fails when sessions is not a list", () => {
    const sources = editBlock("2", /^sessions:\n( {2}- .*\n)+/m, "sessions: S7 and S8\n");
    const err = failure(sources, "2");
    expect(err.message).toContain("sprint 2");
    expect(err.message).toContain('"sessions"');
    expect(err.message).toContain("non-empty list");
  });

  it("fails when a session is not a mapping", () => {
    const sources = editBlock("2", /^ {2}- \{ id: S7.*\n/m, "  - S7\n");
    expect(failure(sources, "2").message).toContain('"sessions[0]"');
  });

  it("fails when a session field has the wrong type, naming the session", () => {
    const sources = editBlock(
      "1",
      "phase: 3, depends_on: [S3, S5]",
      'phase: "three", depends_on: [S3, S5]',
    );
    const err = failure(sources, "1");
    expect(err.message).toContain("sessions[5] (S6)");
    expect(err.message).toContain('"phase"');
  });

  it("fails when a session field is missing", () => {
    const sources = editBlock("2", "security_gated: true,  lane: A }", "lane: A }");
    expect(failure(sources, "2").message).toMatch(
      /sessions\[0\] \(S7\).*missing required key "security_gated"/,
    );
  });

  it("fails on a scalar of the wrong type at the top level", () => {
    const sources = editBlock("3", "max_parallel: 2", "max_parallel: many");
    expect(failure(sources, "3").message).toMatch(/sprint 3.*"max_parallel"/);
    const zero = editBlock("3", "max_parallel: 2", "max_parallel: 0");
    expect(failure(zero, "3").message).toContain("at least 1");
  });

  it("fails on a bad runs_in, a stray merge_order id, and a repeated session id", () => {
    expect(failure(editBlock("1", "runs_in: container", "runs_in: cloud"), "1").message).toContain(
      '"runs_in"',
    );
    expect(
      failure(editBlock("2", "merge_order: [S7, S8]", "merge_order: [S7, S99]"), "2").message,
    ).toContain("S99");
    expect(failure(editBlock("2", "{ id: S8,", "{ id: S7,"), "2").message).toContain(
      'repeats id "S7"',
    );
  });

  it("fails when the sprint key and the heading disagree", () => {
    const sources = editBlock("2", 'sprint: "2"', 'sprint: "9"');
    expect(failure(sources, "9").message).toContain('heading says "2"');
  });

  it("fails when the yaml does not parse or is not a mapping", () => {
    const broken = editBlock("2", "name: content", "name: [content");
    expect(failure(broken, "2").message).toMatch(/sprint 2.*does not parse/);
    const scalar = editBlock("2", /```yaml\n[\s\S]*?```/, "```yaml\njust text\n```");
    expect(failure(scalar, "2").message).toContain("must be a mapping");
  });

  it("fails when a sprint has no yaml fence or two blocks share an id", () => {
    const noFence = editBlock("2", "```yaml", "```text");
    expect(failure(noFence, "2").message).toContain("has no yaml fence");
    const dup = {
      promptBook: real.promptBook,
      order: real.order.replace("### Sprint 3: organize", "### Sprint 2: organize"),
    };
    expect(() => listPackages(dup.order)).toThrow(/sprint 2/);
  });
});

describe("sprint prompt renderer: caller errors", () => {
  it("requires a contract sha for every sprint except 0", () => {
    for (const id of ["1", "2", "3", "4", "5"]) {
      const err = failure(real, id, undefined);
      expect(err.exitCode).toBe(EXIT.USAGE);
      expect(err.message).toContain("--contract-sha");
      expect(err.message).toContain(`sprint ${id}`);
    }
  });

  it("rejects a contract sha with spaces or braces", () => {
    expect(failure(real, "1", "abc def").message).toContain("--contract-sha");
    expect(failure(real, "0", "{SESSION_ID}").exitCode).toBe(EXIT.USAGE);
  });

  it("lists the valid ids for an unknown sprint", () => {
    const err = failure(real, "9");
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain('unknown sprint "9"');
    expect(err.message).toContain("0, 1, 2, 3, 4, 5, smoke");
  });
});

describe("sprint prompt renderer: damaged PROMPT-BOOK.md", () => {
  it("fails with a clear message when section 3 is missing", () => {
    const err = failure(
      withBook((t) => t.replace("## 3. Mini-sprint", "## three. Mini-sprint")),
      "1",
    );
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain("PROMPT-BOOK.md section 3");
    expect(err.message).toContain('heading "## 3. ..." not found');
  });

  it("fails when the template fence is missing or unlabeled", () => {
    const err = failure(
      withBook((t) => t.replace("\nTemplate:\n", "\nA template:\n")),
      "1",
    );
    expect(err.message).toContain('after a line reading "Template:"');
  });

  it("fails when a fence is never closed", () => {
    const broken = withBook((t) => t.replace(/\n```\n\n## 4\./, "\n\n## 4."));
    expect(broken.promptBook).not.toBe(real.promptBook);
    const err = failure(broken, "1");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain("never closed");
  });

  it("fails when section 1 or its fence is missing", () => {
    const noHeading = withBook((t) =>
      t.replace("## 1. Universal preamble", "## one. Universal preamble"),
    );
    expect(failure(noHeading, "1").message).toContain("PROMPT-BOOK.md section 1");
    const noFence = withBook((t) =>
      t.replace("```\nContext, in this order", "Context, in this order"),
    );
    expect(noFence.promptBook).not.toBe(real.promptBook);
    const err = failure(noFence, "1");
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain("PROMPT-BOOK.md section 1");
  });
});
