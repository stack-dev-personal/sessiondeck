import { CLAUDECODE_ENV } from "./install-config.mjs";
import { DeployError, InstallRefused, UsageError } from "./install-errors.mjs";
import { install } from "./install-flow.mjs";
import {
  isDefaultTarget,
  resolveTarget,
  SettingsChangedError,
  SettingsReadError,
} from "./settings-files.mjs";
import { SettingsShapeError } from "./settings-model.mjs";
import { SidecarError } from "./sidecar.mjs";
import { uninstall } from "./uninstall-flow.mjs";

export const USAGE =
  "usage: capture-install.mjs [--apply | --dry-run] [--uninstall] [--out <dir>]   (--dry-run is the default: without --apply nothing is written)";
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const KNOWN_ERRORS = [
  UsageError,
  SettingsShapeError,
  SettingsReadError,
  SettingsChangedError,
  SidecarError,
  InstallRefused,
  DeployError,
];
const AGENT_REFUSAL = [
  "Refusing to touch the real Claude settings from inside a Claude Code session",
  `(${CLAUDECODE_ENV} is set and the target resolves to the default config directory).`,
  "Run this command yourself from a plain terminal.",
];

/**
 * @param {string[]} argv
 * @returns {{ uninstall: boolean, apply: boolean, dryRun: boolean, out: string | undefined }}
 */
export function parseArgs(argv) {
  const opts = {
    uninstall: false,
    apply: false,
    dryRun: false,
    out: /** @type {string | undefined} */ (undefined),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out" && value !== undefined && !value.startsWith("--")) {
      opts.out = value;
      i++;
    } else throw new UsageError(`unknown or incomplete argument: ${arg}`);
  }
  if (opts.apply && opts.dryRun) throw new UsageError("--apply and --dry-run cannot be combined");
  return opts;
}

/**
 * Runs the installer. Output goes through the callbacks so tests can run it in-process.
 * @param {{ argv: string[], env: NodeJS.ProcessEnv, home: string, realHome?: string,
 *   print: (text: string) => void, printErr: (text: string) => void }} io
 * @returns {Promise<number>} exit code: 0 ok, 1 refused or failed (nothing half-written), 2 usage
 */
export async function run({ argv, env, home, realHome, print, printErr }) {
  try {
    const opts = parseArgs(argv);
    if (env[CLAUDECODE_ENV] && (await isDefaultTarget(env, home, realHome))) {
      printErr(AGENT_REFUSAL.join("\n"));
      return EXIT_FAILED;
    }
    const target = resolveTarget(env, home);
    print(`Target settings file: ${target}`);
    const flow = {
      target,
      env,
      home,
      apply: opts.apply,
      out: opts.out,
      print: (/** @type {string[]} */ lines) => print(lines.join("\n")),
    };
    return await (opts.uninstall ? uninstall(flow) : install(flow));
  } catch (error) {
    const known = KNOWN_ERRORS.some((k) => error instanceof k);
    const message = known && error instanceof Error ? error.message : "unexpected error";
    printErr(`capture-install: ${message}`);
    if (error instanceof UsageError) printErr(USAGE);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}
