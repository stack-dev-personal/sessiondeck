#!/usr/bin/env node
/**
 * Fixture capture hook for Claude Code (R0.7 tooling).
 *
 * Hook mode (default):  stdin payload -> <out>/<hook_event_name>/<epoch ms>-<sid>-<rand>.json
 * --statusline:         same under <out>/statusLine/, then prints one short line
 * --subagents:          same under <out>/subagentStatusLine/, prints nothing
 * --out <dir>:          capture directory (else env SESSIONDECK_CAPTURE_DIR; there is no default,
 *                       and without either nothing is written)
 * --marker <id>:        ignored; lets the installer recognise its own settings entries
 *
 * Contract with Claude Code: never write to stdout in hook mode (SessionStart and
 * UserPromptSubmit stdout is added to the model context) and always exit 0 (exit 2 blocks some
 * events). Every failure is reduced to a log line with an error code, never payload content.
 * Payload content is only ever written to disk as data; it is never executed or interpolated.
 */
import { STATUSLINE_TEXT } from "./lib/capture-config.mjs";
import { captureOnce, readAll } from "./lib/capture-core.mjs";
import { resolveOutDir } from "./lib/capture-paths.mjs";
import { logCaptureError } from "./lib/capture-store.mjs";

/**
 * Flags: --statusline, --subagents, --out <dir>, and --marker <id> (carried only so the
 * installer can recognise its own entries; ignored here). A missing --out value is an error, not
 * a reason to guess a directory.
 * @param {string[]} argv
 * @returns {{ mode: import("./lib/capture-core.mjs").CaptureMode, outFlag: string | undefined }}
 */
function parseArgs(argv) {
  const outIndex = argv.indexOf("--out");
  const outFlag = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && (outFlag === undefined || outFlag === "" || outFlag.startsWith("--"))) {
    throw new Error("--out needs a value");
  }
  if (argv.includes("--statusline")) return { mode: "statusline", outFlag };
  if (argv.includes("--subagents")) return { mode: "subagents", outFlag };
  return { mode: "hook", outFlag };
}

/** @param {string[]} argv */
function modeOf(argv) {
  if (argv.includes("--statusline")) return "statusline";
  return argv.includes("--subagents") ? "subagents" : "hook";
}

async function main() {
  let out = "";
  let mode = /** @type {import("./lib/capture-core.mjs").CaptureMode} */ ("hook");
  try {
    mode = modeOf(process.argv.slice(2));
    const args = parseArgs(process.argv.slice(2));
    out = resolveOutDir(args.outFlag, process.env);
    const { text, truncated } = await readAll(process.stdin);
    await captureOnce({ mode, out, text, truncated, now: Date.now() });
  } catch (error) {
    if (out) await logCaptureError(out, "capture", error);
  }
  if (mode === "statusline") process.stdout.write(`${STATUSLINE_TEXT}\n`);
}

try {
  await main();
} catch {
  // Last resort: never fail the hook.
}
process.exitCode = 0;
