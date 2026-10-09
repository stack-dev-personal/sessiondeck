import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const R06_AGENTS = [
  "sd-orchestrator",
  "sd-executor-contract",
  "sd-executor-probe",
  "sd-executor-hub",
  "sd-executor-web",
  "sd-executor-infra",
  "sd-reviewer",
  "sd-security-reviewer",
  "sd-verifier",
];

const PLANNING_FILES = [
  "docs/planning/00-open-decisions.md",
  "docs/planning/01-architecture.md",
  "docs/planning/02-roadmap.md",
  "docs/planning/03-design-system.md",
  "docs/planning/04-session-map.md",
  ...[
    "phase-0-contract",
    "phase-1-probe",
    "phase-2-hub",
    "phase-3-board",
    "phase-4-content",
    "phase-5-atlas",
    "phase-6-layouts",
    "phase-7-harbor",
    "phase-8-cockpit",
  ].map((name) => `docs/planning/phases/${name}.md`),
];

describe("R0.6 project scaffold files", () => {
  it.each(R06_AGENTS)("agent file %s exists", (name) => {
    expect(existsSync(join(repoRoot, ".claude", "agents", `${name}.md`))).toBe(true);
  });

  it.each(PLANNING_FILES)("planning file %s exists", (path) => {
    expect(existsSync(join(repoRoot, path))).toBe(true);
  });
});
