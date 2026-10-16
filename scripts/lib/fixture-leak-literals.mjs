// Literals the leak gate searches for, derived from the raw captures at run time (R0.7).
// Never printed: callers report counts only. Without raw/ (CI) the lists are empty.
import { existsSync } from "node:fs";
import {
  BUILTIN_AGENTS,
  BUILTIN_TOOLS,
  ID_KEYS,
  PATH_KEYS,
  USER_KEYED,
  keepRule,
} from "./fixture-allowlist.mjs";
import { listEvents, readEvent } from "./fixture-files.mjs";
import { KNOWN_KEYS } from "./fixture-keys.mjs";
import { Mapper, STRUCT, mapId } from "./fixture-scrub-paths.mjs";

/** Last key segments whose raw string value is a name the scrub must have replaced. */
const NAMED_FIELDS = new Set([
  "session_name",
  "branch",
  "ref",
  "name",
  "owner",
  "repo",
  "skill",
  "slug",
  "title",
  "agent_type",
  "agentType",
  "subagent_type",
  "mcp_server",
  "pr",
  "projectId",
  "project_id",
  "teamId",
]);
const PATH_SHAPED = /^(?:[A-Za-z]:[\\/]|\/|~[\\/]|[A-Za-z]--Users-)[^\n\r\t"<>|*?]{1,399}$/;
const MIN_NAME = 3;
const ID_NAME =
  /^(?:agent-[0-9a-f]{8,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[A-Za-z0-9]{1,8})?$/i;

/** @param {string} path */
const lastKey = (path) => path.split(".").pop()?.replace(/\[\]$/, "") ?? "";

/**
 * Collects path strings and named-field strings from one raw payload.
 * @param {unknown} v
 * @param {string} path
 * @param {{ paths: Set<string>, names: Set<string> }} acc
 */
function collect(v, path, acc) {
  if (typeof v === "string") {
    if (Object.hasOwn(PATH_KEYS, path) || PATH_SHAPED.test(v)) acc.paths.add(v);
    // An id the scrub cannot remap is replaced by a placeholder, so its text must not survive.
    if (ID_KEYS.has(path) && v !== "" && mapId(v) === null) acc.names.add(v);
    if (path === "tool_name") {
      const m = /^mcp__([^_].*?)__(.+)$/.exec(v);
      if (m) {
        for (const part of [m[1], m[2]]) if (part) acc.names.add(part);
      } else if (!BUILTIN_TOOLS.has(v)) {
        acc.names.add(v);
      }
    } else if (NAMED_FIELDS.has(lastKey(path)) && keepRule(path, true)?.re.test(v) !== true) {
      acc.names.add(v);
    }
  } else if (Array.isArray(v)) {
    for (const el of v) collect(el, `${path}[]`, acc);
  } else if (v !== null && typeof v === "object") {
    const userKeyed = USER_KEYED.has(lastKey(path));
    for (const [k, child] of Object.entries(v)) {
      collect(child, path === "" ? k : `${path}.${userKeyed ? "<key>" : k}`, acc);
    }
  }
}

/**
 * @param {string | null} rawRoot
 * @returns {{ users: string[], projects: string[], segments: string[], names: string[] }}
 */
export function deriveLiterals(rawRoot) {
  if (rawRoot === null || !existsSync(rawRoot))
    return { users: [], projects: [], segments: [], names: [] };
  /** @type {{ paths: Set<string>, names: Set<string> }} */
  const acc = { paths: new Set(), names: new Set() };
  for (const ev of listEvents(rawRoot)) {
    for (const it of readEvent(rawRoot, ev).items) collect(it.payload, "", acc);
  }
  const users = new Set();
  for (const p of acc.paths) {
    const m =
      /(?:^|[\\/])(?:Users|home)[\\/]+([^\\/]+)/i.exec(p) ?? /^[A-Za-z]--Users-([^-]+)/i.exec(p);
    if (m?.[1]) users.add(m[1]);
  }
  const mapper = new Mapper();
  mapper.seedProjects([...acc.paths].sort());
  const projects = [...mapper.projects.keys()].filter(
    (n) => !n.startsWith("enc:") && !LAYOUT.has(n.toLowerCase()),
  );
  const segments = pathSegments(acc.paths, new Set([...users, ...projects]));
  const names = [...acc.names].filter(
    (n) =>
      n.length >= MIN_NAME &&
      n.length <= 80 &&
      !/[\n\r]/.test(n) &&
      !BUILTIN_AGENTS.has(n) &&
      !BUILTIN_TOOLS.has(n) &&
      !KNOWN_KEYS.has(n) &&
      !projects.includes(n) &&
      !LAYOUT.has(n.toLowerCase()),
  );
  return {
    users: [...users].sort(),
    projects: projects.sort(),
    segments: segments.filter((s) => !KNOWN_KEYS.has(s)),
    names: names.sort(),
  };
}

/**
 * Words that appear in many paths, or in this repo's own vocabulary, and say nothing about the user.
 * Lowercase; compared case-insensitively.
 */
const LAYOUT = new Set(
  (
    "projects users home mnt usr opt lib var etc bin tmp temp src dist build docs doc scripts " +
    "packages test tests node claude agents skills hooks plans commands plugins settings state " +
    "output outputs public global local common memory sprint cache desktop documents downloads " +
    "appdata roaming worktrees scratchpad code data config logs log app apps web work repos " +
    "source capture fixtures shell raw decisions planning handoffs research phases sessions infra"
  ).split(" "),
);

/**
 * Every folder or file name in a raw path that the scrub turned into a placeholder: a client folder
 * three levels down is as sensitive as the project folder. Drive letters, layout words (STRUCT),
 * names shorter than MIN_NAME and names already listed as users or projects are left out.
 * File names also contribute their stem, since the scrub keeps only the extension.
 * @param {Iterable<string>} paths
 * @param {Set<string>} already
 * @returns {string[]}
 */
function pathSegments(paths, already) {
  const out = new Set();
  for (const p of paths) {
    for (const seg of p.split(/[\\/]+/)) {
      const stem = /^(.+?)\.[A-Za-z0-9]{1,8}$/.exec(seg)?.[1];
      for (const s of [seg, stem]) {
        if (s === undefined || s.length < MIN_NAME || s.length > 80) continue;
        if (STRUCT.has(s) || LAYOUT.has(s.toLowerCase()) || already.has(s)) continue;
        if (ID_NAME.test(s)) continue; // transcript file names are ids, remapped by the scrub
        if (/^[A-Za-z]--Users-/i.test(s) || /[<>:|*?"]/.test(s) || s === "~") continue;
        out.add(s);
      }
    }
  }
  return [...out].sort();
}
