import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ensurePrivateDir } from "./atomic.ts";
import { realResolve, realSlash } from "./real-path.ts";

/** The Bun-compiled programs `probe install` puts in the hook, statusLine and subagent slots. */
export const EXE_NAMES = ["hook", "statusline", "subagents"] as const;
export type ExeName = (typeof EXE_NAMES)[number];

/** Raised for exe problems the user can fix; the CLI prints it and exits 1. */
export class ExeError extends Error {}

const BUILD_HINT = "pnpm -F @sessiondeck/probe build:exe";
/** Written by scripts/build-exe.mjs next to the exes: SHA-256 of each dist bundle they were built from. */
export const SOURCES_FILE = "sources.json";
const SOURCE_BUNDLES = ["hook.mjs", "statusline.mjs", "subagents.mjs"] as const;
const BIN_DIR = "bin";
const DIR_HASH_CHARS = 12;
const RETRY_CODES = ["EPERM", "EBUSY", "EACCES"];

export interface ExeFile {
  name: ExeName;
  src: string;
  fileName: string;
  sha256: string;
}

export interface ExePlan {
  /** Real, absolute install directory: <home>/bin/<content hash>. */
  dir: string;
  files: ExeFile[];
  /** Forward-slash command paths for settings.json. */
  paths: Record<ExeName, string>;
}

function platformTarget(): { dir: string; ext: string } {
  if (process.arch === "x64" && process.platform === "win32") {
    return { dir: "windows-x64", ext: ".exe" };
  }
  if (process.arch === "x64" && process.platform === "linux") return { dir: "linux-x64", ext: "" };
  throw new ExeError(`no prebuilt exe for ${process.platform}-${process.arch}; use --runtime node`);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (c) => h.update(c));
    s.on("error", rej);
    s.on("end", () => res(h.digest("hex")));
  });
}

/**
 * Refuses exes built from older bundles than dist/*.mjs (edit, `pnpm build`, forgot `build:exe`).
 * The default directory must carry sources.json; a custom --exe-dir is checked only when it has one.
 */
async function checkFresh(distDir: string, srcDir: string, custom: boolean): Promise<void> {
  let recorded: unknown;
  try {
    recorded = JSON.parse(await readFile(join(srcDir, SOURCES_FILE), "utf8"));
  } catch {
    if (custom) return;
    throw new ExeError(
      `the exes in ${srcDir} have no readable ${SOURCES_FILE}, so they cannot be matched to dist/*.mjs; rebuild them with \`${BUILD_HINT}\``,
    );
  }
  const rec =
    typeof recorded === "object" && recorded !== null ? (recorded as Record<string, unknown>) : {};
  for (const bundle of SOURCE_BUNDLES) {
    const have = await sha256File(join(distDir, bundle)).catch(() => undefined);
    if (have === undefined || rec[bundle] !== have) {
      throw new ExeError(
        `the exes in ${srcDir} were not built from the current dist/${bundle}; rebuild them with \`${BUILD_HINT}\`, or install the Node form with --runtime node`,
      );
    }
  }
}

/** Reads and hashes the source exes. Writes nothing. Throws ExeError when one is missing or stale. */
export async function planExe(distDir: string, home: string, exeDir?: string): Promise<ExePlan> {
  const target = platformTarget();
  const srcDir = exeDir ? resolve(exeDir) : join(distDir, "exe", target.dir);
  const files: ExeFile[] = [];
  for (const name of EXE_NAMES) {
    const fileName = `${name}${target.ext}`;
    const src = join(srcDir, fileName);
    const isFile = await lstat(src).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!isFile) {
      throw new ExeError(
        `the exe ${src} is missing; build it with \`${BUILD_HINT}\` (needs \`pnpm install\` first), or install the Node form with --runtime node`,
      );
    }
    files.push({ name, src, fileName, sha256: await sha256File(src) });
  }
  await checkFresh(distDir, srcDir, exeDir !== undefined);
  const combined = createHash("sha256")
    .update(files.map((f) => `${f.fileName}:${f.sha256}`).join("\n"))
    .digest("hex")
    .slice(0, DIR_HASH_CHARS);
  const dir = join(realResolve(home), BIN_DIR, combined);
  const paths = Object.fromEntries(
    files.map((f) => [f.name, realSlash(join(dir, f.fileName))]),
  ) as Record<ExeName, string>;
  return { dir, files, paths };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
      if (!RETRY_CODES.includes(code) || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}

async function placeOne(dir: string, f: ExeFile): Promise<void> {
  const dest = join(dir, f.fileName);
  const have = await sha256File(dest).catch(() => undefined);
  if (have === f.sha256) {
    if (process.platform !== "win32") await chmod(dest, 0o755);
    return;
  }
  const tmp = join(dir, `.${f.fileName}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await copyFile(f.src, tmp);
    const got = await sha256File(tmp);
    if (got !== f.sha256) {
      throw new ExeError(`the copy of ${f.src} does not match its SHA-256 (${got} != ${f.sha256})`);
    }
    if (process.platform !== "win32") await chmod(tmp, 0o755);
    await renameWithRetry(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Copies the exes into plan.dir (temp name, hash check, rename). The directory is named by the
 * content hash, so a new build never overwrites an exe Windows may be executing.
 */
export async function installExe(plan: ExePlan, home: string): Promise<void> {
  const bin = dirname(plan.dir);
  await ensurePrivateDir(realResolve(home));
  await ensurePrivateDir(bin);
  await ensurePrivateDir(plan.dir);
  for (const f of plan.files) await placeOne(plan.dir, f);
}

/** True for <home>/bin/<name> only: the one place a recorded exe directory may live. */
export function isOurExeDir(dir: string, home: string): boolean {
  const d = resolve(dir);
  const bin = join(realResolve(home), BIN_DIR);
  return (
    norm(dirname(realResolve(d))) === norm(bin) &&
    basename(d) !== "" &&
    /^[0-9a-f]+$/.test(basename(d))
  );
}

const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
const sameDir = (a: string, b: string): boolean => norm(realResolve(a)) === norm(realResolve(b));

/** Only the exes themselves and our own stray temp copies may be in a directory prune removes. */
function isOurExeEntry(name: string): boolean {
  const exes = EXE_NAMES.flatMap((n) => [n, `${n}.exe`]);
  return exes.includes(name) || /^..+.tmp$/.test(name);
}

/**
 * Removes a recorded exe directory when it is directly under <home>/bin, holds only the exes (and
 * stray temp copies), and no other install (`inUse`: the exe directories other settings files
 * record) still points at it. Returns a note when it did not (a hook.exe still running keeps it
 * locked); the files are harmless to leave.
 */
export async function pruneExeDir(
  dir: string,
  home: string,
  inUse: readonly string[] = [],
): Promise<string | undefined> {
  if (!isOurExeDir(dir, home)) return `not removing ${dir}: it is not a probe exe directory`;
  if (inUse.some((d) => sameDir(d, dir))) return undefined;
  try {
    const names = await readdir(dir).catch(() => [] as string[]);
    const stray = names.find((n) => !isOurExeEntry(n));
    if (stray !== undefined) {
      return `not removing ${dir}: it holds ${stray}, which is not one of the probe exes`;
    }
    await rm(dir, { recursive: true, force: true });
    const bin = dirname(resolve(dir));
    if ((await readdir(bin).catch(() => ["x"])).length === 0) await rm(bin, { recursive: true });
    return undefined;
  } catch (e) {
    return `could not remove the old exe directory ${dir} (${e instanceof Error ? e.message : "error"}); it is safe to delete later`;
  }
}
