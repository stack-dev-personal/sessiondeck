import { describeLeftovers, removeDeployed } from "./deploy-remove.mjs";
import { resolveDeployDir } from "./deploy.mjs";
import { realpathLoose } from "./fs-roots.mjs";
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
import { isInside } from "./capture-paths.mjs";
import { findRemaining, foldPath } from "./settings-match.mjs";
import { applyUninstall, validateSettings } from "./settings-model.mjs";

/** @typedef {import("./install-flow.mjs").Flow} Flow */
/** @typedef {import("./settings-model.mjs").SidecarState} SidecarState */

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const FIXTURES_RAW_TARGET = "packages/contract/fixtures/raw/";

/**
 * What happens to the raw captures: nothing, and what the user does with them next.
 * @param {string | undefined} outDir recorded capture directory
 * @returns {string[]}
 */
export function describeRaw(outDir) {
  if (outDir === undefined)
    return ["The state file records no capture directory; raw captures were not touched."];
  return [
    `Raw captures were NOT deleted and stay in: ${outDir}`,
    `Next step: copy that directory to ${FIXTURES_RAW_TARGET} of the checkout where the fixture`,
    "session (S0b, branch p0/fixtures) runs; it is gitignored there. The captures are unscrubbed:",
    "never commit or share them. Delete the directory yourself once S0b has the copy.",
  ];
}

/** @param {string | undefined} outDir @param {string} deployDir */
function holdsRaw(outDir, deployDir) {
  return outDir !== undefined && isInside(foldPath(deployDir), foldPath(outDir));
}

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

/**
 * Removes the deployed copy, but only from the directory this run resolves to. A state file that
 * names another directory is not followed: both paths are printed and the exit code is 1.
 * @param {Flow} c @param {import("./settings-model.mjs").DeployRecord} deploy
 * @param {string | undefined} outDir
 * @returns {Promise<{ lines: string[], code: number }>}
 */
async function dropDeployed(c, deploy, outDir) {
  const resolved = await realpathLoose(resolveDeployDir(c.env, c.home));
  const recorded = await realpathLoose(deploy.dir);
  if (foldPath(resolved) !== foldPath(recorded)) {
    return {
      code: EXIT_FAILED,
      lines: [
        "The deployed copy was NOT removed: the state file names a different directory than this run uses.",
        `  state file: ${deploy.dir}`,
        `  this run:   ${resolved}`,
        "Run again with SESSIONDECK_CAPTURE_HOME set to the first path if that is where you installed,",
        "or delete that directory yourself (UNINSTALL.txt inside it lists what belongs to the capture).",
      ],
    };
  }
  const result = await removeDeployed(deploy);
  const lines = [`Deployed copy removed (${result.removed.length} file(s)).`];
  if (result.kept) {
    const why = holdsRaw(outDir, deploy.dir) ? "the raw captures" : "other files";
    lines.push(`Directory kept because it holds ${why}: ${deploy.dir}`);
  }
  lines.push(...describeLeftovers(result));
  return { code: result.refused === undefined ? EXIT_OK : EXIT_FAILED, lines };
}

/**
 * @param {Flow} c @param {SidecarState | undefined} state
 * @returns {Promise<number>} exit code
 */
async function finish(c, state) {
  /** @type {string[]} */
  const lines = ["Capture hooks removed."];
  let code = EXIT_OK;
  if (state?.deploy) {
    const dropped = await dropDeployed(c, state.deploy, state.outDir);
    lines.push(...dropped.lines);
    code = dropped.code;
  } else {
    lines.push(
      "No state file was found: a previous status line could not be restored (see backups).",
    );
  }
  lines.push(...describeRaw(state?.outDir));
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
  return code;
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
  return finish(c, state);
}
