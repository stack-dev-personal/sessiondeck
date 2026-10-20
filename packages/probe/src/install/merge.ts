import { HOOK_EVENTS, HOOK_TIMEOUT_SECONDS, MARKER, STATUSLINE_REFRESH_SECONDS } from "./events.ts";

/** Pure functions over parsed settings objects. Inputs are never mutated. */

export type Json = Record<string, unknown>;
export type StatusKey = "statusLine" | "subagentStatusLine";
export const STATUS_KEYS: readonly StatusKey[] = ["statusLine", "subagentStatusLine"];

export interface Previous {
  present: boolean;
  value?: unknown;
  /** The recorded value failed the schema: known to have existed, but never restored. */
  invalid?: boolean;
}

/** What one install changed in one settings file. */
export interface InstallEntry {
  previous: Record<StatusKey, Previous>;
  createdEvents: string[];
  createdHooksKey: boolean;
  createdFile: boolean;
  /** Settings backup taken when a previous status value was captured (verifies the restore). */
  backups?: Partial<Record<StatusKey, string>>;
}

export interface Ctx {
  /** Absolute, forward-slash path of dist/hook.mjs. */
  hookPath: string;
  /** Resolved probe home (forward slashes), passed as `--home`. */
  home: string;
  /** Host name, passed as `--host`. */
  host: string;
  /** Absent when a path is unsafe in a shell command line; then the key is skipped. */
  statuslineCommand?: string;
  subagentsCommand?: string;
  /** Why the status commands are absent (names the path). */
  statusSkipReason?: string;
}

export class SettingsShapeError extends Error {}

export function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MARKER_RE = new RegExp(`(^|\\s)${MARKER}(\\s|$)`);

export function isOurHook(h: unknown): boolean {
  return isRecord(h) && Array.isArray(h["args"]) && h["args"].includes(MARKER);
}

export function isOurStatus(v: unknown): boolean {
  return isRecord(v) && typeof v["command"] === "string" && MARKER_RE.test(v["command"]);
}

export function validateSettings(settings: unknown): asserts settings is Json {
  if (!isRecord(settings)) throw new SettingsShapeError("settings root is not a JSON object");
  for (const key of STATUS_KEYS) {
    if (settings[key] !== undefined && !isRecord(settings[key])) {
      throw new SettingsShapeError(`"${key}" is not an object`);
    }
  }
  const hooks = settings["hooks"];
  if (hooks === undefined) return;
  if (!isRecord(hooks)) throw new SettingsShapeError('"hooks" is not an object');
  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new SettingsShapeError(`"hooks.${event}" is not an array`);
    }
  }
}

function buildGroup(ctx: Ctx): Json {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: "node",
        args: [ctx.hookPath, "--home", ctx.home, "--host", ctx.host, MARKER],
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

function buildStatus(ctx: Ctx, key: StatusKey): Json {
  return key === "statusLine"
    ? {
        type: "command",
        command: ctx.statuslineCommand as string,
        padding: 0,
        refreshInterval: STATUSLINE_REFRESH_SECONDS,
      }
    : { type: "command", command: ctx.subagentsCommand as string };
}

/** Removes our hooks from groups; foreign groups pass through by reference. */
function stripOurs(groups: unknown[]): unknown[] {
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group["hooks"])) return [group];
    const kept = group["hooks"].filter((h) => !isOurHook(h));
    if (kept.length === group["hooks"].length) return [group];
    return kept.length > 0 ? [{ ...group, hooks: kept }] : [];
  });
}

function hasOurs(group: unknown): boolean {
  return isRecord(group) && Array.isArray(group["hooks"]) && group["hooks"].some(isOurHook);
}

/** Puts our group where the old one was (so reruns do not reorder), else appends it. */
function upsertGroup(groups: unknown[], ours: Json): unknown[] {
  const at = groups.findIndex(hasOurs);
  if (at < 0) return [...groups, ours];
  return groups.flatMap((g, i) => (i === at ? [...stripOurs([g]), ours] : stripOurs([g])));
}

export interface InstallOptions {
  replaceStatus: boolean;
}

export interface InstallResult {
  settings: Json;
  entry: InstallEntry;
  notices: string[];
}

export function applyInstall(
  settings: Json,
  ctx: Ctx,
  prior: InstallEntry | undefined,
  fileExisted: boolean,
  opts: InstallOptions,
): InstallResult {
  const notices: string[] = [];
  const oldHooks = isRecord(settings["hooks"]) ? settings["hooks"] : {};
  const created = new Set(prior?.createdEvents ?? []);
  const hooks: Json = { ...oldHooks };
  for (const event of HOOK_EVENTS) {
    const existing = oldHooks[event] as unknown[] | undefined;
    if (existing === undefined) created.add(event);
    hooks[event] = upsertGroup(existing ?? [], buildGroup(ctx));
  }
  const out: Json = { ...settings, hooks };
  const previous: Record<StatusKey, Previous> = {
    statusLine: { present: false },
    subagentStatusLine: { present: false },
  };
  for (const key of STATUS_KEYS) {
    const cur = settings[key];
    const command = key === "statusLine" ? ctx.statuslineCommand : ctx.subagentsCommand;
    if (command === undefined) {
      notices.push(`${key}: not installed; ${ctx.statusSkipReason ?? "unsafe path"}`);
      if (isOurStatus(cur)) previous[key] = prior?.previous[key] ?? { present: false };
    } else if (cur === undefined) {
      out[key] = buildStatus(ctx, key);
    } else if (isOurStatus(cur)) {
      out[key] = buildStatus(ctx, key);
      previous[key] = prior?.previous[key] ?? { present: false };
    } else if (opts.replaceStatus) {
      previous[key] = { present: true, value: cur };
      out[key] = buildStatus(ctx, key);
      notices.push(`${key}: replaced your existing value; uninstall restores it`);
    } else {
      notices.push(
        `${key}: you already have one, left untouched (run install --statusline=replace to take over; uninstall restores yours)`,
      );
    }
  }
  return {
    settings: out,
    notices,
    entry: {
      previous,
      createdEvents: [...created],
      createdHooksKey: prior?.createdHooksKey ?? settings["hooks"] === undefined,
      createdFile: prior?.createdFile ?? !fileExisted,
    },
  };
}

function omit(obj: Json, key: string): Json {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/**
 * `verified` names the status keys whose recorded previous value was confirmed against the install
 * backup; only those are restored. Any other recorded value is dropped, never written back.
 */
export function applyUninstall(
  settings: Json,
  entry: InstallEntry | undefined,
  verified: ReadonlySet<StatusKey> = new Set(),
): Json {
  const created = new Set(entry?.createdEvents ?? []);
  const oldHooks = isRecord(settings["hooks"]) ? settings["hooks"] : undefined;
  let out: Json = settings;
  if (oldHooks) {
    const hooks: Json = {};
    for (const [event, value] of Object.entries(oldHooks)) {
      if (!Array.isArray(value)) {
        hooks[event] = value;
        continue;
      }
      const kept = stripOurs(value);
      // Without a record, an array we emptied was ours alone.
      const weCreated = entry ? created.has(event) : true;
      if (kept.length === 0 && weCreated && value.length > 0) continue;
      hooks[event] = kept;
    }
    const drop = Object.keys(hooks).length === 0 && (entry?.createdHooksKey ?? true);
    out = drop ? omit(settings, "hooks") : { ...settings, hooks };
  }
  for (const key of STATUS_KEYS) {
    if (!isOurStatus(out[key])) continue;
    const prev = entry?.previous[key];
    out = prev?.present && verified.has(key) ? { ...out, [key]: prev.value } : omit(out, key);
  }
  return out;
}

/** Every hook entry of ours in the settings (any event). */
function ourHooks(settings: Json): Json[] {
  const hooks = settings["hooks"];
  if (!isRecord(hooks)) return [];
  const found: Json[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isRecord(g) || !Array.isArray(g["hooks"])) continue;
      for (const h of g["hooks"]) if (isRecord(h) && isOurHook(h)) found.push(h);
    }
  }
  return found;
}

/** True when the settings hold any entry of ours. */
export function hasProbeEntries(settings: Json): boolean {
  return ourHooks(settings).length > 0 || STATUS_KEYS.some((k) => isOurStatus(settings[k]));
}

/** The `--home` argument of our installed hook entries, if present (not yet validated). */
export function installedHome(settings: Json): string | undefined {
  for (const h of ourHooks(settings)) {
    const args = h["args"] as unknown[];
    const i = args.indexOf("--home");
    const v = i >= 0 ? args[i + 1] : undefined;
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}
