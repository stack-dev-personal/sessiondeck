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

function failure(sources: Sources, sprintId = "2"): RenderError {
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

function withOrder(from: string | RegExp, to: string): Sources {
  const order = real.order.replace(from, to);
  expect(order).not.toBe(real.order);
  return { promptBook: real.promptBook, order };
}

describe("sprint renderer guards: stray braces in the assembled template", () => {
  it.each([
    ["a dropped closing brace", "{CONTRACT_SHA} (after", "{CONTRACT_SHA (after"],
    [
      "an open brace in a path",
      "/state/{SPRINT_ID}/ (bind-mounted",
      "/state/{SPRINT_ID/gate/ (bind-mounted",
    ],
    [
      "a close brace in a path",
      "/state/{SPRINT_ID}/ (bind-mounted",
      "/state/SPRINT_ID}/gate/ (bind-mounted",
    ],
    ["a paren instead of a brace", "{SPRINT_ID} ({SPRINT_NAME})", "{SPRINT_ID) ({SPRINT_NAME})"],
    ["a token split across a line break", "{CONTRACT_SHA} (after", "{CONTRACT_\nSHA} (after"],
    ["doubled braces", "{SPRINT_ID} ({SPRINT_NAME})", "{{SPRINT_ID}} ({SPRINT_NAME})"],
  ])("fails on %s", (_label, from, to) => {
    const err = failure(withBook(from, to));
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/brace/);
  });

  it("still renders every package with the real text", () => {
    for (const id of ["0", "1", "2", "3", "4", "5"]) {
      expect(renderPrompt({ sources: real, sprintId: id, contractSha: SHA })).toContain("sprint");
    }
  });
});

describe("sprint renderer guards: dependency checks", () => {
  it("rejects a cycle between sessions of one sprint", () => {
    const first = withOrder(/(id: S7,[^\n]*depends_on: )\[\]/, "$1[S8]");
    const err = failure(first);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/sprint 2.*cycle.*S7.*S8/);
  });

  it("rejects a sprint depends_on id that is not a package", () => {
    const sources = withOrder(/(### Sprint 2:[\s\S]*?\ndepends_on: )\["1"\]/, '$1["9"]');
    const err = listFailure(sources.order);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/sprint 2.*"depends_on".*"9"/);
  });
});

describe("sprint renderer guards: section 3 of MINI-SPRINT-ORDER.md", () => {
  it("fails when section 3 is missing", () => {
    const sources = withOrder("## 3. Packages", "## Packages");
    const err = listFailure(sources.order);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/section 3/);
  });

  it("fails on a sprint heading the parser would not recognize", () => {
    const sources = withOrder("### Sprint 5: cockpit", "### Sprint 5 - cockpit");
    const err = listFailure(sources.order);
    expect(err.message).toMatch(/Sprint 5 - cockpit/);
  });

  it.each([
    ["a yml fence", "```yml", "```"],
    ["a tilde fence", "~~~yaml", "~~~"],
  ])("fails on an unrecognized heading with %s", (_label, open, close) => {
    const extra = `### Sprint 6 - polish\n\n${open}\nsprint: "6"\n${close}\n\n`;
    const marker = "## 4. After the last sprint";
    const sources = withOrder(marker, `${extra}${marker}`);
    const err = listFailure(sources.order);
    expect(err.exitCode).toBe(EXIT.INPUT);
    expect(err.message).toMatch(/Sprint 6 - polish/);
  });
});
