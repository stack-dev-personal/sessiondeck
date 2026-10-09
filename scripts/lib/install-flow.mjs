import { join, resolve } from "node:path";
import { ensureOutDir } from "./capture-store.mjs";
import { toPosix } from "./capture-paths.mjs";
import { describeLeftovers, missingFiles, removeDeployed } from "./deploy-remove.mjs";
import { realpathLoose } from "./fs-roots.mjs";
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
import { foldPath } from "./settings-match.mjs";
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
 * Everything install needs before it writes: validated inputs and the planned result.
 * @param {Flow} c
 */
async function plan(c) {
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
  return { outDir, deployDir, current, prior, files, stale, built, state };
}

/**
 * Removes the copy a previous install left in a different directory (SESSIONDECK_CAPTURE_HOME
 * changed between runs). Only files that still match the recorded hashes are deleted.
 * @param {Flow} c @param {string} deployDir
 * @param {import("./settings-model.mjs").SidecarState | undefined} prior
 */
async function dropPriorCopy(c, deployDir, prior) {
  if (!prior?.deploy) return;
  const old = await realpathLoose(prior.deploy.dir);
  if (foldPath(old) === foldPath(deployDir)) return;
  const result = await removeDeployed(prior.deploy);
  c.print([
    `Previous deployed copy in ${prior.deploy.dir}: ${result.removed.length} file(s) removed`,
    ...describeLeftovers(result),
  ]);
}

/**
 * Registers the capture hook. Previews by default; writes only when c.apply is set. The deployed
 * copy is written first (the settings must not point at files that are not there), and the files
 * this run created are removed again if a later step fails, so an aborted run leaves no orphans.
 * @param {Flow} c
 * @returns {Promise<number>} exit code
 */
export async function install(c) {
  const p = await plan(c);
  printDiff(
    c,
    diffLines(
      describeCapture(p.current.settings, p.prior?.entries),
      describeCapture(p.built.settings, p.state.entries),
    ),
  );
  const settingsSame = sameContent(p.built.settings, p.current.settings) && p.prior !== undefined;
  c.print([
    p.stale.length > 0
      ? `Deployed copy: ${p.stale.length} file(s) to write in ${p.deployDir}`
      : `Deployed copy: up to date in ${p.deployDir}`,
  ]);
  if (settingsSame && p.stale.length === 0) {
    c.print(["Already installed; nothing to write."]);
    return 0;
  }
  if (!c.apply) {
    c.print([DRY_RUN_LINE, ...STATUS_NOTE]);
    return 0;
  }
  const created = await missingFiles(p.deployDir, p.files, p.stale);
  await writeDeployed(p.deployDir, p.files, p.stale);
  try {
    await ensureOutDir(p.outDir);
    await sweepInstallTemps(c.target);
    if (settingsSame) {
      c.print(["Deployed copy refreshed; settings were already current."]);
      return 0;
    }
    await commitAndReport(c, p);
  } catch (error) {
    await removeDeployed({ dir: p.deployDir, files: created }).catch(() => undefined);
    throw error;
  }
  await dropPriorCopy(c, p.deployDir, p.prior);
  return 0;
}

/**
 * @param {Flow} c @param {Awaited<ReturnType<typeof plan>>} p
 */
async function commitAndReport(c, p) {
  const backup = await commitSettings({
    target: c.target,
    original: p.current.buffer,
    next: serialize(p.built.settings),
    state: p.state,
  });
  c.print([
    backup ? `Backup: ${backup}` : "Backup: none (the settings file did not exist)",
    `Capture directory: ${p.outDir}`,
    "Running sessions pick up the change as soon as the file is written.",
    ...STATUS_NOTE,
  ]);
}
