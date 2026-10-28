// hookName is structural when it is "<HookEventName>" or "<HookEventName>:<built-in tool name>"
// (R0.7, fix B). Shared by the scrub and the transcript leak check. Anything else is user-chosen.
import { BUILTIN_TOOLS } from "./fixture-allowlist.mjs";
import { HOOK_EVENTS } from "./hook-events.mjs";

/** @param {unknown} v @returns {boolean} */
export function isStructuralHookName(v) {
  if (typeof v !== "string") return false;
  const colon = v.indexOf(":");
  const event = colon === -1 ? v : v.slice(0, colon);
  if (!HOOK_EVENTS.includes(event)) return false;
  return colon === -1 || BUILTIN_TOOLS.has(v.slice(colon + 1));
}
