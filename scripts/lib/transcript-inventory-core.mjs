// Transcript inventory (R0.7 tooling): structure of Claude Code session transcripts, counts only.
//
// Privacy contract: nothing from a row's content ever reaches the output. Only these leave a row:
// key names that look like identifiers, enum-like structural values (type, subtype, role, block
// type, attachment type, system subtype), built-in tool names (MCP tools collapse to "mcp", all
// other names to "other"), Claude Code version strings, and model ids. Every such value passes a
// shape filter; anything else is reported as "<other>".
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { KNOWN_KEYS } from "./fixture-keys.mjs";

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
const SAFE_ENUM = /^[A-Za-z0-9_:.-]{1,40}$/;
const SAFE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(-[A-Za-z0-9.]{1,12})?$/;
const SAFE_MODEL = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const COMMAND_TAG = /<command-name>\s*\/?([^<\s]{1,40})\s*<\/command-name>/;
export const BUILTIN_COMMANDS = Object.freeze(["clear", "compact", "resume", "model"]);

export const BUILTIN_TOOLS = new Set([
  "Agent", "AskUserQuestion", "Bash", "BashOutput", "Edit", "EnterPlanMode", "ExitPlanMode",
  "Glob", "Grep", "KillBash", "KillShell", "LS", "ListMcpResourcesTool", "Monitor", "MultiEdit",
  "NotebookEdit", "Read", "ReadMcpResourceTool", "ScheduleWakeup", "SendMessage", "Skill",
  "SlashCommand", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
  "TaskUpdate", "TodoWrite", "ToolSearch", "WebFetch", "WebSearch", "Write",
]); // prettier-ignore

/** @param {unknown} v @returns {string} */
export function typeOf(v) {
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

/** @param {unknown} v @returns {string} enum-like value or a placeholder, never free text */
export function safeEnum(v) {
  if (v === undefined) return "<none>";
  return typeof v === "string" && SAFE_ENUM.test(v) ? v : `<${typeOf(v)}>`;
}

/** @param {string} k */
export function safeKey(k) {
  return SAFE_KEY.test(k) ? k : "<key>";
}

/** @param {unknown} v @returns {string[]} sorted, filtered key names */
export function keyNames(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.keys(v).map(safeKey).sort();
}

/** @param {unknown} name tool name from a tool_use block */
export function toolBucket(name) {
  if (typeof name !== "string") return "other";
  if (name.startsWith("mcp__")) return "mcp";
  return BUILTIN_TOOLS.has(name) ? name : "other";
}

/** @returns {Map<string, number>} */
const counter = () => new Map();
/** @param {Map<string, number>} m @param {string} k @param {number} [n] */
export function bump(m, k, n = 1) {
  m.set(k, (m.get(k) ?? 0) + n);
}

/** @typedef {Record<string, any>} Stats */
/** @typedef {{ fileId: string, seenMsgIds: Set<string>, toolNames: Map<string, string>, nullParents: number }} FileState */

/** @returns {Stats} Features a transcript offers for coverage (structural labels only). */
export function newStats() {
  return {
    rows: 0,
    bad: 0,
    bytes: 0,
    subFiles: 0,
    subBytes: 0,
    byType: counter(),
    topKeySets: new Map(), // "type|k1,k2" -> n
    systemSub: counter(),
    attachType: counter(),
    roles: counter(),
    messageKeySets: counter(),
    blocks: counter(), // "role/blockType"
    toolResultShape: counter(), // "string" | "array[text,image]"
    sidecar: new Map(), // "Tool|k1,k2" or "Tool|string" -> n
    toolUse: counter(),
    agentTypeValues: new Set(),
    flags: counter(),
    commands: counter(),
    versions: counter(),
    models: counter(),
    allKeys: new Set(),
    sessionIds: new Set(),
  };
}

/** @param {Stats} acc @param {Stats} s */
export function mergeStats(acc, s) {
  for (const f of ["rows", "bad", "bytes", "subFiles", "subBytes"]) acc[f] += s[f];
  for (const f of [
    "byType", "topKeySets", "systemSub", "attachType", "roles", "messageKeySets", "blocks",
    "toolResultShape", "sidecar", "toolUse", "flags", "commands", "versions", "models",
  ]) for (const [k, n] of s[f]) bump(acc[f], k, n); // prettier-ignore
  for (const f of ["agentTypeValues", "allKeys", "sessionIds"]) for (const k of s[f]) acc[f].add(k);
  return acc;
}

/** @param {unknown} content @returns {string|undefined} command name from the structural tag */
function commandOf(content) {
  const texts = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) if (b && typeof b.text === "string") texts.push(b.text);
  }
  for (const t of texts) {
    const m = COMMAND_TAG.exec(t.slice(0, 2000));
    if (m) return m[1];
  }
  return undefined;
}

/** Key names of an object tree down to maxDepth, identifier-like only. */
/** @param {any} v @param {Set<string>} out @param {number} depth */
function walkKeys(v, out, depth) {
  if (depth < 0 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const el of v.slice(0, 20)) walkKeys(el, out, depth);
    return;
  }
  for (const k of Object.keys(v)) {
    if (SAFE_KEY.test(k)) out.add(k);
    walkKeys(v[k], out, depth - 1);
  }
}

/** Per-file state that spans rows (never printed). */
/** @param {string} fileId */
function newFileState(fileId) {
  return { fileId, seenMsgIds: new Set(), toolNames: new Map(), nullParents: 0 };
}

/** @param {Stats} s @param {string} role @param {any} content @param {FileState} st */
function blockStats(s, role, content, st) {
  if (typeof content === "string") return bump(s.blocks, `${role}/string`);
  if (!Array.isArray(content)) return bump(s.blocks, `${role}/<${typeOf(content)}>`);
  for (const b of content) {
    const t = b && typeof b === "object" ? safeEnum(b.type) : `<${typeOf(b)}>`;
    bump(s.blocks, `${role}/${t}`);
    walkKeys(b, s.allKeys, 0);
    if (t === "tool_use") {
      const bucket = toolBucket(b.name);
      bump(s.toolUse, bucket);
      if (typeof b.id === "string") st.toolNames.set(b.id, bucket);
      if (bucket === "Agent" || bucket === "Task") {
        const sub = b.input?.subagent_type;
        if (typeof sub === "string") s.agentTypeValues.add(sub);
      }
    } else if (t === "tool_result") {
      const c = b.content;
      if (typeof c === "string") bump(s.toolResultShape, "string");
      else if (Array.isArray(c)) {
        const kinds = [...new Set(c.map((x) => safeEnum(x?.type)))].sort();
        bump(s.toolResultShape, `array[${kinds.join(",")}]`);
      } else bump(s.toolResultShape, `<${typeOf(c)}>`);
    }
  }
}

/** @param {Stats} s @param {any} row @param {FileState} st */
function sidecarStats(s, row, st) {
  if (!("toolUseResult" in row)) return;
  const id = row.message?.content?.find?.(
    (/** @type {any} */ b) => b?.type === "tool_result",
  )?.tool_use_id;
  const tool = (typeof id === "string" && st.toolNames.get(id)) || "unknown";
  const r = row.toolUseResult;
  const shape =
    r !== null && typeof r === "object" && !Array.isArray(r) ? keyNames(r).join(",") : typeOf(r);
  bump(s.sidecar, `${tool}|${shape}`);
  walkKeys(r, s.allKeys, 1);
}

/** @param {Stats} s @param {any} row @param {FileState} st */
function flagStats(s, row, st) {
  const f = (/** @type {string} */ k, cond = true) => cond && bump(s.flags, k);
  f("isSidechain=true", row.isSidechain === true);
  f("isCompactSummary", row.isCompactSummary === true);
  f("isMeta", row.isMeta === true);
  f("logicalParentUuid", "logicalParentUuid" in row);
  f("compact_boundary", row.type === "system" && row.subtype === "compact_boundary");
  f("sessionId!=filename", typeof row.sessionId === "string" && row.sessionId !== st.fileId);
  if (row.parentUuid === null) {
    st.nullParents += 1;
    f("parentUuid=null (non-first)", st.nullParents > 1);
  }
  const mid = row.message?.id;
  if (typeof mid === "string") {
    if (st.seenMsgIds.has(mid)) bump(s.flags, "repeated message.id");
    st.seenMsgIds.add(mid);
  }
  if (typeof row.sessionId === "string") s.sessionIds.add(row.sessionId);
}

/** @param {ReturnType<typeof newStats>} s @param {any} row @param {ReturnType<typeof newFileState>} st */
/** @param {Stats} s @param {any} row @param {FileState} st */
function addRow(s, row, st) {
  s.rows += 1;
  const type = safeEnum(row?.type);
  if (row === null || typeof row !== "object" || Array.isArray(row))
    return bump(s.byType, `<${typeOf(row)}>`);
  bump(s.byType, type);
  const keys = keyNames(row);
  bump(s.topKeySets, `${type}|${keys.join(",")}`);
  for (const k of Object.keys(row)) if (SAFE_KEY.test(k)) s.allKeys.add(k);
  if (type === "system") bump(s.systemSub, safeEnum(row.subtype));
  if (type === "attachment") {
    bump(s.attachType, safeEnum(row.attachment?.type));
    walkKeys(row.attachment, s.allKeys, 1);
  }
  if (typeof row.version === "string")
    bump(s.versions, SAFE_VERSION.test(row.version) ? row.version : "<other>");
  const msg = row.message;
  if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
    const role = safeEnum(msg.role);
    bump(s.roles, `${type}/${role}`);
    bump(s.messageKeySets, `${role}|${keyNames(msg).join(",")}`);
    for (const k of keyNames(msg)) s.allKeys.add(k);
    walkKeys(msg.usage, s.allKeys, 1);
    if (typeof msg.model === "string")
      bump(s.models, SAFE_MODEL.test(msg.model) ? msg.model : "<other>");
    blockStats(s, role, msg.content, st);
    if (role === "user") {
      const c = commandOf(msg.content);
      if (c !== undefined) bump(s.commands, BUILTIN_COMMANDS.includes(c) ? `/${c}` : "other");
    }
  }
  sidecarStats(s, row, st);
  flagStats(s, row, st);
}

/**
 * Stats for one JSONL file (rows only, no sub-agents).
 * @param {string} file absolute path
 * @param {string} [fileId] session id the rows should carry (default: file stem)
 */
export function analyzeFile(file, fileId = basename(file, ".jsonl")) {
  const s = newStats();
  s.bytes = statSync(file).size;
  const st = newFileState(fileId);
  const lines = readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      s.bad += 1;
      continue;
    }
    addRow(s, row, st);
  }
  return s;
}

/**
 * A candidate transcript: the session file plus <id>/subagents/*.jsonl and .meta.json beside them.
 * @param {string} file absolute path of <id>.jsonl
 */
export function analyzeCandidate(file) {
  const id = basename(file, ".jsonl");
  const stats = analyzeFile(file);
  const mainRows = stats.rows;
  const subDir = join(file.slice(0, -".jsonl".length), "subagents");
  const subFiles = [];
  const metaFiles = [];
  if (existsSync(subDir)) {
    for (const name of readdirSync(subDir).sort()) {
      if (name.endsWith(".jsonl")) subFiles.push(name);
      else if (name.endsWith(".meta.json")) metaFiles.push(name);
    }
  }
  let subBytes = 0;
  for (const name of subFiles) {
    // Sub-agent rows carry the parent's sessionId; compare against the parent id.
    const sub = analyzeFile(join(subDir, name), id);
    subBytes += sub.bytes;
    sub.bytes = 0;
    mergeStats(stats, sub);
  }
  for (const name of metaFiles) subBytes += statSync(join(subDir, name)).size;
  stats.subFiles = subFiles.length;
  stats.subBytes = subBytes;
  return { id, file, subDir, subFiles, metaFiles, stats, mainRows, mainBytes: statSync(file).size };
}

/** Coverage labels of a candidate: every structural fact selection tries to cover. */
/** @param {Stats} stats @returns {Set<string>} */
export function featuresOf(stats) {
  const out = new Set();
  for (const k of stats.byType.keys()) out.add(`row:${k}`);
  for (const k of stats.systemSub.keys()) out.add(`system:${k}`);
  for (const k of stats.attachType.keys()) out.add(`attachment:${k}`);
  for (const k of stats.blocks.keys()) out.add(`block:${k}`);
  for (const k of stats.toolResultShape.keys()) out.add(`tool_result:${k}`);
  for (const k of stats.sidecar.keys()) out.add(`sidecar:${k}`);
  for (const k of stats.toolUse.keys()) out.add(`tool:${k}`);
  for (const k of stats.commands.keys()) out.add(`command:${k}`);
  for (const k of stats.flags.keys()) out.add(`flag:${k}`);
  for (const k of stats.topKeySets.keys()) out.add(`keyset:${k}`);
  if (stats.subFiles > 0) out.add("flag:has-subagent-files");
  return out;
}

/** @type {readonly (readonly [string, string])[]} */
const REQUIRED = Object.freeze([
  ["flag:has-subagent-files", "subagents"],
  ["flag:compact_boundary", "compaction"],
  ["command:/clear", "clear"],
  ["flag:sessionId!=filename", "resume"],
]);

/** Structural features outweigh key-set variants when scoring a selection. */
const STRUCTURAL_WEIGHT = 100;

/** Calls fn with every k-combination of indexes 0..n-1 (fewer when n < k). */
/** @param {number} n @param {number} k @param {(idx: number[]) => void} fn */
function eachCombination(n, k, fn) {
  const take = Math.min(n, k);
  /** @type {number[]} */
  const idx = [];
  const rec = (/** @type {number} */ start) => {
    if (idx.length === take) return fn(idx);
    for (let i = start; i < n; i += 1) {
      idx.push(i);
      rec(i + 1);
      idx.pop();
    }
  };
  rec(0);
}

/**
 * Exhaustive search over all `count`-subsets: the subset must contain each required feature that
 * any candidate has (subagents, compaction, /clear, resume); then maximise weighted coverage
 * (structural features count ${STRUCTURAL_WEIGHT}, key-set variants 1); ties go to the smaller total size.
 * @param {{ id: string, stats: any, mainBytes: number }[]} cands
 * @param {number} count
 * @returns {{ chosen: any[], notes: string[] }}
 */
export function selectCandidates(cands, count = 5) {
  const size = (/** @type {{ mainBytes: number, stats: Stats }} */ c) =>
    c.mainBytes + c.stats.subBytes;
  const feats = cands.map((c) => featuresOf(c.stats));
  const notes = [];
  /** @type {string[]} */
  const required = [];
  for (const [feature, label] of REQUIRED) {
    if (feats.some((f) => f.has(feature))) required.push(feature);
    else notes.push(`no candidate has ${label}`);
  }
  /** @type {{ idx: number[], score: number, bytes: number } | undefined} */
  let best;
  eachCombination(cands.length, count, (idx) => {
    if (!required.every((r) => idx.some((i) => feats[i]?.has(r)))) return;
    const covered = new Set();
    for (const i of idx) for (const f of feats[i] ?? []) covered.add(f);
    let score = 0;
    for (const f of covered) score += f.startsWith("keyset:") ? 1 : STRUCTURAL_WEIGHT;
    const bytes = idx.reduce((n, i) => n + size(/** @type {any} */ (cands[i])), 0);
    if (!best || score > best.score || (score === best.score && bytes < best.bytes)) {
      best = { idx: [...idx], score, bytes };
    }
  });
  const chosen = (best?.idx ?? [])
    .map((i) => /** @type {any} */ (cands[i]))
    .sort((a, b) => size(a) - size(b));
  return { chosen, notes };
}

/** @param {Map<string, number>} m */
const sorted = (/** @type {Map<string, number>} */ m) =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

/** Text section for one counter map. */
/** @param {string} title @param {Map<string, number>} m */
function section(title, m) {
  const lines = [`## ${title}`];
  for (const [k, n] of sorted(m)) lines.push(`  ${n}\t${k}`);
  return lines;
}

/** Key names present in stats but absent from fixture-keys.mjs, sorted. */
/** @param {Stats} stats */
export function unknownKeys(stats) {
  return [...stats.allKeys].filter((k) => !KNOWN_KEYS.has(k)).sort();
}

/** @param {Stats} s aggregate or per-file stats */
export function formatStats(s) {
  const lines = [
    `rows ${s.rows}, unparsable ${s.bad}, bytes ${s.bytes}, subagent files ${s.subFiles} (${s.subBytes} bytes)`,
    ...section("row type", s.byType),
    ...section("top-level key sets (type|keys)", s.topKeySets),
    ...section("system subtype", s.systemSub),
    ...section("attachment type", s.attachType),
    ...section("message role (row type/role)", s.roles),
    ...section("message key sets (role|keys)", s.messageKeySets),
    ...section("content blocks (role/type)", s.blocks),
    ...section("tool_result.content shape", s.toolResultShape),
    ...section("toolUseResult sidecar (tool|keys)", s.sidecar),
    ...section("tool_use by tool", s.toolUse),
    `## custom agent types (count)\n  ${s.agentTypeValues.size}`,
    ...section("flags", s.flags),
    ...section("slash commands", s.commands),
    `## distinct sessionIds\n  ${s.sessionIds.size}`,
    ...section("versions", s.versions),
    ...section("models", s.models),
    `## keys not in fixture-keys.mjs\n  ${unknownKeys(s).join(", ") || "(none)"}`,
  ];
  return `${lines.join("\n")}\n`;
}
