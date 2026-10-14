import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, listPackages, loadSources, renderPrompt } from "../sprint/render-prompt.mjs";
import { extractPackageBlocks } from "../sprint/lib/markdown-extract.mjs";
import { checkNoCycle } from "../sprint/lib/package-block.mjs";
import type { RenderError } from "../sprint/lib/render-errors.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const real = loadSources(repoRoot);
const SHA = "0123abc";

interface Sources {
  promptBook: string;
  order: string;
}

function renderFailure(sources: Sources, sprintId = "2"): RenderError {
  try {
    renderPrompt({ sources, sprintId, contractSha: SHA });
  } catch (error) {
    expect((error as Error).name).toBe("RenderError");
    return error as RenderError;
  }
  throw new Error("expected the renderer to fail, but it produced a prompt");
}

function listFailure(order: string): RenderError {
  try {
    listPackages(order);
  } catch (error) {
    expect((error as Error).name).toBe("RenderError");
    return error as RenderError;
  }
  throw new Error("expected listPackages to fail");
}

function withBook(from: string, to: string): Sources {
  expect(real.promptBook).toContain(from);
  return { promptBook: real.promptBook.replace(from, to), order: real.order };
}

/** Replaces the first match of `from` after the "### Sprint <id>:" heading. */
function editBlock(sprintId: string, from: string | RegExp, to: string): string {
  const start = real.order.indexOf(`### Sprint ${sprintId}:`);
  expect(start).toBeGreaterThan(-1);
  const tail = real.order.slice(start);
  const edited = tail.replace(from, to);
  expect(edited).not.toBe(tail);
  return real.order.slice(0, start) + edited;
}

function withExtraBeforeSection4(extra: string): string {
  const marker = "## 4. After the last sprint";
  expect(real.order).toContain(marker);
  return real.order.replace(marker, `${extra}${marker}`);
}

describe("sprint renderer review 3, finding 1: every value must be used", () => {
  it("fails when the SESSION_TABLE bullet is deleted", () => {
    const bullet = "- Sessions and lanes: {SESSION_TABLE}\n";
    const err = renderFailure(withBook(bullet, ""));
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/SESSION_TABLE.*never used/);
  });

  it("fails when the MERGE_ORDER bullet is deleted", () => {
    const err = renderFailure(
      withBook("- Merge order into the sprint branch: {MERGE_ORDER}\n", ""),
    );
    expect(err.message).toMatch(/MERGE_ORDER.*never used/);
  });

  it.each([
    ["CONTRACT_SHA", "{CONTRACT_SHA} (after", "CONTRACT_SHA (after"],
    ["INTEGRATION_CHECKS", "{INTEGRATION_CHECKS}", "[INTEGRATION_CHECKS]"],
  ])("fails when %s has lost both braces", (name, from, to) => {
    const err = renderFailure(withBook(from, to));
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain(name);
    expect(err.message).toMatch(/never used/);
  });

  it("still renders sprint 0 with the n/a contract text and the smoke prompt", () => {
    const zero = renderPrompt({ sources: real, sprintId: "0" });
    expect(zero).toContain("Contract commit: n/a");
    expect(renderPrompt({ sources: real, sprintId: "smoke" })).toContain("smoke/status.json");
  });
});

describe("sprint renderer review 3, finding 2: dependency cycles between sprints", () => {
  it("rejects a two-sprint cycle", () => {
    const order = editBlock("1", 'depends_on: ["0"]', 'depends_on: ["0", "2"]');
    const err = listFailure(order);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/cycle.*1 -> 2 -> 1|cycle.*2 -> 1 -> 2/);
  });

  it("rejects a sprint that depends on itself", () => {
    const order = editBlock("1", 'depends_on: ["0"]', 'depends_on: ["1"]');
    const err = listFailure(order);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/sprint 1.*"depends_on".*"1"/);
  });

  it("checkNoCycle accepts a chain and reports the loop path", () => {
    const chain = new Map([
      ["a", []],
      ["b", ["a"]],
    ]);
    expect(() => checkNoCycle(chain, "where", "sprint")).not.toThrow();
    const loop = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(() => checkNoCycle(loop, "where", "sprint")).toThrow(
      /where: .*a -> b -> a.*no sprint in it could start/,
    );
  });
});

describe("sprint renderer review 3, finding 3: Sprint headings at any level", () => {
  it("fails on an h2 Sprint heading with a normal yaml fence", () => {
    const extra = '## Sprint 6: polish\n\n```yaml\nsprint: "6"\n```\n\n';
    const err = listFailure(withExtraBeforeSection4(extra));
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/## Sprint 6: polish/);
  });

  it("fails on an h4 Sprint heading with a yml fence", () => {
    const extra = '#### Sprint 6: polish\n\n```yml\nsprint: "6"\n```\n\n';
    const err = listFailure(withExtraBeforeSection4(extra));
    expect(err.message).toMatch(/#### Sprint 6: polish/);
  });

  it("fails on a Sprint heading outside section 3", () => {
    // A yaml fence follows the heading so the older "has no yaml fence" check cannot fire first;
    // only the any-level heading guard can name this one.
    const late = '\n### Sprint 7: late\n\n```yaml\nsprint: "7"\n```\n';
    const err = listFailure(`${real.order}${late}`);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toContain('is not a "### Sprint <id>: <name>" heading inside section 3');
    expect(err.message).toContain("### Sprint 7: late");
  });

  it("keeps the six real h3 blocks in the real file", () => {
    expect(listPackages(real.order).map((p) => p.sprint)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(extractPackageBlocks(real.order)).toHaveLength(6);
  });
});

describe("sprint renderer review 3, finding 4: stray brace error quotes the template", () => {
  it("quotes the original template line, not the stripped remainder", () => {
    const line = real.promptBook.split("\n").find((l) => l.includes("{SPRINT_ID} ({SPRINT_NAME})"));
    expect(line).toBeDefined();
    const broken = (line ?? "").replace(
      "{SPRINT_ID} ({SPRINT_NAME})",
      "{{SPRINT_ID}} ({SPRINT_NAME})",
    );
    const err = renderFailure(withBook(line ?? "", broken));
    expect(err.message).toContain(`"${broken.trim()}"`);
    expect(real.promptBook.replace(line ?? "", broken)).toContain(broken);
  });

  it("quotes the original line for a dropped brace inside a path", () => {
    const from = "origin/sprint/{SPRINT_ID}-{SPRINT_SLUG}` if";
    const err = renderFailure(withBook(from, "origin/sprint/{SPRINT_ID-{SPRINT_SLUG}` if"));
    expect(err.message).toContain("origin/sprint/{SPRINT_ID-{SPRINT_SLUG}");
  });
});
