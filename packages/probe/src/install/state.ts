import { readFile } from "node:fs/promises";
import { ensurePrivateDir, writeFileAtomic } from "./atomic.ts";
import { dirname } from "node:path";
import { type InstallEntry, isRecord } from "./merge.ts";

/** install-state.json: per settings file, what install changed (for an exact uninstall). */
interface StateFile {
  version: 1;
  installs: Record<string, InstallEntry>;
}

async function load(path: string): Promise<StateFile> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(raw) && isRecord(raw["installs"])) {
      return { version: 1, installs: raw["installs"] as Record<string, InstallEntry> };
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
