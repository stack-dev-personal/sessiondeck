#!/usr/bin/env node
/**
 * Registers (and removes) the sessiondeck fixture capture hook in the Claude Code settings file.
 *
 *   node scripts/capture-install.mjs [--dry-run] [--out <dir>]
 *   node scripts/capture-install.mjs --uninstall [--dry-run]
 *
 * Target: settings.json inside CLAUDE_CONFIG_DIR if set, else inside ~/.claude. The target path is
 * printed first. Only a diff of the lines this run adds or removes is printed, never the file.
 * Exit codes: 0 ok, 1 aborted (nothing written), 2 usage error.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultOutDir, toPosix } from "./lib/capture-paths.mjs";
import { describeCapture, diffLines } from "./lib/settings-diff.mjs";
import {
  createBackup,
  readSettings,
  SettingsReadError,
  readSidecar,
  removeSettings,
  removeSidecar,
  resolveTarget,
  serialize,
  writeAtomic,
  writeSidecar,
} from "./lib/settings-files.mjs";
import {
  applyInstall,
  applyUninstall,
  SettingsShapeError,
  validateSettings,
} from "./lib/settings-model.mjs";

const SCRIPT_PATH = toPosix(
  resolve(fileURLToPath(new URL("./capture-fixtures.mjs", import.meta.url))),
);
const STATUS_NOTE = [
  "NOTE: your status line is replaced by a placeholder for the capture period.",
  "Run with --uninstall to remove the capture hooks and restore the previous status line.",
];
const USAGE = "usage: capture-install.mjs [--uninstall] [--dry-run] [--out <dir>]";

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    uninstall: false,
    dryRun: false,
    out: /** @type {string | undefined} */ (undefined),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out" && argv[i + 1] !== undefined) opts.out = argv[++i];
    else throw new UsageError(`unknown or incomplete argument: ${arg}`);
  }
  return opts;
}

class UsageError extends Error {}

/** Structural equality, so a reformatting-only difference does not count as a change. */
function sameContent(/** @type {unknown} */ a, /** @type {unknown} */ b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @param {string[]} lines */
function print(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** @param {string[]} diff */
function printDiff(diff) {
  print(diff.length > 0 ? ["Changes:", ...diff] : ["Changes: none"]);
}

/**
 * @param {string} target
 * @param {{ dryRun: boolean, out: string | undefined }} opts
 */
async function install(target, opts) {
  const outDir = toPosix(resolve(opts.out ?? defaultOutDir()));
  const current = await readSettings(target);
  validateSettings(current.settings);
  const prior = await readSidecar(target);
  const { settings, state } = applyInstall(
    /** @type {Record<string, unknown>} */ (current.settings),
    { scriptPath: SCRIPT_PATH, outDir },
    prior,
    current.exists,
  );
  const diff = diffLines(
    describeCapture(current.settings, SCRIPT_PATH),
    describeCapture(settings, SCRIPT_PATH),
  );
  printDiff(diff);
  const text = serialize(settings);
  if (sameContent(settings, current.settings))
    return print(["Already installed; nothing to write."]);
  if (opts.dryRun) return print(["Dry run: nothing was written.", ...STATUS_NOTE]);
  await writeSidecar(target, state);
  const backup = current.exists ? await createBackup(target) : undefined;
  await writeAtomic(target, text);
  print([
    backup ? `Backup: ${backup}` : "Backup: none (the settings file did not exist)",
    `Capture directory: ${outDir}`,
    ...STATUS_NOTE,
  ]);
}

/**
 * @param {string} target
 * @param {{ dryRun: boolean }} opts
 */
async function uninstall(target, opts) {
  const current = await readSettings(target);
  if (!current.exists) return print(["Nothing to uninstall: no settings file."]);
  validateSettings(current.settings);
  const state = await readSidecar(target);
  const settings = applyUninstall(
    /** @type {Record<string, unknown>} */ (current.settings),
    SCRIPT_PATH,
    state,
  );
  printDiff(
    diffLines(
      describeCapture(current.settings, SCRIPT_PATH),
      describeCapture(settings, SCRIPT_PATH),
    ),
  );
  const text = serialize(settings);
  if (sameContent(settings, current.settings)) {
    if (!opts.dryRun) await removeSidecar(target);
    return print(["Nothing to uninstall: no capture entries found."]);
  }
  if (opts.dryRun) return print(["Dry run: nothing was written."]);
  const backup = await createBackup(target);
  const emptyNewFile = state?.createdFile === true && Object.keys(settings).length === 0;
  if (emptyNewFile) await removeSettings(target);
  else await writeAtomic(target, text);
  await removeSidecar(target);
  print([
    `Backup: ${backup}`,
    "Capture hooks removed. Earlier install backups were left in place.",
  ]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = resolveTarget(process.env);
  print([`Target settings file: ${target}`]);
  if (opts.uninstall) await uninstall(target, opts);
  else await install(target, opts);
}

try {
  await main();
} catch (error) {
  const known =
    error instanceof UsageError ||
    error instanceof SettingsShapeError ||
    error instanceof SettingsReadError;
  const message = known && error instanceof Error ? error.message : "unexpected error";
  process.stderr.write(`capture-install: ${message}\n`);
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
