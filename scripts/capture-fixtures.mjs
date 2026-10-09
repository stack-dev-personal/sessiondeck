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
 *
 * The lib files are loaded with dynamic imports inside the try block, so a missing or broken
 * lib file ends in exit 0 with empty stdout and stderr instead of a module error on every event.
 * In --statusline mode the text is "sessiondeck capture on", or "sessiondeck capture full" once a
 * hook-event cap or the byte budget has stopped recording (the status-sample caps do not count),
 * or "sessiondeck capture error" when recording failed for another reason (the error log has the
 * code, the status line never echoes it; hook mode stays silent; the first refusal is one
 * line in the error log).
 */

/** @typedef {typeof import("./lib/capture-config.mjs")} Config */

/**
 * Flag: --out <dir>. The mode flags are read by modeOf alone, and --marker <id> is carried only so
 * the installer can recognise its own entries (ignored here). A missing --out value is an error,
 * not a reason to guess a directory.
 * @param {string[]} argv
 * @returns {{ outFlag: string | undefined }}
 */
function parseArgs(argv) {
  const outIndex = argv.indexOf("--out");
  const outFlag = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && (outFlag === undefined || outFlag === "" || outFlag.startsWith("--"))) {
    throw new Error("--out needs a value");
  }
  return { outFlag };
}

/**
 * @param {string[]} argv
 * @returns {import("./lib/capture-core.mjs").CaptureMode}
 */
function modeOf(argv) {
  if (argv.includes("--statusline")) return "statusline";
  return argv.includes("--subagents") ? "subagents" : "hook";
}

async function loadLib() {
  const [config, core, paths, store] = await Promise.all([
    import("./lib/capture-config.mjs"),
    import("./lib/capture-core.mjs"),
    import("./lib/capture-paths.mjs"),
    import("./lib/capture-store.mjs"),
  ]);
  return { config, core, paths, store };
}

async function main() {
  let out = "";
  let mode = /** @type {import("./lib/capture-core.mjs").CaptureMode} */ ("hook");
  /** @type {Awaited<ReturnType<typeof loadLib>> | undefined} */
  let lib;
  let full = false;
  let failed = false;
  try {
    mode = modeOf(process.argv.slice(2));
    lib = await loadLib();
    const args = parseArgs(process.argv.slice(2));
    out = lib.paths.resolveOutDir(args.outFlag, process.env);
    const { text, truncated } = await lib.core.readAll(process.stdin);
    full = (await lib.core.captureOnce({ mode, out, text, truncated, now: Date.now() })).full;
  } catch (error) {
    failed = true;
    if (lib && out) await lib.store.logCaptureError(out, "capture", error);
  }
  if (mode === "statusline" && lib) {
    const { STATUSLINE_TEXT, STATUSLINE_FULL_TEXT, STATUSLINE_ERROR_TEXT } = lib.config;
    const text = failed ? STATUSLINE_ERROR_TEXT : full ? STATUSLINE_FULL_TEXT : STATUSLINE_TEXT;
    process.stdout.write(`${text}\n`);
  }
}

try {
  await main();
} catch {
  // Last resort: never fail the hook.
}
process.exitCode = 0;
