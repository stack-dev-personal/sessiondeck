import { join, resolve } from "node:path";
import { ensureOutDir } from "./capture-store.mjs";
import { toPosix } from "./capture-paths.mjs";
import {
  assertOutsideWorkTree,
  findStale,
  readSources,
  resolveDeployDir,
  writeDeployed,
} from "./deploy.mjs";
import { HOOK_SCRIPT_NAME } from "./install-config.mjs";
import { checkOutDir, defaultOutDir } from "./out-dir-check.mjs";
import { describeCapture, diffLines } from "./settings-diff.mjs";
import {
  commitSettings,
  readSettings,
  readSidecar,
  serialize,
  sweepInstallTemps,
} from "./settings-files.mjs";
import { applyInstall, validateSettings } from "./settings-model.mjs";

/**
 * @typedef {object} Flow
 * @property {string} target settings file
 * @property {NodeJS.ProcessEnv} env
 * @property {string} home
 * @property {boolean} apply false means preview only
 * @property {string | undefined} out value of --out
 * @property {(lines: string[]) => void} print
 */

export const STATUS_NOTE = [
  "NOTE: your status line is replaced by a placeholder for the capture period.",
  "Run with --uninstall --apply to remove the capture hooks and restore the previous status line.",
];
export const DRY_RUN_LINE = "Dry run: nothing was written. Re-run with --apply to write.";

/**
 * Structural equality, so a reformatting-only difference does not count as a change.
 * @param {unknown} a @param {unknown} b
 */
export function sameContent(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @param {Flow} c @param {string[]} diff */
export function printDiff(c, diff) {
  c.print(diff.length > 0 ? ["Changes:", ...diff] : ["Changes: none"]);
}

/**
 * Registers the capture hook. Previews by default; writes only when c.apply is set.
 * @param {Flow} c
 * @returns {Promise<number>} exit code
 */
export async function install(c) {
  const outDir = toPosix(resolve(c.out ?? defaultOutDir()));
  await checkOutDir(outDir, c.env);
  const deployDir = await assertOutsideWorkTree(resolveDeployDir(c.env, c.home));
  const current = await readSettings(c.target);
  validateSettings(current.settings);
  const prior = await readSidecar(c.target);
  const files = await readSources();
  const stale = await findStale(deployDir, files);
  const scriptPath = toPosix(join(deployDir, HOOK_SCRIPT_NAME));
  const built = applyInstall(
    /** @type {Record<string, unknown>} */ (current.settings),
    { scriptPath, outDir },
    prior,
    current.exists,
  );
  const state = {
    ...built.state,
    deploy: { dir: deployDir, files: files.map(({ path, sha256 }) => ({ path, sha256 })) },
  };
  printDiff(
    c,
    diffLines(
      describeCapture(current.settings, prior?.entries),
      describeCapture(built.settings, state.entries),
    ),
  );
  const settingsSame = sameContent(built.settings, current.settings) && prior !== undefined;
  c.print([
    stale.length > 0
      ? `Deployed copy: ${stale.length} file(s) to write in ${deployDir}`
      : `Deployed copy: up to date in ${deployDir}`,
  ]);
  if (settingsSame && stale.length === 0) {
    c.print(["Already installed; nothing to write."]);
    return 0;
  }
  if (!c.apply) {
    c.print([DRY_RUN_LINE, ...STATUS_NOTE]);
    return 0;
  }
  await writeDeployed(deployDir, files, stale);
  await ensureOutDir(outDir);
  await sweepInstallTemps(c.target);
  if (settingsSame) {
    c.print(["Deployed copy refreshed; settings were already current."]);
    return 0;
  }
  const backup = await commitSettings({
    target: c.target,
    original: current.buffer,
    next: serialize(built.settings),
    state,
  });
  c.print([
    backup ? `Backup: ${backup}` : "Backup: none (the settings file did not exist)",
    `Capture directory: ${outDir}`,
    "Running sessions pick up the change as soon as the file is written.",
    ...STATUS_NOTE,
  ]);
  return 0;
}
