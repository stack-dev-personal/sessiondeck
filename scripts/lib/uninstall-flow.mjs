import { removeDeployed } from "./deploy.mjs";
import { DRY_RUN_LINE, printDiff, sameContent } from "./install-flow.mjs";
import { describeCapture, diffLines } from "./settings-diff.mjs";
import {
  commitSettings,
  listBackups,
  readSettings,
  readSidecar,
  removeSidecar,
  serialize,
  sidecarPath,
} from "./settings-files.mjs";
import { findRemaining } from "./settings-match.mjs";
import { applyUninstall, validateSettings } from "./settings-model.mjs";

/** @typedef {import("./install-flow.mjs").Flow} Flow */
/** @typedef {import("./settings-model.mjs").SidecarState} SidecarState */

const EXIT_OK = 0;
const EXIT_FAILED = 1;

/** @param {Flow} c @param {string[]} remaining */
function printRemaining(c, remaining) {
  if (remaining.length === 0) return;
  c.print(["Capture entries are still present in:", ...remaining.map((r) => `  ${r}`)]);
}

/**
 * Fail closed: a state file exists but nothing in the settings matched it.
 * @param {Flow} c @param {string[]} remaining @param {SidecarState} state
 */
function reportUnmatched(c, remaining, state) {
  c.print([
    "No capture entries were recognised in the settings file, but the capture state file exists.",
    "Nothing was removed and the state file was kept:",
    `  ${sidecarPath(c.target)}`,
  ]);
  printRemaining(c, remaining);
  if (state.deploy) c.print([`The deployed copy was left in place: ${state.deploy.dir}`]);
  c.print([
    "If you removed the entries by hand, delete the state file and the deployed copy yourself.",
  ]);
  return EXIT_FAILED;
}

/** @param {Flow} c @param {SidecarState | undefined} state */
async function finish(c, state) {
  /** @type {string[]} */
  const lines = ["Capture hooks removed."];
  if (state?.deploy) {
    const { removed, kept } = await removeDeployed(state.deploy);
    lines.push(`Deployed copy removed (${removed.length} file(s)).`);
    if (kept) lines.push(`Directory kept because it holds other files: ${state.deploy.dir}`);
  } else {
    lines.push(
      "No state file was found: a previous status line could not be restored (see backups).",
    );
  }
  await removeSidecar(c.target);
  lines.push(`State file removed: ${sidecarPath(c.target)}`);
  const backups = await listBackups(c.target);
  if (backups.length > 0) {
    lines.push(
      "Backups made by the installer; each is a full copy of your settings and can contain tokens from env.",
      "Delete them yourself when you no longer need them:",
      ...backups.map((b) => `  ${b}`),
    );
  }
  c.print(lines);
}

/**
 * Removes our entries from the settings file. Previews by default.
 * @param {Flow} c
 * @returns {Promise<number>} exit code
 */
export async function uninstall(c) {
  const current = await readSettings(c.target);
  validateSettings(current.settings);
  const state = await readSidecar(c.target);
  const next = applyUninstall(/** @type {Record<string, unknown>} */ (current.settings), state);
  const remaining = findRemaining(next);
  printDiff(
    c,
    diffLines(
      describeCapture(current.settings, state?.entries),
      describeCapture(next, state?.entries),
    ),
  );
  if (sameContent(next, current.settings)) {
    if (state) return reportUnmatched(c, remaining, state);
    c.print(["Nothing to uninstall: no capture entries found."]);
    return EXIT_OK;
  }
  if (!c.apply) {
    c.print([DRY_RUN_LINE]);
    return EXIT_OK;
  }
  const emptyNewFile = state?.createdFile === true && Object.keys(next).length === 0;
  const backup = await commitSettings({
    target: c.target,
    original: current.buffer,
    next: emptyNewFile ? null : serialize(next),
    state: undefined,
  });
  c.print([`Backup: ${backup}`]);
  if (remaining.length > 0) {
    printRemaining(c, remaining);
    c.print(["The state file and the deployed copy were kept."]);
    return EXIT_FAILED;
  }
  await finish(c, state);
  return EXIT_OK;
}
