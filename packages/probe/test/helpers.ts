import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
export const probeRoot = join(here, "..");
export const hookPath = join(probeRoot, "dist", "hook.mjs");
/** Bun-compiled program (hook, statusline, subagents) for this platform; null when not built. */
export function exePathFor(name: "hook" | "statusline" | "subagents"): string | null {
  const dir = join(
    probeRoot,
    "dist",
    "exe",
    process.platform === "win32" ? "windows-x64" : "linux-x64",
  );
  const file = join(dir, `${name}${process.platform === "win32" ? ".exe" : ""}`);
  return existsSync(file) ? file : null;
}
export const hookExePath: string | null = exePathFor("hook");

/** Test-only switch (CI sets it): a missing exe fails the exe suites instead of skipping them. */
export const requireExe = process.env["SD_REQUIRE_EXE"] === "1";

/**
 * describe() for a suite that needs a built exe. Missing exe: skipped with a printed reason, or a
 * single failing test when SD_REQUIRE_EXE=1, so CI cannot go green without running the exe tests.
 */
export function describeExe(label: string, exe: string | null, body: () => void): void {
  if (exe !== null) {
    describe(label, body);
  } else if (requireExe) {
    describe(label, () => {
      it("the exe is built (SD_REQUIRE_EXE=1)", () => {
        throw new Error(`${label}: exe missing; run pnpm -F @sessiondeck/probe build:exe`);
      });
    });
  } else {
    console.warn(`[exe] skipped: ${label} (exe not built: pnpm -F @sessiondeck/probe build:exe)`);
    describe.skip(label, body);
  }
}

export const fixturesDir = join(probeRoot, "..", "contract", "fixtures");

export interface HookRun {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface HookOpts {
  /** Probe home passed as `--home` (the way `probe install` registers the hook). */
  home?: string;
  host?: string;
  env?: Record<string, string>;
  args?: string[];
}

export function hookArgs(o: HookOpts): string[] {
  return [
    ...(o.home !== undefined ? ["--home", o.home] : []),
    ...(o.host !== undefined ? ["--host", o.host] : []),
    "--sessiondeck-probe",
    ...(o.args ?? []),
  ];
}

export function runHook(
  stdin: Buffer | string | null,
  opts: HookOpts,
  script: string = hookPath,
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const direct = !script.endsWith(".mjs");
    const child = spawn(
      direct ? script : process.execPath,
      [...(direct ? [] : [script]), ...hookArgs(opts)],
      {
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
    // The hook may exit before reading all of a large input; EPIPE is not a test failure.
    child.stdin.on("error", () => undefined);
    if (stdin === null) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

/** One fixture file path per hook event directory (the first file of each). */
export function fixturePerEvent(): { event: string; file: string }[] {
  const events = [
    "Notification",
    "PermissionRequest",
    "PostCompact",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
  ];
  return events.map((event) => {
    const files = readdirSync(join(fixturesDir, event))
      .filter((f) => f.endsWith(".json"))
      .sort();
    return { event, file: join(fixturesDir, event, files[0] as string) };
  });
}

export function readSpoolLines(spool: string): string[] {
  return readdirSync(spool)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => readFileSync(join(spool, f), "utf8").split("\n").filter(Boolean));
}
