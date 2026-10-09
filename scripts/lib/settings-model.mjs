import { HOOK_EVENTS } from "./hook-events.mjs";

/**
 * Pure functions over parsed settings objects. Nothing here touches disk, and nothing mutates
 * its input: every function returns new objects.
 */

export const HOOK_TIMEOUT_SECONDS = 5;
export const STATUS_KEYS = /** @type {const} */ (["statusLine", "subagentStatusLine"]);
const STATUS_FLAG = { statusLine: "--statusline", subagentStatusLine: "--subagents" };
/** Characters that would break out of a double-quoted Git Bash string. */
const SHELL_UNSAFE = /["$`\\!\n\r]/;

/** @typedef {Record<string, unknown>} Json */
/** @typedef {{ present: boolean, value?: unknown }} Previous */
/**
 * @typedef {object} SidecarState
 * @property {number} version
 * @property {{ statusLine: Previous, subagentStatusLine: Previous }} previous
 * @property {string[]} createdEvents
 * @property {boolean} createdHooksKey
 * @property {boolean} createdFile
 */
/** @typedef {{ scriptPath: string, outDir: string }} Ctx */

export class SettingsShapeError extends Error {}

/** @param {unknown} v @returns {v is Json} */
export function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Throws SettingsShapeError when the structure is not something we can safely merge into.
 * @param {unknown} settings
 */
export function validateSettings(settings) {
  if (!isRecord(settings)) throw new SettingsShapeError("settings root is not a JSON object");
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

/** @param {unknown} hook @param {string} scriptPath */
export function isOurHook(hook, scriptPath) {
  if (!isRecord(hook) || hook.command !== "node" || !Array.isArray(hook.args)) return false;
  return typeof hook.args[0] === "string" && hook.args[0].replace(/\\/g, "/") === scriptPath;
}

/** @param {unknown} group @param {string} scriptPath */
export function isOurGroup(group, scriptPath) {
  return (
    isRecord(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((h) => isOurHook(h, scriptPath))
  );
}

/** @param {unknown} value @param {string} scriptPath */
export function isOurStatus(value, scriptPath) {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    value.command.startsWith(`node "${scriptPath}" `)
  );
}

/** @param {Ctx} ctx @returns {Json} */
export function buildGroup({ scriptPath, outDir }) {
  return {
    hooks: [
      {
        type: "command",
        command: "node",
        args: [scriptPath, "--out", outDir],
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

/** @param {Ctx} ctx @param {"statusLine" | "subagentStatusLine"} key @returns {Json} */
export function buildStatus({ scriptPath, outDir }, key) {
  assertShellSafePath(scriptPath);
  assertShellSafePath(outDir);
  return {
    type: "command",
    command: `node "${scriptPath}" ${STATUS_FLAG[key]} --out "${outDir}"`,
  };
}

/**
 * Removes our hooks from a list of matcher groups; foreign groups pass through untouched.
 * @param {unknown[]} groups @param {string} scriptPath @returns {unknown[]}
 */
export function stripOurs(groups, scriptPath) {
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const kept = group.hooks.filter((h) => !isOurHook(h, scriptPath));
    if (kept.length === group.hooks.length) return [group];
    return kept.length > 0 ? [{ ...group, hooks: kept }] : [];
  });
}

/**
 * What to record as "previous" for a status key.
 * @param {Json} settings @param {typeof STATUS_KEYS[number]} key @param {string} scriptPath
 * @param {SidecarState | undefined} prior @returns {Previous}
 */
function previousFor(settings, key, scriptPath, prior) {
  const current = settings[key];
  if (isOurStatus(current, scriptPath)) return prior?.previous[key] ?? { present: false };
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
    hooks[event] = [...stripOurs(existing ?? [], ctx.scriptPath), buildGroup(ctx)];
  }
  const previous = {
    statusLine: previousFor(settings, "statusLine", ctx.scriptPath, prior),
    subagentStatusLine: previousFor(settings, "subagentStatusLine", ctx.scriptPath, prior),
  };
  return {
    settings: {
      ...settings,
      hooks,
      statusLine: buildStatus(ctx, "statusLine"),
      subagentStatusLine: buildStatus(ctx, "subagentStatusLine"),
    },
    state: {
      version: 1,
      previous,
      createdEvents: [...created],
      createdHooksKey: prior?.createdHooksKey ?? settings.hooks === undefined,
      createdFile: prior?.createdFile ?? !fileExisted,
    },
  };
}

/**
 * Surgical removal. Restores a status key only if it is still ours.
 * @param {Json} settings validated settings
 * @param {string} scriptPath
 * @param {SidecarState | undefined} state
 * @returns {Json}
 */
export function applyUninstall(settings, scriptPath, state) {
  const created = new Set(state?.createdEvents ?? []);
  /** @type {Json} */
  const hooks = {};
  for (const [event, value] of Object.entries(isRecord(settings.hooks) ? settings.hooks : {})) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const kept = stripOurs(value, scriptPath);
    if (kept.length === 0 && created.has(event)) continue;
    hooks[event] = kept;
  }
  const dropHooks = Object.keys(hooks).length === 0 && (state?.createdHooksKey ?? true);
  let result = dropHooks ? omitKey(settings, "hooks") : withKeyInPlace(settings, "hooks", hooks);
  for (const key of STATUS_KEYS) result = restoreStatus(result, key, scriptPath, state);
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
 * @param {Json} settings @param {typeof STATUS_KEYS[number]} key @param {string} scriptPath
 * @param {SidecarState | undefined} state @returns {Json}
 */
function restoreStatus(settings, key, scriptPath, state) {
  if (!isOurStatus(settings[key], scriptPath)) return settings;
  const previous = state?.previous[key];
  if (previous?.present) return withKeyInPlace(settings, key, previous.value);
  return omitKey(settings, key);
}

/** @param {Json} obj @param {string} key @returns {Json} */
function omitKey(obj, key) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}
