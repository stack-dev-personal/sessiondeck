import { readFile } from "node:fs/promises";
import { ensurePrivateDir, writeFileAtomic } from "./atomic.ts";
import { dirname } from "node:path";
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

/** Schema check for one entry read from disk; undefined when it does not fit. */
export function parseEntry(raw: unknown): InstallEntry | undefined {
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
    if (p["present"] && !isStatusValue(p["value"])) return undefined;
    previous[key] = p["present"] ? { present: true, value: p["value"] } : { present: false };
    if (typeof rawBackups[key] === "string") backups[key] = rawBackups[key];
  }
  return { previous, createdEvents, createdHooksKey, createdFile, backups };
}

async function load(path: string): Promise<StateFile> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(raw) && isRecord(raw["installs"])) {
      const installs: Record<string, InstallEntry> = {};
      for (const [k, v] of Object.entries(raw["installs"])) {
        const entry = parseEntry(v);
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
