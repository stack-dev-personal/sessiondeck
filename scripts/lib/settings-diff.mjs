import { HOOK_EVENTS } from "./hook-events.mjs";
import { isOurGroup, isOurStatus, isRecord } from "./settings-match.mjs";
import { STATUS_KEYS } from "./settings-model.mjs";

const MAX_LINE_CHARS = 400;
const SAFE_TYPE = /^[a-z]{1,20}$/;

/** @param {unknown} value */
function compact(value) {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}...` : text;
}

/**
 * A status value that is not ours is shown as its type and length only: it may embed a token.
 * @param {unknown} value
 */
function describeForeign(value) {
  const type = isRecord(value) && typeof value.type === "string" ? value.type : "";
  const command = isRecord(value) ? value.command : undefined;
  const length =
    typeof command === "string" ? command.length : (JSON.stringify(value) ?? "").length;
  return `(not a capture entry) type=${SAFE_TYPE.test(type) ? type : "other"} length=${length}`;
}

/**
 * The only lines the installer is allowed to show: our hook groups per event plus the two status
 * keys (foreign status values as type and length only). Unrelated keys (env, permissions, other
 * hooks) are never rendered, since they can hold tokens.
 * @param {unknown} settings
 * @param {import("./settings-match.mjs").Entries | undefined} record
 * @returns {string[]}
 */
export function describeCapture(settings, record) {
  if (!isRecord(settings)) return [];
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  /** @type {string[]} */
  const lines = [];
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const group of groups) {
      if (isOurGroup(group, record)) lines.push(`hooks.${event}: ${compact(group)}`);
    }
  }
  for (const key of STATUS_KEYS) {
    if (!(key in settings)) continue;
    const ours = isOurStatus(settings[key], key, record);
    lines.push(`${key}: ${ours ? compact(settings[key]) : describeForeign(settings[key])}`);
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
