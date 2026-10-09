import { describeLeftovers, removeDeployed } from "./deploy-remove.mjs";
import { resolveDeployDir } from "./deploy.mjs";
import { realpathLoose } from "./fs-roots.mjs";
import { DRY_RUN_LINE, printDiff, sameContent } from "./install-flow.mjs";
import { printable } from "./printable.mjs";
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
import { applyUninstall, STATUS_KEYS, validateSettings } from "./settings-model.mjs";

/** @typedef {import("./install-flow.mjs").Flow} Flow */
/** @typedef {import("./settings-model.mjs").SidecarState} SidecarState */

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const FIXTURES_RAW_DIR = "packages/contract/fixtures/raw";
const CHECKOUT_PLACEHOLDER = "<checkout>";

/** @param {string} text @returns {string} text in single quotes for PowerShell */
const psQuote = (text) => `'${text.replaceAll("'", "''")}'`;
/** @param {string} text @returns {string} text in single quotes for a POSIX shell */
const shQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The two commands that copy the CONTENTS of the raw directory into the S0b checkout, creating the
 * target when it does not exist (a fresh checkout has none, it is gitignored). One per shell.
 * @param {string} raw printable path of the raw directory
 * @returns {string[]}
 */
export function copyCommands(raw) {
  const target = `${CHECKOUT_PLACEHOLDER}/${FIXTURES_RAW_DIR}`;
  return [
    "PowerShell:",
    `  New-Item -ItemType Directory -Force ${psQuote(target)}; Copy-Item -Recurse -Force ${psQuote(`${raw}/*`)} ${psQuote(target)}`,
    "bash:",
    `  mkdir -p ${shQuote(target)} && cp -R ${shQuote(`${raw}/.`)} ${shQuote(`${target}/`)}`,
  ];
}

/**
 * What happens to the raw captures: nothing, and what the user does with them next.
 * @param {string | undefined} outDir recorded capture directory, already confirmed and printable
 * @returns {string[]}
 */
export function describeRaw(outDir) {
  if (outDir === undefined)
    return ["The state file records no capture directory; raw captures were not touched."];
  return [
    `Raw captures were NOT deleted and stay in: ${outDir}`,
    "Next step: copy the contents of that directory into the checkout where the fixture session",
    `(S0b, branch p0/fixtures) runs: ${FIXTURES_RAW_DIR}/ there. Replace ${CHECKOUT_PLACEHOLDER} with that checkout.`,
    "First confirm the target is ignored; run this in that checkout, it must print a matching rule:",
    `  git check-ignore -v ${FIXTURES_RAW_DIR}/x`,
    ...copyCommands(outDir),
    "The captures are unscrubbed: never commit or share them. Delete the directory yourself once",
    "S0b has the copy.",
  ];
}

/**
 * The recorded capture directory, but only when it equals the --out value of the entries this run
 * removed; a state file cannot make the uninstaller print an arbitrary path as "your captures".
 * @param {SidecarState | undefined} state
 * @returns {string | undefined}
 */
export function confirmedOutDir(state) {
  const args = state?.entries?.hook.args ?? [];
  const given = args[args.indexOf("--out") + 1];
  return state?.outDir !== undefined && args.includes("--out") && given === state.outDir
    ? state.outDir
    : undefined;
}

/** @param {SidecarState | undefined} state */
function rawLines(state) {
  const confirmed = confirmedOutDir(state);
  if (state?.outDir !== undefined && confirmed === undefined) {
    return [
      "The state file names a capture directory that does not match the --out value of the removed",
      "entries, so it is not printed. Raw captures were not touched; find them in that --out value.",
    ];
  }
  return describeRaw(confirmed === undefined ? undefined : printable(confirmed));
}

/**
 * Whether the deploy directory still holds the raw captures. Both sides are resolved first, so an
 * 8.3 name, a junction or a symlink in either path does not hide the match.
 * @param {string | undefined} outDir @param {string} deployDir
 */
async function holdsRaw(outDir, deployDir) {
  if (outDir === undefined) return false;
  try {
    const [out, deploy] = await Promise.all([realpathLoose(outDir), realpathLoose(deployDir)]);
    return isInside(foldPath(deploy), foldPath(out));
  } catch {
    return false; // only the wording of one message depends on this
  }
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
  if (state.deploy)
    c.print([`The deployed copy was left in place: ${printable(state.deploy.dir)}`]);
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
        `  state file: ${printable(deploy.dir)}`,
        `  this run:   ${printable(resolved)}`,
        "Run again with SESSIONDECK_CAPTURE_HOME set to the first path if that is where you installed,",
        "or delete that directory yourself (UNINSTALL.txt inside it lists what belongs to the capture).",
      ],
    };
  }
  const result = await removeDeployed(deploy);
  const lines = [`Deployed copy removed (${result.removed.length} file(s)).`];
  if (result.kept) {
    const why = (await holdsRaw(outDir, deploy.dir)) ? "the raw captures" : "other files";
    lines.push(`Directory kept because it holds ${why}: ${printable(deploy.dir)}`);
  }
  lines.push(...describeLeftovers(result));
  return { code: result.refused === undefined ? EXIT_OK : EXIT_FAILED, lines };
}

/**
 * One line when a previous status line was put back from the state file, which the user can have
 * edited: it runs a command, so they are told to look at it.
 * @param {Record<string, unknown>} next @param {SidecarState | undefined} state
 * @returns {string[]}
 */
function restoredLines(next, state) {
  const restored = STATUS_KEYS.filter((key) => {
    const previous = state?.previous[key];
    return previous?.present === true && sameContent(next[key], previous.value);
  });
  if (restored.length === 0) return [];
  return [
    `Restored from the state file: ${restored.join(", ")}. Check what it runs before you keep it.`,
  ];
}

/**
 * @param {Flow} c @param {SidecarState | undefined} state
 * @param {Record<string, unknown>} next the settings as written
 * @returns {Promise<number>} exit code
 */
async function finish(c, state, next) {
  /** @type {string[]} */
  const lines = ["Capture hooks removed.", ...restoredLines(next, state)];
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
  lines.push(...rawLines(state));
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
  return finish(c, state, next);
}
