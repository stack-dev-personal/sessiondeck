import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEPLOY_FILES } from "../lib/install-config.mjs";
import { cleanupTempDirs, makeTempDir, runHookInProcess, SCRIPTS_DIR } from "./helpers";

afterAll(cleanupTempDirs);

// Claude Code adds SessionStart / UserPromptSubmit stdout to the model's context, so the deployed
// hook must never print. In-process tests spy on the writers; this static check covers the rest.
describe("the deployed hook files never print", () => {
  it.each(DEPLOY_FILES.map((f) => [f]))("%s has no console.* call", (file) => {
    expect(readFileSync(join(SCRIPTS_DIR, file), "utf8")).not.toMatch(/\bconsole\s*\./);
  });

  it.each(DEPLOY_FILES.filter((f) => f.startsWith("lib/")).map((f) => [f]))(
    "%s does not touch process.stdout / process.stderr",
    (file) => {
      expect(readFileSync(join(SCRIPTS_DIR, file), "utf8")).not.toMatch(
        /process\s*\.\s*(stdout|stderr)/,
      );
    },
  );

  it("the entry file writes only through process.stdout in its CLI wrapper, never stderr", () => {
    const source = readFileSync(join(SCRIPTS_DIR, "capture-fixtures.mjs"), "utf8");
    expect(source).not.toMatch(/process\s*\.\s*stderr/);
    expect(source.match(/process\s*\.\s*stdout/g)).toHaveLength(1);
  });
});

describe("runHookInProcess stray-output detection", () => {
  it.each(["log", "info", "debug", "warn", "error"])(
    "reports console.%s as output",
    async (method) => {
      const dir = makeTempDir();
      const script = join(dir, "noisy.mjs");
      writeFileSync(script, `export async function main() { console.${method}("stray"); }\n`);
      const r = await runHookInProcess(script, [], { sandbox: dir });
      expect(r.stdout + r.stderr).toContain("stray");
    },
  );

  it("reports direct process.stdout and process.stderr writes", async () => {
    const dir = makeTempDir();
    const script = join(dir, "noisy2.mjs");
    writeFileSync(
      script,
      'export async function main() { process.stdout.write("a"); process.stderr.write("b"); }\n',
    );
    const r = await runHookInProcess(script, [], { sandbox: dir });
    expect(r.stdout).toBe("a");
    expect(r.stderr).toBe("b");
  });
});
