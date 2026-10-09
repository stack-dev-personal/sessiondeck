import { HOOK_EVENTS } from "./hook-events.mjs";
import {
  HOOK_TIMEOUT_SECONDS,
  MARKER_FLAG,
  MARKER_VALUE,
  NO_TIMEOUT_EVENTS,
  SIDECAR_VERSION,
} from "./install-config.mjs";
import { isOurHook, isOurStatus, isRecord } from "./settings-match.mjs";

/**
 * Pure functions over parsed settings objects. Nothing here touches disk, and nothing mutates
 * its input: every function returns new objects.
 */

export const STATUS_KEYS = /** @type {const} */ (["statusLine", "subagentStatusLine"]);
const STATUS_FLAG = { statusLine: "--statusline", subagentStatusLine: "--subagents" };
/** Characters that would break out of a double-quoted Git Bash string. */
const SHELL_UNSAFE = /["$`\\!\n\r]/;

/** @typedef {import("./settings-match.mjs").Json} Json */
/** @typedef {import("./settings-match.mjs").Entries} Entries */
/** @typedef {{ present: boolean, value?: unknown }} Previous */
/** @typedef {{ dir: string, files: { path: string, sha256: string }[] }} DeployRecord */
/**
 * @typedef {object} SidecarState
 * @property {number} version
 * @property {{ statusLine: Previous, subagentStatusLine: Previous }} previous
 * @property {string[]} createdEvents
 * @property {boolean} createdHooksKey
 * @property {boolean} createdFile
 * @property {Entries} [entries] the exact commands written
 * @property {DeployRecord} [deploy]
 * @property {string} [outDir]
 */
/** @typedef {{ scriptPath: string, outDir: string }} Ctx */

export class SettingsShapeError extends Error {}

export { isRecord };

/**
 * Throws SettingsShapeError when the structure is not something we can safely merge into.
 * @param {unknown} settings
 */
export function validateSettings(settings) {
  if (!isRecord(settings)) throw new SettingsShapeError("settings root is not a JSON object");
  for (const key of STATUS_KEYS) {
    if (settings[key] !== undefined && !isRecord(settings[key])) {
      throw new SettingsShapeError(`"${key}" is not an object`);
    }
  }
  const hooks = settings.hooks;
  if (hooks === undefined) return;
  if (!isRecord(hooks)) throw new SettingsShapeError('"hooks" is not an object');
  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new SettingsShapeError(`"hooks.${event}" is not an array`);
    }
  }
}

/**
 * Throws if a path cannot be placed safely inside a double-quoted shell string.
 * @param {string} p
 */
export function assertShellSafePath(p) {
  if (SHELL_UNSAFE.test(p)) {
    throw new SettingsShapeError(`path contains characters unsafe for a shell command: ${p}`);
  }
}

/** @param {Ctx} ctx @returns {string[]} */
function hookArgs({ scriptPath, outDir }) {
  return [scriptPath, MARKER_FLAG, MARKER_VALUE, "--out", outDir];
}

/** @param {Ctx} ctx @param {string} event @returns {Json} */
export function buildGroup(ctx, event) {
  const hook = { type: "command", command: "node", args: hookArgs(ctx) };
  const withTimeout = NO_TIMEOUT_EVENTS.includes(event)
    ? hook
    : { ...hook, timeout: HOOK_TIMEOUT_SECONDS };
  return { hooks: [withTimeout] };
}

/** @param {Ctx} ctx @param {"statusLine" | "subagentStatusLine"} key @returns {string} */
export function buildStatusCommand({ scriptPath, outDir }, key) {
  assertShellSafePath(scriptPath);
  assertShellSafePath(outDir);
  return `node "${scriptPath}" ${MARKER_FLAG} ${MARKER_VALUE} ${STATUS_FLAG[key]} --out "${outDir}"`;
}

/** @param {Ctx} ctx @param {"statusLine" | "subagentStatusLine"} key @returns {Json} */
export function buildStatus(ctx, key) {
  return { type: "command", command: buildStatusCommand(ctx, key) };
}

/** @param {Ctx} ctx @returns {Entries} */
export function buildEntries(ctx) {
  return {
    hook: { command: "node", args: hookArgs(ctx) },
    statusLine: buildStatusCommand(ctx, "statusLine"),
    subagentStatusLine: buildStatusCommand(ctx, "subagentStatusLine"),
  };
}

/**
 * Removes our hooks from a list of matcher groups; foreign groups pass through untouched.
 * @param {unknown[]} groups @param {Entries | undefined} record @returns {unknown[]}
 */
export function stripOurs(groups, record) {
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const kept = group.hooks.filter((h) => !isOurHook(h, record));
    if (kept.length === group.hooks.length) return [group];
    return kept.length > 0 ? [{ ...group, hooks: kept }] : [];
  });
}

/**
 * What to record as "previous" for a status key. A value that is ours is never recorded.
 * @param {Json} settings @param {typeof STATUS_KEYS[number]} key
 * @param {SidecarState | undefined} prior @returns {Previous}
 */
function previousFor(settings, key, prior) {
  const current = settings[key];
  if (isOurStatus(current, key, prior?.entries)) return prior?.previous[key] ?? { present: false };
  return key in settings ? { present: true, value: current } : { present: false };
}

/**
 * @param {Json} settings validated settings (or {} for a new file)
 * @param {Ctx} ctx
 * @param {SidecarState | undefined} prior sidecar from an earlier install, if any
 * @param {boolean} fileExisted
 * @returns {{ settings: Json, state: SidecarState }}
 */
export function applyInstall(settings, ctx, prior, fileExisted) {
  const oldHooks = isRecord(settings.hooks) ? settings.hooks : {};
  const created = new Set(prior?.createdEvents ?? []);
  /** @type {Json} */
  const hooks = { ...oldHooks };
  for (const event of HOOK_EVENTS) {
    const existing = /** @type {unknown[] | undefined} */ (oldHooks[event]);
    if (existing === undefined) created.add(event);
    hooks[event] = [...stripOurs(existing ?? [], prior?.entries), buildGroup(ctx, event)];
  }
  const entries = buildEntries(ctx);
  return {
    settings: {
      ...settings,
      hooks,
      statusLine: buildStatus(ctx, "statusLine"),
      subagentStatusLine: buildStatus(ctx, "subagentStatusLine"),
    },
    state: {
      version: SIDECAR_VERSION,
      previous: {
        statusLine: previousFor(settings, "statusLine", prior),
        subagentStatusLine: previousFor(settings, "subagentStatusLine", prior),
      },
      createdEvents: [...created],
      createdHooksKey: prior?.createdHooksKey ?? settings.hooks === undefined,
      createdFile: prior?.createdFile ?? !fileExisted,
      entries,
      outDir: ctx.outDir,
    },
  };
}

/**
 * Surgical removal. Restores a status key only if it is still ours.
 * @param {Json} settings validated settings
 * @param {SidecarState | undefined} state
 * @returns {Json}
 */
export function applyUninstall(settings, state) {
  const record = state?.entries;
  const created = new Set(state?.createdEvents ?? []);
  /** @type {Json} */
  const hooks = {};
  for (const [event, value] of Object.entries(isRecord(settings.hooks) ? settings.hooks : {})) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const kept = stripOurs(value, record);
    if (kept.length === 0 && created.has(event)) continue;
    hooks[event] = kept;
  }
  const dropHooks = Object.keys(hooks).length === 0 && (state?.createdHooksKey ?? true);
  let result = dropHooks ? omitKey(settings, "hooks") : withKeyInPlace(settings, "hooks", hooks);
  for (const key of STATUS_KEYS) result = restoreStatus(result, key, state);
  return result;
}

/**
 * Returns a copy of obj with key set, keeping the key's original position when it exists.
 * @param {Json} obj @param {string} key @param {unknown} value @returns {Json}
 */
function withKeyInPlace(obj, key, value) {
  if (!(key in obj)) return { ...obj, [key]: value };
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === key ? value : v]));
}

/**
 * @param {Json} settings @param {typeof STATUS_KEYS[number]} key
 * @param {SidecarState | undefined} state @returns {Json}
 */
function restoreStatus(settings, key, state) {
  if (!isOurStatus(settings[key], key, state?.entries)) return settings;
  const previous = state?.previous[key];
  if (previous?.present) return withKeyInPlace(settings, key, previous.value);
  return omitKey(settings, key);
}

/** @param {Json} obj @param {string} key @returns {Json} */
function omitKey(obj, key) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}
