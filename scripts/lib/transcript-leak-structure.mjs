// Structure half of the transcript leak check (R0.7, transcript extension): re-checks one scrubbed
// row or meta object without trusting the scrubber. Reports categories through hit(), never values.
//
// Every key name must be in TRANSCRIPT_KEYS (or a placeholder key). Every string value must be a
// placeholder, a value that matches its key's rule, or free text of at most 120 characters plus an
// optional "<TRUNCATED n>" marker. Thinking, signatures and base64 data must be placeholders, and
// dropped keys must hold a "<BLOB n>" string.
import { BUILTIN_AGENTS, BUILTIN_TOOLS } from "./fixture-allowlist.mjs";
import { TEXT_KEY, TRANSCRIPT_KEYS } from "./fixture-keys.mjs";
import { STRUCT } from "./fixture-scrub-paths.mjs";
import { isStructuralHookName } from "./transcript-scrub-hookname.mjs";
import {
  DROP_KEYS,
  FREE_MAX,
  FREE_ROOTS,
  LEAF,
  MODEL_KEYED,
  SPECIAL,
  USER_KEYED,
} from "./transcript-scrub-rules.mjs";

const THINKING = "<REDACTED-THINKING>";
const BLOB = /^<BLOB \d+>$/;
const TRUNCATED = /<TRUNCATED \d+>$/;
const MODEL_KEY = /^claude-[a-z0-9.-]{1,40}$/;
const UNKNOWN_SEGMENT = "<unknown>";
const GENERIC_PLACEHOLDER = /^<(?:TEXT \d+|REDACTED|EMAIL|ACCOUNT|NAME_\d+)>$/;
const TOOL_OK = /^(?:mcp__<MCP_\d+>__<TOOL_\d+>|<TOOL_\d+>)$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEG = `(?:<PROJECT_[A-Z]\\d*>|<DIR_\\d+>|<FILE_\\d+>|${UUID}|agent-[0-9a-f]{8,40}|\\.{1,2}|${[...STRUCT].map(escape).join("|")})(?:\\.[A-Za-z0-9]{1,8})?`;
const PATH_PLACEHOLDER = new RegExp(`^(?:(?:<HOME>|<ROOT>)(?:/${SEG})*|${SEG}(?:/${SEG})*)$`);
const PR_URL = /^https:\/\/github\.com\/<ACCOUNT>\/<REPO>\/pull\/\d{1,7}$/;
const TOKEN_SHAPE =
  /^(?:sk[-_]|ghp_|gho_|ghs_|ghu_|github_pat_|AKIA|ASIA|xox[a-z]-|Bearer\s)|[A-Fa-f0-9]{32,}/;

/** @param {string} path */
const leafOf = (path) => path.slice(path.lastIndexOf(".") + 1);

/**
 * @param {string} v
 * @param {string} path normalized key path (user-keyed names as "<key>", unknown keys as "<unknown>")
 * @returns {string | null} finding category or null when acceptable
 */
export function transcriptStringFinding(v, path) {
  if (v === "") return null;
  const special = SPECIAL.find(([re]) => re.test(path));
  const leaf = leafOf(path);
  const rule = special ? special[1] : Object.hasOwn(LEAF, leaf) ? LEAF[leaf] : undefined;
  if (rule !== undefined) return ruleFinding(rule, v);
  const root = path.split(/[.[]/)[0] ?? "";
  if (FREE_ROOTS.has(root) && !path.includes(UNKNOWN_SEGMENT)) return freeFinding(v);
  return GENERIC_PLACEHOLDER.test(v) ? null : "transcript-string-not-allowlisted";
}

/** @param {import("./transcript-scrub-rules.mjs").Rule} rule @param {string} v */
function ruleFinding(rule, v) {
  const bad = "transcript-string-not-allowlisted";
  const placeholder = GENERIC_PLACEHOLDER.test(v);
  switch (rule.kind) {
    case "pattern":
      return placeholder || (rule.re?.test(v) === true && !TOKEN_SHAPE.test(v)) ? null : bad;
    case "const":
      return v === rule.value || placeholder ? null : bad;
    case "prRepository":
      return v === "<ACCOUNT>/<REPO>" || placeholder ? null : bad;
    case "prUrl":
      return PR_URL.test(v) || placeholder ? null : bad;
    case "agent":
      return BUILTIN_AGENTS.has(v) || /^<AGENT_\d+>$/.test(v) || placeholder ? null : bad;
    case "name":
      return /^<NAME_\d+>$/.test(v) || placeholder ? null : bad;
    case "hookName":
      return isStructuralHookName(v) || /^<NAME_\d+>$/.test(v) || placeholder ? null : bad;
    case "tool":
      return BUILTIN_TOOLS.has(v) || TOOL_OK.test(v) || placeholder ? null : bad;
    case "mcp":
      return /^<MCP_\d+>$/.test(v) || placeholder ? null : bad;
    case "path":
      return PATH_PLACEHOLDER.test(v) || placeholder ? null : bad;
    default:
      return bad;
  }
}

/** Free text: at most FREE_MAX characters, plus an optional marker when it was cut. @param {string} v */
function freeFinding(v) {
  const body = v.replace(TRUNCATED, "");
  return body.length > FREE_MAX ? "transcript-free-text-over-120" : null;
}

/** @param {string} key @param {boolean} userKeyed @param {boolean} modelKeyed */
function keyFinding(key, userKeyed, modelKeyed) {
  if (TEXT_KEY.test(key)) return null;
  if (modelKeyed && MODEL_KEY.test(key)) return null;
  if (userKeyed || modelKeyed) return "transcript-unknown-key";
  return TRANSCRIPT_KEYS.has(key) ? null : "transcript-unknown-key";
}

/**
 * Special string fields that must be exact placeholders, decided by key and sibling `type`.
 * @param {string} key @param {string} v @param {unknown} type
 * @returns {string | null | undefined} undefined when the field is not special
 */
function redactionFinding(key, v, type) {
  if (key === "signature") return v === THINKING ? null : "transcript-signature-not-redacted";
  if (type === "thinking" && key === "thinking") {
    return v === THINKING ? null : "transcript-thinking-not-redacted";
  }
  if (type === "redacted_thinking" && key === "data") {
    return v === THINKING ? null : "transcript-thinking-not-redacted";
  }
  if (type === "base64" && key === "data")
    return BLOB.test(v) ? null : "transcript-blob-not-placeholder";
  return undefined;
}

/**
 * Walks one parsed row or meta object and calls hit(category) once per finding.
 * @param {unknown} doc
 * @param {(category: string) => void} hit
 */
export function checkTranscriptStructure(doc, hit) {
  visit(doc, "", hit);
}

/** @param {unknown} v @param {string} path @param {(c: string) => void} hit */
function visit(v, path, hit) {
  if (typeof v === "string") {
    const category = transcriptStringFinding(v, path);
    if (category !== null) hit(category);
  } else if (Array.isArray(v)) {
    for (const el of v) visit(el, `${path}[]`, hit);
  } else if (v !== null && typeof v === "object") {
    visitObject(/** @type {Record<string, unknown>} */ (v), path, hit);
  }
}

/** @param {Record<string, unknown>} obj @param {string} path @param {(c: string) => void} hit */
function visitObject(obj, path, hit) {
  const last = leafOf(path).replace(/\[\]$/, "");
  const userKeyed = USER_KEYED.has(last);
  const modelKeyed = MODEL_KEYED.has(last);
  for (const [key, child] of Object.entries(obj)) {
    const bad = keyFinding(key, userKeyed, modelKeyed);
    if (bad !== null) hit(bad);
    const placeholderKey = userKeyed || modelKeyed || key.startsWith("<");
    const seg =
      bad !== null && !userKeyed && !modelKeyed ? UNKNOWN_SEGMENT : placeholderKey ? "<key>" : key;
    const childPath = path === "" ? seg : `${path}.${seg}`;
    if (typeof child === "string") {
      const special = redactionFinding(key, child, obj.type);
      if (special !== undefined) {
        if (special !== null) hit(special);
        continue;
      }
    }
    const dropped = Object.hasOwn(DROP_KEYS, key) && !(key === "shape" && path !== "");
    if (dropped && child !== null && typeof child !== "number" && typeof child !== "boolean") {
      if (child !== "" && !(typeof child === "string" && BLOB.test(child))) {
        hit("transcript-dropped-key-not-blob");
      }
      continue;
    }
    visit(child, childPath, hit);
  }
}
