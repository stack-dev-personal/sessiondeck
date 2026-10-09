import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SHA_NOT_APPLICABLE,
  SMOKE_PROMPT,
  listPackages,
  loadSources,
  packageSummary,
  renderPrompt,
} from "../sprint/render-prompt.mjs";
import { extractPreamble } from "../sprint/lib/markdown-extract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sources = loadSources(repoRoot);
const packages = listPackages(sources.order);
const SHA = "0123abc";
const PASS_THROUGH = ["{SESSION_ID}", "{SESSION_BRANCH}"];
const TOKEN = /\{[A-Z][A-Z_ ]*[A-Z]\}/g;

/** Renders with SHA unless an explicit value (including undefined) is passed as the second argument. */
function render(sprintId: string, ...sha: [] | [string | undefined]): string {
  return renderPrompt({ sources, sprintId, contractSha: sha.length === 0 ? SHA : sha[0] });
}

describe("sprint prompt renderer: one test per package block in MINI-SPRINT-ORDER.md", () => {
  it("finds exactly the sprints 0 to 5", () => {
    expect(packages.map((p) => p.sprint)).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it.each(packages.map((p) => [p.sprint, p] as const))(
    "sprint %s renders completely",
    (_id, pkg) => {
      const out = render(pkg.sprint);
      expect(out).toContain(`sprint/${pkg.sprint}-${pkg.slug}`);
      expect(out).toContain(pkg.branch);
      expect(out).toContain(`sprint ${pkg.sprint} (${pkg.name})`);
      for (const s of pkg.sessions) {
        expect(out).toContain(
          `- ${s.id} | handoff: docs/handoffs/${s.handoff} | branch: ${s.branch}`,
        );
        expect(out).toContain(`phase: ${s.phase}`);
      }
      expect(out).toContain(pkg.merge_order.join(" -> "));
      for (const check of pkg.integration_checks) expect(out).toContain(check);
      for (const gate of pkg.user_gates) expect(out).toContain(gate);
      for (const item of pkg.needs_laptop ?? []) expect(out).toContain(item);
      if (pkg.notes !== undefined) expect(out).toContain(pkg.notes);
      expect(out).toContain(`Max parallel phase managers: ${pkg.max_parallel}`);

      // needs_laptop and notes may quote shell syntax such as ${CLAUDE_PROJECT_DIR}; they are values.
      let rest = out;
      for (const v of [
        ...(pkg.needs_laptop ?? []),
        ...(pkg.notes === undefined ? [] : [pkg.notes]),
      ]) {
        rest = rest.replace(v, "");
      }
      const leftover = (rest.match(TOKEN) ?? []).filter((t) => !PASS_THROUGH.includes(t));
      expect(leftover).toEqual([]);
      expect(rest).toContain("{SESSION_ID}");
      expect(out).not.toContain("\r");
      expect(out.endsWith("\n")).toBe(true);
      expect(out.endsWith("\n\n")).toBe(false);
    },
  );

  it("renders every session field a model needs, with the optional ones when present", () => {
    const out = render("5");
    expect(out).toContain(
      '- S15 | handoff: docs/handoffs/S13-s14-s15-cockpit.md | branch: p8/electron | phase: 8 | depends_on: S14 | security_gated: no | lane: B | goal: "S15 part only" | optional: yes',
    );
    expect(out).toContain("security_gated: yes");
    const zero = render("0");
    expect(zero).toContain('user_gate: "capture hook installed and one working day');
    expect(zero).toContain("depends_on: none");
  });

  it("renders user gates as none when the list is empty and as lines otherwise", () => {
    expect(render("2")).toContain("- User gates before start: none");
    expect(render("4")).toMatch(/- User gates before start:\n {2}- box exists;/);
  });

  it("appends needs_laptop and notes inside the package list, after the template's own bullets", () => {
    const out = render("1");
    const bullets = out.indexOf("- Max parallel phase managers: 3");
    const laptop = out.indexOf("- Needs laptop confirmation");
    const notes = out.indexOf("- Notes: S1 and S2");
    const setup = out.indexOf("\nSetup\n");
    expect(bullets).toBeGreaterThan(-1);
    expect(laptop).toBeGreaterThan(bullets);
    expect(notes).toBeGreaterThan(laptop);
    expect(setup).toBeGreaterThan(notes);
  });

  it("leaves no trailing spaces on any line", () => {
    for (const p of packages) expect(render(p.sprint)).not.toMatch(/[ \t]+\n/);
  });
});

describe("sprint prompt renderer: preamble, contract sha, smoke, package json", () => {
  it("embeds the preamble once with its own placeholders filled", () => {
    const out = render("1");
    const marker = "Context, in this order, before any action:";
    expect(out.split(marker).length - 1).toBe(1);
    expect(out).toContain("- Sprint: 1 (mvp); joined branch: sprint/1-mvp");
    expect(out).toContain("- State directory: /state/1/ (bind-mounted");
    expect(out).toContain(`- Contract commit: ${SHA} (after Sprint 0;`);
    expect(out).toContain("- Concurrency allowed for this process: 3");
    expect(out.startsWith(marker)).toBe(true);
    expect(extractPreamble(sources.promptBook)).toContain("{CONTRACT_SHA}");
  });

  it("renders n/a for sprint 0 without a contract sha, and the given value when present", () => {
    expect(render("0", undefined)).toContain(`Contract commit: ${CONTRACT_SHA_NOT_APPLICABLE} (`);
    expect(render("0", "deadbee")).toContain("Contract commit: deadbee (");
  });

  it("keeps the two pass-through placeholders literal and fills nothing else around them", () => {
    const out = render("2");
    expect(out).toContain("{SESSION_ID}");
    expect(out).toContain("{SESSION_BRANCH}");
  });

  it("renders the smoke prompt exactly, with no preamble and no contract sha needed", () => {
    expect(SMOKE_PROMPT).toBe("write /state/smoke/status.json with state green and exit");
    expect(renderPrompt({ sources, sprintId: "smoke" })).toBe(
      "write /state/smoke/status.json with state green and exit\n",
    );
  });

  it("reports runs_in local for sprint 0 and container for sprint 1", () => {
    expect(packageSummary({ sources, sprintId: "0" }).runs_in).toBe("local");
    const one = packageSummary({ sources, sprintId: "1" });
    expect(one.runs_in).toBe("container");
    expect(Object.keys(one)).toEqual([
      "sprint",
      "name",
      "slug",
      "branch",
      "runs_in",
      "max_parallel",
      "depends_on",
      "user_gates",
      "sessions",
      "merge_order",
    ]);
    expect(one.merge_order).toEqual(["S3", "S4", "S1", "S2", "S5", "S6"]);
    expect(one.branch).toBe("sprint/1-mvp");
  });

  it("has a minimal container package for smoke", () => {
    const s = packageSummary({ sources, sprintId: "smoke" });
    expect(s).toMatchObject({ sprint: "smoke", runs_in: "container", sessions: [] });
  });

  it("renders the same text from CRLF inputs as from LF inputs", () => {
    const crlf = {
      promptBook: sources.promptBook.replace(/\r?\n/g, "\r\n"),
      order: sources.order.replace(/\r?\n/g, "\r\n"),
    };
    expect(crlf.order).toContain("\r\n");
    for (const p of packages) {
      const a = renderPrompt({ sources, sprintId: p.sprint, contractSha: SHA });
      const b = renderPrompt({ sources: crlf, sprintId: p.sprint, contractSha: SHA });
      expect(b).toBe(a);
    }
    expect(listPackages(crlf.order)).toEqual(packages);
  });
});
