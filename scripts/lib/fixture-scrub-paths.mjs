// Path, id and name mapping for the fixture scrub. One Mapper instance is shared by every file a
// run writes, so the same real value always becomes the same placeholder.
//
// Paths: backslashes become slashes, the home directory becomes <HOME>, a project directory becomes
// <PROJECT_A>.. (assigned from the sorted set of project names seeded up front), other directories
// <DIR_n>, file names <FILE_n> with the extension kept. Ids are replaced by a hash-derived id of
// the same shape (session and agent ids are remapped, not kept).
import { createHash } from "node:crypto";

/** Directory names that are layout, not content. */
const STRUCT = new Set([
  ".claude",
  "projects",
  "subagents",
  "scratchpad",
  "AppData",
  "Local",
  "Temp",
  "claude",
  "tool-results",
  "node_modules",
  ".git",
  "tmp",
  "var",
  "home",
  "Users",
]);
const ID_SALT = "sessiondeck-fixture-scrub-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOME_ROOTS = [
  /^[A-Za-z]:\/+Users\/+[^/]+/, // C:/Users/name
  /^\/+[A-Za-z]\/+Users\/+[^/]+/, // /c/Users/name (MSYS)
  /^\/+(?:Users|home)\/+[^/]+/, // /Users/name, /home/name
  /^~(?=\/|$)/, // ~
];
const DRIVE_ROOT = /^[A-Za-z]:\/+/;
const ENCODED_HOME = /^[A-Za-z]--Users-[^-]+-/;
const PATH_LIKE =
  /^(?:[A-Za-z]:[\\/]|\/|~(?:[\\/]|$)|\.{1,2}[\\/]|[\w.@ -]+[\\/])[^\n\r\t"<>|*?]*$/;
const MAX_PATH = 400;

/** @param {string} s */
const slashes = (s) => s.split("\\").join("/");

/** Folder name Claude Code derives from a path: every non-alphanumeric char becomes a dash. */
export const encodePath = (/** @type {string} */ s) => s.replace(/[^A-Za-z0-9]/g, "-");

/** Letters A..Z, then A1.. so a sixth or thirtieth project still gets a stable name. */
function letter(/** @type {number} */ i) {
  const base = String.fromCharCode(65 + (i % 26));
  return i < 26 ? base : `${base}${Math.floor(i / 26)}`;
}

/**
 * Same-length, same-charset id derived from the original through sha256. Not reversible.
 * @param {string} kind
 * @param {string} value
 * @param {string} alphabet
 * @param {number} length
 */
function derive(kind, value, alphabet, length) {
  let out = "";
  for (let n = 0; out.length < length; n += 1) {
    const h = createHash("sha256").update(`${ID_SALT}|${kind}|${n}|${value}`).digest();
    for (const b of h) if (out.length < length) out += alphabet[b % alphabet.length];
  }
  return out;
}

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Remaps an id keeping its shape; returns null when the value has no id shape. */
export function mapId(/** @type {string} */ v) {
  if (UUID.test(v)) {
    const h = derive("uuid", v.toLowerCase(), HEX, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  if (/^toolu_[A-Za-z0-9]{6,60}$/.test(v))
    return `toolu_${derive("toolu", v, ALNUM, v.length - 6)}`;
  if (/^[0-9a-f]{8,40}$/.test(v)) return derive("hex", v, HEX, v.length);
  if (/^[A-Za-z0-9_-]{6,60}$/.test(v) && /\d/.test(v)) return derive("alnum", v, ALNUM, v.length);
  return null;
}

export class Mapper {
  constructor() {
    /** @type {Map<string, string>} */ this.projects = new Map();
    /** @type {Map<string, string>} */ this.dirs = new Map();
    /** @type {Map<string, string>} */ this.files = new Map();
    /** @type {Map<string, string>} */ this.agents = new Map();
    /** @type {Map<string, string>} */ this.mcp = new Map();
    /** @type {Map<string, string>} */ this.tools = new Map();
  }

  /**
   * Registers project names found in cwd-like values, sorted, so letters do not depend on the
   * order files are processed.
   * @param {Iterable<string>} paths
   */
  seedProjects(paths) {
    const names = new Set();
    for (const p of paths) {
      const name = this.#projectOf(this.#split(p).segments);
      if (name !== null) names.add(name);
    }
    for (const n of [...names].sort()) this.#project(n);
  }

  /** @param {string} name */
  #project(name) {
    const hit = this.projects.get(name);
    if (hit !== undefined) return hit;
    const ph = `<PROJECT_${letter(this.projects.size)}>`;
    this.projects.set(name, ph);
    return ph;
  }

  /** @param {string} p @returns {{ root: string | null, segments: string[] }} */
  #split(p) {
    let s = slashes(p);
    let root = null;
    const home = HOME_ROOTS.map((re) => re.exec(s)).find((m) => m !== null);
    if (home) {
      root = "<HOME>";
      s = s.slice(home[0].length);
    } else if (DRIVE_ROOT.test(s)) {
      root = "<ROOT>";
      s = s.replace(DRIVE_ROOT, "");
    } else if (s.startsWith("/")) {
      root = "<ROOT>";
    }
    return { root, segments: s.split("/").filter((x) => x !== "") };
  }

  /** The project name in a home-relative segment list, or null. */
  #projectOf(/** @type {string[]} */ segs) {
    if (segs.length === 0) return null;
    const first = segs[0] ?? "";
    if (first.toLowerCase() === "projects") return segs[1] ?? null;
    return STRUCT.has(first) ? null : first;
  }

  /** Encoded project folder (C--Users-name-projects-x-y) to <PROJECT_x>. */
  #encodedProject(/** @type {string} */ seg) {
    const rest = seg.replace(ENCODED_HOME, "").replace(/^projects-/, "");
    let best = null;
    for (const name of [...this.projects.keys()].sort((a, b) => b.length - a.length)) {
      const enc = encodePath(name);
      if (rest === enc || rest.startsWith(`${enc}-`)) {
        best = name;
        break;
      }
    }
    return this.#project(best ?? `enc:${rest}`);
  }

  /** @param {string} seg @param {boolean} isFile */
  #leaf(seg, isFile) {
    if (seg === "." || seg === "..") return seg;
    const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(seg);
    const stem = m?.[1] ?? seg;
    const ext = !isFile || stem === "" ? "" : (m?.[2] ?? "");
    const base = ext === "" ? seg : stem;
    if (UUID.test(base)) return `${mapId(base)}${ext}`;
    const agent = /^agent-([0-9a-f]{8,40})$/.exec(base);
    if (agent) return `agent-${mapId(agent[1] ?? "")}${ext}`;
    if (STRUCT.has(seg)) return seg;
    const table = isFile ? this.files : this.dirs;
    let ph = table.get(base);
    if (ph === undefined) {
      ph = `<${isFile ? "FILE" : "DIR"}_${table.size + 1}>`;
      table.set(base, ph);
    }
    return `${ph}${ext}`;
  }

  /**
   * @param {string} value
   * @param {"dir" | "file" | "auto"} kind
   * @returns {string | null} null when the value is not path-shaped
   */
  mapPath(value, kind) {
    if (value.length > MAX_PATH || !PATH_LIKE.test(value)) return null;
    const { root, segments } = this.#split(value);
    /** @type {string[]} */
    const out = [];
    segments.forEach((seg, i) => {
      const last = i === segments.length - 1;
      const prev = segments[i - 1] ?? "";
      const prev2 = segments[i - 2] ?? "";
      if (ENCODED_HOME.test(seg)) out.push(this.#encodedProject(seg));
      else if (root === "<HOME>" && i === 1 && prev.toLowerCase() === "projects")
        out.push(this.#project(seg));
      else if (root === "<HOME>" && i === 0 && seg.toLowerCase() !== "projects" && !STRUCT.has(seg))
        out.push(this.#project(seg));
      else if (prev === "projects" && prev2 === ".claude") out.push(this.#encodedProject(seg));
      else {
        const isFile =
          last && (kind === "file" || (kind === "auto" && /\.[A-Za-z0-9]{1,8}$/.test(seg)));
        out.push(this.#leaf(seg, isFile));
      }
    });
    const joined = out.join("/");
    if (root === null) return joined;
    return joined === "" ? root : `${root}/${joined}`;
  }

  /** Built-in tool names stay; mcp__server__tool maps both parts; anything else is a numbered tool. */
  /** @param {string} name @param {Set<string>} builtin */
  mapTool(name, builtin) {
    if (builtin.has(name)) return name;
    const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
    if (m)
      return `mcp__${this.mapMcp(m[1] ?? "")}__${this.#numbered(this.tools, m[2] ?? "", "TOOL")}`;
    return this.#numbered(this.tools, name, "TOOL");
  }

  /** @param {string} name */
  mapMcp(name) {
    return this.#numbered(this.mcp, name, "MCP");
  }

  /** @param {string} name @param {Set<string>} builtin */
  mapAgent(name, builtin) {
    return name === "" || builtin.has(name) ? name : this.#numbered(this.agents, name, "AGENT");
  }

  /** @param {Map<string, string>} table @param {string} v @param {string} tag */
  #numbered(table, v, tag) {
    let ph = table.get(v);
    if (ph === undefined) {
      ph = `<${tag}_${table.size + 1}>`;
      table.set(v, ph);
    }
    return ph;
  }
}
