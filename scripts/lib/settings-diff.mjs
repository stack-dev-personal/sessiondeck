import { HOOK_EVENTS } from "./hook-events.mjs";
import { isOurGroup, isRecord, STATUS_KEYS } from "./settings-model.mjs";

const MAX_LINE_CHARS = 220;

/** @param {unknown} value */
function compact(value) {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}...` : text;
}

/**
 * The only lines the installer is allowed to show: our hook groups per event plus the two status
 * keys. Unrelated keys (env, permissions, other hooks) are never rendered, since they can hold tokens.
 * @param {unknown} settings
 * @param {string} scriptPath
 * @returns {string[]}
 */
export function describeCapture(settings, scriptPath) {
  if (!isRecord(settings)) return [];
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  /** @type {string[]} */
  const lines = [];
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const group of groups) {
      if (isOurGroup(group, scriptPath)) lines.push(`hooks.${event}: ${compact(group)}`);
    }
  }
  for (const key of STATUS_KEYS) {
    if (key in settings) lines.push(`${key}: ${compact(settings[key])}`);
  }
  return lines;
}

/**
 * Lines present only before are prefixed "- ", lines present only after "+ ".
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]}
 */
export function diffLines(before, after) {
  const was = new Set(before);
  const now = new Set(after);
  return [
    ...before.filter((l) => !now.has(l)).map((l) => `- ${l}`),
    ...after.filter((l) => !was.has(l)).map((l) => `+ ${l}`),
  ];
}
