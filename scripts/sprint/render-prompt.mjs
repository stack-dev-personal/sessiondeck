#!/usr/bin/env node
// Renders the level-1 (mini-sprint orchestrator) prompt for one sprint from PROMPT-BOOK.md and
// MINI-SPRINT-ORDER.md. See scripts/README.md, "Sprint prompt renderer".
//
//   node scripts/sprint/render-prompt.mjs --sprint <id> [--contract-sha <sha>] [--out <file>]
//        [--package-json] [--repo-root <dir>]
//
// Exit codes: 0 ok, 2 usage, 3 malformed input or unfilled placeholder, 4 file read or write.
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendPackageExtras, fillTemplate, placeholderValues } from "./lib/fill-template.mjs";
import {
  extractLevel1Template,
  extractPackageBlocks,
  extractPreamble,
  normalizeNewlines,
} from "./lib/markdown-extract.mjs";
import { checkNoCycle, parsePackageBlock } from "./lib/package-block.mjs";
import { EXIT, RenderError, ioError, usageError } from "./lib/render-errors.mjs";

export { EXIT, RenderError };

/** The smoke prompt, exactly as infra/sprint/README.md ("Smoke test") describes it. */
export const SMOKE_PROMPT = "write /state/smoke/status.json with state green and exit";

export const SMOKE_ID = "smoke";
export const SPRINT_ZERO_ID = "0";
/** Contract commit text for Sprint 0, which runs before a contract commit exists. */
export const CONTRACT_SHA_NOT_APPLICABLE = "n/a";

const PROMPT_BOOK_FILE = "PROMPT-BOOK.md";
const ORDER_FILE = "MINI-SPRINT-ORDER.md";
/** Letters, digits, and . _ / - only, so a SHA or tag cannot smuggle whitespace or braces. */
const CONTRACT_SHA_PATTERN = /^[A-Za-z0-9._/-]+$/;
const TRAILING_BLANKS = /[ \t]+$/gm;

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @typedef {import("./lib/package-block.mjs").SprintPackage} SprintPackage
 */

/**
 * @typedef {object} Sources
 * @property {string} promptBook text of PROMPT-BOOK.md
 * @property {string} order text of MINI-SPRINT-ORDER.md
 */

/**
 * @param {string} path
 * @returns {string}
 */
function readInput(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw ioError(`cannot read ${path} (${code}); pass --repo-root <dir> if it is elsewhere`);
  }
}

/**
 * @param {string} repoRoot
 * @returns {Sources}
 */
export function loadSources(repoRoot) {
  return {
    promptBook: readInput(join(repoRoot, PROMPT_BOOK_FILE)),
    order: readInput(join(repoRoot, ORDER_FILE)),
  };
}

/**
 * Every package block in MINI-SPRINT-ORDER.md, parsed and checked, in file order.
 * @param {string} order
 * @returns {SprintPackage[]}
 */
export function listPackages(order) {
  const packages = extractPackageBlocks(order).map((b) => parsePackageBlock(b.yaml, b.headingId));
  const ids = packages.map((p) => p.sprint);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    throw new RenderError(
      `${ORDER_FILE}: sprint ${dup} has more than one package block`,
      EXIT.INPUT,
    );
  }
  for (const p of packages) {
    const unknown = p.depends_on.find((d) => !ids.includes(d) || d === p.sprint);
    if (unknown !== undefined) {
      throw new RenderError(
        `${ORDER_FILE}, sprint ${p.sprint}: key "depends_on" names "${unknown}", which is not another sprint package id (${ids.join(", ")})`,
        EXIT.INPUT,
      );
    }
  }
  checkNoCycle(new Map(packages.map((p) => [p.sprint, p.depends_on])), ORDER_FILE, "sprint");
  return packages;
}

/**
 * @param {string} order
 * @param {string} sprintId
 * @returns {SprintPackage}
 */
export function findPackage(order, sprintId) {
  const packages = listPackages(order);
  const found = packages.find((p) => p.sprint === sprintId);
  if (found === undefined) {
    const valid = [...packages.map((p) => p.sprint), SMOKE_ID].join(", ");
    throw usageError(`unknown sprint "${sprintId}"; valid ids: ${valid}`);
  }
  return found;
}

/**
 * @param {string} sprintId
 * @param {string | undefined} given
 * @returns {string}
 */
function resolveContractSha(sprintId, given) {
  if (given === undefined) {
    if (sprintId === SPRINT_ZERO_ID) return CONTRACT_SHA_NOT_APPLICABLE;
    throw usageError(
      `sprint ${sprintId} needs --contract-sha <sha> (the contract commit on main); only sprint 0 may omit it`,
    );
  }
  if (!CONTRACT_SHA_PATTERN.test(given)) {
    throw usageError(`--contract-sha "${given}" may contain only letters, digits, and . _ / -`);
  }
  return given;
}

/**
 * Renders the prompt for one sprint. Returns LF text ending in one newline.
 * @param {object} args
 * @param {Sources} args.sources
 * @param {string} args.sprintId a sprint id from MINI-SPRINT-ORDER.md, or "smoke"
 * @param {string} [args.contractSha]
 * @returns {string}
 */
export function renderPrompt({ sources, sprintId, contractSha }) {
  if (sprintId === SMOKE_ID) return `${SMOKE_PROMPT}\n`;
  const pkg = findPackage(sources.order, sprintId);
  const sha = resolveContractSha(sprintId, contractSha);
  const preamble = extractPreamble(sources.promptBook);
  const template = extractLevel1Template(sources.promptBook);
  const filled = fillTemplate(template, preamble, placeholderValues(pkg, sha));
  const text = appendPackageExtras(filled, pkg).replace(TRAILING_BLANKS, "");
  return `${normalizeNewlines(text).replace(/\n+$/, "")}\n`;
}

/**
 * What the PowerShell launcher needs, without rendering. Smoke has a minimal built-in package.
 * @param {object} args
 * @param {Sources} args.sources
 * @param {string} args.sprintId
 * @returns {Record<string, unknown>}
 */
export function packageSummary({ sources, sprintId }) {
  if (sprintId === SMOKE_ID) {
    return {
      sprint: SMOKE_ID,
      name: SMOKE_ID,
      slug: SMOKE_ID,
      branch: null,
      runs_in: "container",
      max_parallel: 1,
      depends_on: [],
      user_gates: [],
      sessions: [],
      merge_order: [],
    };
  }
  const p = findPackage(sources.order, sprintId);
  return {
    sprint: p.sprint,
    name: p.name,
    slug: p.slug,
    branch: p.branch,
    runs_in: p.runs_in,
    max_parallel: p.max_parallel,
    depends_on: p.depends_on,
    user_gates: p.user_gates,
    sessions: p.sessions,
    merge_order: p.merge_order,
  };
}

/** Random part of the temp name, so a link planted under a guessed name is never opened. */
const TEMP_SUFFIX_BYTES = 8;
/** Create-only: fails with EEXIST on anything already there, including a planted link. */
const TEMP_OPEN_FLAG = "wx";

/**
 * @typedef {object} WriteIo
 * @property {(path: string) => { isSymbolicLink: () => boolean }} lstat
 * @property {(path: string) => void} [remove] temp file cleanup; replaceable so tests can fail it
 */

/** @type {WriteIo} */
const DEFAULT_WRITE_IO = { lstat: lstatSync };

/** @param {string} path */
function removeTemp(path) {
  rmSync(path, { force: true });
}

/** Error codes that mean the temp file is not there, so there is nothing left to remove. */
const TEMP_ABSENT_CODES = ["ENOENT", "ENOTDIR"];

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorCodeOf(error) {
  return error instanceof Error && "code" in error ? String(error.code) : "unknown";
}

/**
 * Removes the temp file after a failed write. A file standing where a directory should be gives
 * ENOTDIR on Linux (force only ignores ENOENT): the temp file was never created, so that is
 * treated like ENOENT and gives no note. Any other cleanup failure must not replace the real
 * error: it is returned as a note to append to it.
 * @param {string} tmp
 * @param {WriteIo} io
 * @returns {string}
 */
function discardTemp(tmp, io) {
  try {
    (io.remove ?? removeTemp)(tmp);
    return "";
  } catch (error) {
    const code = errorCodeOf(error);
    if (TEMP_ABSENT_CODES.includes(code)) return "";
    return `; temp file ${tmp} not removed (${code})`;
  }
}

/**
 * The output directory can be one a container writes to, so a link there could point anywhere on
 * the laptop. A symbolic link or a Windows junction at the destination is refused, not replaced.
 * @param {string} target
 * @param {WriteIo} io
 */
function assertNotLink(target, io) {
  let isLink = false;
  try {
    isLink = io.lstat(target).isSymbolicLink();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (isLink) throw ioError(`refusing to write ${target}: it is a symbolic link or junction`);
}

/**
 * Writes text with LF endings through a create-only temp file with a random name in the same
 * directory, then renames it over the destination. Refuses a destination that is a link.
 * @param {string} file
 * @param {string} text
 * @param {WriteIo} [io] replaceable so tests can report a link on any platform
 */
export function writeAtomic(file, text, io = DEFAULT_WRITE_IO) {
  const target = resolve(file);
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString("hex");
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${suffix}.tmp`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    assertNotLink(target, io);
    writeFileSync(tmp, text, { encoding: "utf8", flag: TEMP_OPEN_FLAG });
    renameSync(tmp, target);
  } catch (error) {
    const note = discardTemp(tmp, io);
    if (error instanceof RenderError) throw error;
    throw ioError(`cannot write ${target} (${errorCodeOf(error)})${note}`);
  }
}

const VALUE_FLAGS = Object.freeze({
  "--sprint": "sprint",
  "--contract-sha": "contractSha",
  "--out": "out",
  "--repo-root": "repoRoot",
});
const BOOLEAN_FLAGS = Object.freeze({ "--package-json": "packageJson" });

/**
 * @typedef {object} CliOptions
 * @property {string} [sprint]
 * @property {string} [contractSha]
 * @property {string} [out]
 * @property {string} [repoRoot]
 * @property {boolean} [packageJson]
 */

/**
 * Strict argument parsing: unknown flags, repeated flags, and missing values are usage errors.
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    const isValue = Object.hasOwn(VALUE_FLAGS, flag);
    const isBool = Object.hasOwn(BOOLEAN_FLAGS, flag);
    if (!isValue && !isBool) throw usageError(`unknown argument "${flag}"; ${usageText()}`);
    const key = isValue
      ? VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)]
      : BOOLEAN_FLAGS[/** @type {keyof typeof BOOLEAN_FLAGS} */ (flag)];
    if (Object.hasOwn(opts, key)) throw usageError(`${flag} was given more than once`);
    if (isBool) {
      opts[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`${flag} needs a value; ${usageText()}`);
    }
    opts[key] = value;
    i += 1;
  }
  return /** @type {CliOptions} */ (opts);
}

/** @returns {string} */
function usageText() {
  return (
    "usage: node scripts/sprint/render-prompt.mjs --sprint <id> [--contract-sha <sha>] " +
    "[--out <file>] [--package-json] [--repo-root <dir>]"
  );
}

/**
 * Runs the CLI without touching process state. Returns the exit code.
 * @param {object} args
 * @param {string[]} args.argv arguments after the script name
 * @param {(text: string) => void} args.stdout receives the whole output when --out is not given
 * @param {(text: string) => void} args.stderr
 * @param {string} [args.defaultRoot]
 * @returns {number}
 */
export function runCli({ argv, stdout, stderr, defaultRoot = defaultRepoRoot }) {
  try {
    const opts = parseArgs(argv);
    if (opts.sprint === undefined) throw usageError(`--sprint is required; ${usageText()}`);
    const sources = loadSources(resolve(opts.repoRoot ?? defaultRoot));
    const text = opts.packageJson
      ? `${JSON.stringify(packageSummary({ sources, sprintId: opts.sprint }), null, 2)}\n`
      : renderPrompt({ sources, sprintId: opts.sprint, contractSha: opts.contractSha });
    if (opts.out === undefined) stdout(text);
    else writeAtomic(opts.out, text);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof RenderError) {
      stderr(`render-prompt: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

/**
 * True when this file is the script node was started with. import.meta.url is a real path, while
 * argv[1] is the path as typed, so a junction or symlink must be resolved before comparing.
 * @returns {boolean}
 */
function isMainModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // As typed (what --preserve-symlinks-main reports) or resolved (the default).
    return (
      import.meta.url === pathToFileURL(resolve(entry)).href ||
      import.meta.url === pathToFileURL(realpathSync(entry)).href
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = runCli({
    argv: process.argv.slice(2),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
}
