import { readFile } from "node:fs/promises";
import { ensurePrivateDir, writeFileAtomic } from "./atomic.ts";
import { basename, dirname, resolve } from "node:path";
import { isOurExeDir } from "./exe.ts";
import { realResolve } from "./real-path.ts";
import { BACKUP_RE } from "./settings-io.ts";
import { type InstallEntry, STATUS_KEYS, type StatusKey, isRecord } from "./merge.ts";

/** install-state.json: per settings file, what install changed (for an exact uninstall). */
interface StateFile {
  version: 1;
  installs: Record<string, InstallEntry>;
}

const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

/** The only shape a recorded status value may have; anything else is not trusted. */
export function isStatusValue(v: unknown): boolean {
  if (!isRecord(v) || v["type"] !== "command" || typeof v["command"] !== "string") return false;
  const extra = Object.keys(v).filter(
    (k) => !["type", "command", "padding", "refreshInterval"].includes(k),
  );
  if (extra.length > 0) return false;
  return (
    (v["padding"] === undefined || isNum(v["padding"])) &&
    (v["refreshInterval"] === undefined || isNum(v["refreshInterval"]))
  );
}

const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/** A backup is accepted only as settings.backup-*.json directly inside the probe home. */
export function isInHome(file: string, home: string): boolean {
  const f = resolve(file);
  // Real paths on both sides: 8.3 short and long spellings of one directory are the same home.
  return norm(realResolve(dirname(f))) === norm(realResolve(home)) && BACKUP_RE.test(basename(f));
}

/** Schema check for one entry read from disk; undefined when it does not fit. */
export function parseEntry(raw: unknown, home?: string): InstallEntry | undefined {
  if (!isRecord(raw) || !isRecord(raw["previous"])) return undefined;
  const { createdEvents, createdHooksKey, createdFile } = raw;
  if (!Array.isArray(createdEvents) || !createdEvents.every((e) => typeof e === "string")) {
    return undefined;
  }
  if (typeof createdHooksKey !== "boolean" || typeof createdFile !== "boolean") return undefined;
  const previous = {} as InstallEntry["previous"];
  const backups: Partial<Record<StatusKey, string>> = {};
  const rawBackups = isRecord(raw["backups"]) ? raw["backups"] : {};
  for (const key of STATUS_KEYS) {
    const p = raw["previous"][key];
    if (!isRecord(p) || typeof p["present"] !== "boolean") return undefined;
    if (!p["present"]) previous[key] = { present: false };
    else if (isStatusValue(p["value"])) previous[key] = { present: true, value: p["value"] };
    else previous[key] = { present: true, invalid: true };
    const b = rawBackups[key];
    if (typeof b === "string" && (home === undefined || isInHome(b, home))) backups[key] = b;
  }
  const runtime =
    raw["runtime"] === "exe" || raw["runtime"] === "node" ? raw["runtime"] : undefined;
  // A recorded exeDir is data from disk: it is kept only as <home>/bin/<hex>, never an arbitrary path.
  const rawDir = typeof raw["exeDir"] === "string" ? raw["exeDir"] : undefined;
  const exeDir =
    rawDir !== undefined && home !== undefined && isOurExeDir(rawDir, home) ? rawDir : undefined;
  const statusRuntime = raw["statusRuntime"] === "node" ? "node" : undefined;
  return {
    previous,
    createdEvents,
    createdHooksKey,
    createdFile,
    backups,
    ...(runtime ? { runtime } : {}),
    ...(exeDir ? { exeDir } : {}),
    ...(statusRuntime ? { statusRuntime } : {}),
  };
}

async function load(path: string): Promise<StateFile> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(raw) && isRecord(raw["installs"])) {
      const installs: Record<string, InstallEntry> = {};
      for (const [k, v] of Object.entries(raw["installs"])) {
        const entry = parseEntry(v, dirname(path));
        if (entry) installs[k] = entry;
      }
      return { version: 1, installs };
    }
  } catch {
    // Missing or unreadable state: start empty; uninstall then falls back to marker matching.
  }
  return { version: 1, installs: {} };
}

export async function getEntry(
  path: string,
  settingsPath: string,
): Promise<InstallEntry | undefined> {
  return (await load(path)).installs[settingsPath];
}

export async function putEntry(
  path: string,
  settingsPath: string,
  entry: InstallEntry | undefined,
): Promise<void> {
  const state = await load(path);
  if (entry) state.installs[settingsPath] = entry;
  else delete state.installs[settingsPath];
  await ensurePrivateDir(dirname(path));
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Exe directories recorded by every install except the one for `exceptSettings`. */
export async function otherExeDirs(path: string, exceptSettings: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const [settings, entry] of Object.entries((await load(path)).installs)) {
    if (settings !== exceptSettings && entry.exeDir) dirs.push(entry.exeDir);
  }
  return dirs;
}
