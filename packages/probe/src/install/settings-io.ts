import { constants } from "node:fs";
import { open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir, writeFileAtomic } from "./atomic.ts";
import { type Json, isRecord } from "./merge.ts";

const BOM = String.fromCharCode(0xfeff);

export class SettingsReadError extends Error {}

/** Text layout facts kept so a rewrite changes nothing but the content. */
export interface Layout {
  indent: string | number;
  trailingNewline: boolean;
  crlf: boolean;
  bom: boolean;
}

export interface LoadedSettings {
  /** Resolved path (symlinks followed so the rename replaces the real file). */
  path: string;
  existed: boolean;
  settings: Json;
  layout: Layout;
  original: string;
}

const DEFAULT_LAYOUT: Layout = { indent: 2, trailingNewline: true, crlf: false, bom: false };

function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  return m?.[1] ?? 2;
}

export async function loadSettings(path: string): Promise<LoadedSettings> {
  const real = await realpath(path).catch(() => path);
  let raw: string;
  try {
    raw = await readFile(real, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") {
      return { path: real, existed: false, settings: {}, layout: DEFAULT_LAYOUT, original: "" };
    }
    throw new SettingsReadError(`cannot read ${path}: ${String((e as { code?: string }).code)}`);
  }
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsReadError(`${path} is not valid JSON; fix it first. Nothing was changed.`);
  }
  if (!isRecord(parsed)) {
    throw new SettingsReadError(`${path} is not a JSON object. Nothing was changed.`);
  }
  const layout: Layout = {
    indent: detectIndent(text),
    trailingNewline: /\n$/.test(text),
    crlf: text.includes("\r\n"),
    bom,
  };
  return { path: real, existed: true, settings: parsed, layout, original: raw };
}

export function serialize(settings: Json, layout: Layout): string {
  let text = JSON.stringify(settings, null, layout.indent);
  if (layout.trailingNewline) text += "\n";
  if (layout.crlf) text = text.replace(/\r?\n/g, "\r\n");
  return layout.bom ? `${BOM}${text}` : text;
}

export const BACKUP_RE = /^settings\.backup-.*\.json$/;

/**
 * Copies the current file into the probe home as settings.backup-<ts>.json. Created exclusively
 * (never through a planted symlink or over an existing file) at 0600: settings can hold secrets.
 */
export async function backupSettings(path: string, homeDir: string): Promise<string> {
  await ensurePrivateDir(homeDir);
  const bytes = await readFile(path);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  for (let n = 0; ; n += 1) {
    const dest = join(homeDir, `settings.backup-${ts}${n ? `-${n}` : ""}.json`);
    let handle;
    try {
      handle = await open(dest, flags, 0o600);
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && e.code === "EEXIST") continue;
      throw e;
    }
    try {
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return dest;
  }
}

/** Deletes every settings backup in the probe home (used by uninstall --purge). */
export async function removeBackups(homeDir: string): Promise<number> {
  const names = (await readdir(homeDir).catch(() => [])).filter((f) => BACKUP_RE.test(f));
  for (const f of names) await rm(join(homeDir, f), { force: true });
  return names.length;
}

export async function commitSettings(
  loaded: LoadedSettings,
  next: Json | undefined,
  homeDir: string,
): Promise<string | undefined> {
  let backup: string | undefined;
  if (loaded.existed) backup = await backupSettings(loaded.path, homeDir);
  if (next === undefined) await rm(loaded.path, { force: true });
  else await writeFileAtomic(loaded.path, serialize(next, loaded.layout));
  return backup;
}
