// Literals the leak gate searches for, derived from the raw captures at run time (R0.7).
// Never printed: callers report counts only. Without raw/ (CI) the lists are empty.
import { existsSync } from "node:fs";
import {
  BUILTIN_AGENTS,
  BUILTIN_TOOLS,
  PATH_KEYS,
  USER_KEYED,
  keepRule,
} from "./fixture-allowlist.mjs";
import { listEvents, readEvent } from "./fixture-files.mjs";
import { KNOWN_KEYS } from "./fixture-keys.mjs";
import { Mapper } from "./fixture-scrub-paths.mjs";

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
 * @returns {{ users: string[], projects: string[], names: string[] }}
 */
export function deriveLiterals(rawRoot) {
  if (rawRoot === null || !existsSync(rawRoot)) return { users: [], projects: [], names: [] };
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
  const projects = [...mapper.projects.keys()].filter((n) => !n.startsWith("enc:"));
  const names = [...acc.names].filter(
    (n) =>
      n.length >= MIN_NAME &&
      n.length <= 80 &&
      !/[\n\r]/.test(n) &&
      !BUILTIN_AGENTS.has(n) &&
      !BUILTIN_TOOLS.has(n) &&
      !KNOWN_KEYS.has(n) &&
      !projects.includes(n),
  );
  return { users: [...users].sort(), projects: projects.sort(), names: names.sort() };
}
