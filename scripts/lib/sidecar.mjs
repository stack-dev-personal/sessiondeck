import { isAbsolute } from "node:path";
import { HOOK_EVENTS } from "./hook-events.mjs";
import { DEPLOY_MANIFEST, SHA256_PATTERN, SIDECAR_VERSION } from "./install-config.mjs";
import { containsMarker, hasMarkerPair, hasMarkerTokens, isRecord } from "./settings-match.mjs";

/** Shape validation for the sidecar. The file is trusted only after it passes. */

export class SidecarError extends Error {}

/** @param {string} reason @returns {never} */
function bad(reason) {
  throw new SidecarError(`capture state file is malformed (${reason}); nothing was changed`);
}

/** @param {unknown} v @param {string} name */
function expectStrings(v, name) {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string"))
    bad(`${name} is not a string list`);
}

/** @param {unknown} p @param {string} name */
function parsePrevious(p, name) {
  if (!isRecord(p) || typeof p.present !== "boolean") bad(`previous.${name}`);
  if (!p.present) return { present: false };
  if (!isRecord(p.value)) bad(`previous.${name}.value is not an object`);
  if (containsMarker(p.value)) bad(`previous.${name} is a capture entry`);
  return { present: true, value: p.value };
}

/** @param {unknown} e */
function parseEntries(e) {
  if (e === undefined) return undefined;
  if (!isRecord(e) || !isRecord(e.hook)) return bad("entries");
  if (typeof e.hook.command !== "string") bad("entries.hook.command");
  expectStrings(e.hook.args, "entries.hook.args");
  if (typeof e.statusLine !== "string" || typeof e.subagentStatusLine !== "string") {
    bad("entries status lines");
  }
  const marked =
    hasMarkerPair(e.hook.args) &&
    hasMarkerTokens(e.statusLine) &&
    hasMarkerTokens(e.subagentStatusLine);
  if (!marked) bad("entries do not carry the capture marker");
  return {
    hook: { command: e.hook.command, args: /** @type {string[]} */ (e.hook.args) },
    statusLine: e.statusLine,
    subagentStatusLine: e.subagentStatusLine,
  };
}

/** @param {unknown} d */
function parseDeploy(d) {
  if (d === undefined) return undefined;
  if (!isRecord(d) || typeof d.dir !== "string" || !isAbsolute(d.dir)) return bad("deploy.dir");
  if (!Array.isArray(d.files)) return bad("deploy.files");
  const files = d.files.map((f) => {
    const ok = isRecord(f) && DEPLOY_MANIFEST.includes(/** @type {string} */ (f.path));
    if (!ok || typeof f.sha256 !== "string" || !SHA256_PATTERN.test(f.sha256)) {
      return bad("deploy.files entry");
    }
    return { path: /** @type {string} */ (f.path), sha256: f.sha256 };
  });
  return { dir: d.dir, files };
}

/**
 * @param {unknown} raw parsed JSON
 * @returns {import("./settings-model.mjs").SidecarState}
 */
export function parseSidecar(raw) {
  if (!isRecord(raw)) return bad("not an object");
  if (raw.version !== SIDECAR_VERSION) bad(`unsupported version ${String(raw.version)}`);
  if (!isRecord(raw.previous)) return bad("previous");
  expectStrings(raw.createdEvents, "createdEvents");
  const events = /** @type {string[]} */ (raw.createdEvents);
  if (!events.every((e) => HOOK_EVENTS.includes(e))) bad("createdEvents has an unknown event");
  if (typeof raw.createdHooksKey !== "boolean") bad("createdHooksKey");
  if (typeof raw.createdFile !== "boolean") bad("createdFile");
  const state = {
    version: /** @type {number} */ (raw.version),
    previous: {
      statusLine: parsePrevious(raw.previous.statusLine, "statusLine"),
      subagentStatusLine: parsePrevious(raw.previous.subagentStatusLine, "subagentStatusLine"),
    },
    createdEvents: events,
    createdHooksKey: raw.createdHooksKey,
    createdFile: raw.createdFile,
    entries: parseEntries(raw.entries),
    deploy: parseDeploy(raw.deploy),
    outDir: typeof raw.outDir === "string" ? raw.outDir : undefined,
  };
  return state;
}
