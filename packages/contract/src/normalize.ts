// Seeded from stravu/crystal frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts and
//   MessageTransformer.ts @ 1e18e0bc981225f75b5226f82a300fa741970c6f (MIT, Copyright (c) 2024 Stravu).
// Changes: rewritten for on-disk transcript JSONL (not stream-json) with fixtures as ground truth. Kept from
//   Crystal: the tool_result map pass keyed by tool_use_id then attached to the tool call, the
//   text/thinking/tool_use segment rules (trimmed, non-empty), and the system/error parsing idea. Added: parentUuid
//   branch pruning, sidechain separation, subagent nesting, compaction dividers, message.id replacement, a
//   registry of handled row kinds, a raw fallback, persisted-output truncation notes.
// Schema shape from BloopAI/vibe-kanban crates/executors/src/logs/mod.rs @ 7c3807084daad0d9d315064f60fa869de254f027
//   (Apache-2.0), shape only. Branch pruning is specified in the comments below, written from observed behavior.
// Dedup rule for repeated assistant rows follows ccusage v19.0.3 (MIT): message id plus request id.
//
// Pure function. No Node-only APIs: the web package imports this file.

import type {
  MessageSegment,
  SubagentThread,
  SystemInfoData,
  TokenUsage,
  ToolResult,
  UnifiedMessage,
  UnifiedMessageMetadata,
} from "./transcript";

type Row = Record<string, unknown>;

export type RowDisposition = "conversation" | "system" | "internal";

export interface RowKindInfo {
  /** `type`, `system:<subtype>` or `attachment:<attachment type>`. */
  kind: string;
  /**
   * conversation: user/assistant content. system: shown as an info or divider message.
   * internal: bookkeeping that is kept and counted but produces no message.
   */
  disposition: RowDisposition;
  doc: string;
}

export interface NormalizeOptions {
  /** Subagent transcripts (parsed rows or raw lines) keyed by agent id. */
  subagents?: Readonly<Record<string, ReadonlyArray<unknown>>>;
  /** Optional contents of agent-<id>.meta.json, used to link a thread to its spawning call. */
  subagentMeta?: Readonly<
    Record<string, { toolUseId?: string; agentType?: string; description?: string }>
  >;
}

export interface RowKindCounts {
  total: number;
  /** Count per kind for kinds with an explicit case. */
  handled: Record<string, number>;
  /** Count per kind for rows that fall back to raw (includes "unparseable" and "non-object"). */
  unknown: Record<string, number>;
  unknownCount: number;
}

// ---------------------------------------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------------------------------------

function isObj(x: unknown): x is Row {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}
function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

// Bounds for everything that reaches the output from untrusted rows (security review).
const RAW_STRING_MAX = 2048;
const RAW_ROW_MAX = 16384;
const RAW_DEPTH_MAX = 4;
const RAW_KEYS_MAX = 40;
const RAW_ITEMS_MAX = 20;
const KEY_MAX = 200;
const INPUT_BYTES_MAX = 64 * 1024;
const INPUT_DEPTH_MAX = 8;
const RESULT_JSON_MAX = 20000;
const KIND_LABEL_MAX = 100;
const MAX_SUBAGENT_DEPTH = 8;
const MAX_THREAD_ROWS = 100_000;
const MAX_SUBAGENT_MESSAGES = 200_000;

/**
 * Bounded copy of an untrusted value: keys and types kept, strings cut to 2 KB, at most 16 KB per row,
 * depth limited. Never throws, never recurses deeper than RAW_DEPTH_MAX.
 */
export function capRaw(value: unknown): unknown {
  const budget = { left: RAW_ROW_MAX };
  const walk = (v: unknown, depth: number): unknown => {
    if (budget.left <= 0) return "[truncated]";
    if (typeof v === "string") {
      const cut = v.length > RAW_STRING_MAX ? `${v.slice(0, RAW_STRING_MAX)}[truncated]` : v;
      budget.left -= cut.length;
      return cut;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      budget.left -= 8;
      return v;
    }
    if (typeof v !== "object") {
      budget.left -= 8;
      return String(v);
    }
    if (depth >= RAW_DEPTH_MAX) return Array.isArray(v) ? "[array]" : "[object]";
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      for (const x of v.slice(0, RAW_ITEMS_MAX)) arr.push(walk(x, depth + 1));
      if (v.length > RAW_ITEMS_MAX) arr.push(`[${v.length - RAW_ITEMS_MAX} more truncated]`);
      return arr;
    }
    const o: Record<string, unknown> = {};
    const keys = Object.keys(v);
    let i = 0;
    for (const k of keys.slice(0, RAW_KEYS_MAX)) {
      if (budget.left <= 0) {
        o["[truncated]"] = "budget spent";
        break;
      }
      const shown = k.length > KEY_MAX ? `${k.slice(0, KEY_MAX)}~${i}` : k;
      i++;
      budget.left -= shown.length;
      o[shown] = walk((v as Record<string, unknown>)[k], depth + 1);
    }
    if (keys.length > RAW_KEYS_MAX) o["[truncated]"] = `${keys.length - RAW_KEYS_MAX} more keys`;
    return o;
  };
  try {
    return walk(value, 0);
  } catch {
    return "[unreadable]";
  }
}

/**
 * Structure-keeping copy of a tool_use input: depth at most 8, about 64 KB of strings and keys in total.
 * Real inputs under the limit come back unchanged in shape. Never throws.
 */
export function limitInput(value: unknown): unknown {
  const budget = { left: INPUT_BYTES_MAX };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (budget.left <= 0) return "[truncated]";
      const cut = v.length > budget.left ? `${v.slice(0, budget.left)}[truncated]` : v;
      budget.left -= v.length;
      return cut;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      budget.left -= 8;
      return v;
    }
    if (typeof v !== "object") return v === undefined ? undefined : String(v);
    if (depth >= INPUT_DEPTH_MAX) return Array.isArray(v) ? "[array]" : "[object]";
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        if (budget.left <= 0) {
          arr.push(`[${v.length - i} more truncated]`);
          break;
        }
        arr.push(walk(v[i], depth + 1));
      }
      return arr;
    }
    const o: Record<string, unknown> = {};
    let i = 0;
    for (const k of Object.keys(v)) {
      if (budget.left <= 0) {
        o["[truncated]"] = "budget spent";
        break;
      }
      const shown = k.length > KEY_MAX ? `${k.slice(0, KEY_MAX)}~${i}` : k;
      i++;
      budget.left -= shown.length;
      o[shown] = walk((v as Record<string, unknown>)[k], depth + 1);
    }
    return o;
  };
  try {
    return walk(value, 0);
  } catch {
    return "[unreadable]";
  }
}

/** JSON-ish text of a value with depth and length bounds; never throws. */
function boundedJson(value: unknown): string {
  let left = RESULT_JSON_MAX;
  const walk = (v: unknown, depth: number): string => {
    if (left <= 0) return "";
    if (typeof v === "string") {
      const s = JSON.stringify(v.length > left ? v.slice(0, left) : v);
      left -= s.length;
      return s;
    }
    if (v === null || typeof v !== "object") {
      const s = String(v);
      left -= s.length;
      return s;
    }
    if (depth >= 8) return Array.isArray(v) ? "[...]" : "{...}";
    const parts: string[] = [];
    if (Array.isArray(v)) {
      for (const x of v) {
        if (left <= 0) break;
        parts.push(walk(x, depth + 1));
        left -= 1;
      }
      return `[${parts.join(",")}]`;
    }
    for (const k of Object.keys(v)) {
      if (left <= 0) break;
      left -= k.length + 3;
      parts.push(`${JSON.stringify(k)}:${walk((v as Row)[k], depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  };
  try {
    const out = walk(value, 0);
    return left <= 0 ? `${out}[truncated]` : out;
  } catch {
    return "[unreadable]";
  }
}

interface Item {
  index: number;
  /** null when the input was not a JSON object; `raw` then holds what was seen. */
  row: Row | null;
  raw?: unknown;
  /** A main-file sidechain row with no agentId; rendered as a capped raw message. */
  sidechain?: Row;
}

/** Splits JSONL text into rows; a line that does not parse is kept as the string itself. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      out.push(line);
    }
  }
  return out;
}

function toItems(input: ReadonlyArray<unknown>): Item[] {
  const items: Item[] = [];
  for (const entry of input) {
    const index = items.length;
    if (typeof entry === "string") {
      if (entry.trim() === "") continue;
      try {
        const parsed = JSON.parse(entry) as unknown;
        items.push(isObj(parsed) ? { index, row: parsed } : { index, row: null, raw: entry });
      } catch {
        items.push({ index, row: null, raw: entry });
      }
    } else if (isObj(entry)) {
      items.push({ index, row: entry });
    } else {
      items.push({ index, row: null, raw: entry });
    }
  }
  return items;
}

/** Kind key of a row: `type`, `system:<subtype>` or `attachment:<type>`. */
export function rowKind(row: unknown): string {
  if (!isObj(row)) return "non-object";
  const t = row.type;
  if (typeof t !== "string") return "missing-type";
  if (t === "attachment") {
    const a = row.attachment;
    return isObj(a) && typeof a.type === "string" ? `attachment:${a.type}` : "attachment:?";
  }
  if (t === "system") return typeof row.subtype === "string" ? `system:${row.subtype}` : "system:?";
  return t;
}

// ---------------------------------------------------------------------------------------------------------
// Row kind registry. Every kind present in packages/contract/fixtures/transcripts has an entry (R4.1).
// ---------------------------------------------------------------------------------------------------------

interface BuildBase {
  id: string;
  timestamp: string;
  agent?: string;
}
type Builder = (row: Row, att: Row, base: BuildBase) => UnifiedMessage | null;
interface KindDef extends RowKindInfo {
  build?: Builder;
}

function systemMessage(
  base: BuildBase,
  kind: string,
  segments: MessageSegment[],
  extra: UnifiedMessageMetadata = {},
): UnifiedMessage {
  const metadata: UnifiedMessageMetadata = { systemSubtype: kind, ...extra };
  if (base.agent !== undefined) metadata.agent = base.agent;
  return { id: base.id, role: "system", timestamp: base.timestamp, segments, metadata };
}

function infoMessage(
  base: BuildBase,
  kind: string,
  message: string,
  extra: { level?: string; data?: Record<string, unknown> } = {},
): UnifiedMessage {
  const info: SystemInfoData = { subtype: kind, message };
  if (extra.level !== undefined) info.level = extra.level;
  if (extra.data !== undefined) info.data = extra.data;
  return systemMessage(base, kind, [{ type: "system_info", info }]);
}

function sys(
  kind: string,
  doc: string,
  text: (row: Row, att: Row) => string,
  data?: (row: Row, att: Row) => Record<string, unknown>,
): KindDef {
  return {
    kind,
    disposition: "system",
    doc,
    build: (row, att, base) => {
      const extra: { level?: string; data?: Record<string, unknown> } = {};
      const level = str(row.level);
      if (level !== undefined) extra.level = level;
      if (data) extra.data = data(row, att);
      return infoMessage(base, kind, text(row, att), extra);
    },
  };
}

function internal(kind: string, doc: string): KindDef {
  return { kind, disposition: "internal", doc };
}

function hookName(a: Row): string {
  return str(a.hookName) ?? "hook";
}

const DEFS: readonly KindDef[] = [
  // Conversation rows (built by dedicated code below).
  {
    kind: "user",
    disposition: "conversation",
    doc: "Prompt, tool_result carrier, command echo or injected text.",
  },
  {
    kind: "assistant",
    disposition: "conversation",
    doc: "One content block per row; rows sharing message.id merge.",
  },

  // system rows
  {
    kind: "system:compact_boundary",
    disposition: "system",
    doc: "Compaction divider; parentUuid is null, logicalParentUuid points back into the earlier history.",
    build: (row, _att, base) => {
      const cm = isObj(row.compactMetadata) ? row.compactMetadata : {};
      const compact: Record<string, unknown> = {};
      for (const k of ["trigger", "preTokens", "postTokens", "durationMs"]) {
        if (cm[k] !== undefined) compact[k] = cm[k];
      }
      return systemMessage(
        base,
        "compact_boundary",
        [
          {
            type: "system_info",
            info: {
              subtype: "compact_boundary",
              message: str(row.content) ?? "Conversation compacted",
              data: compact,
            },
          },
        ],
        { divider: true, compact },
      );
    },
  },
  sys("system:away_summary", "Recap shown when the user returns.", (r) => str(r.content) ?? ""),
  sys("system:informational", "Notice such as a usage-limit message.", (r) => str(r.content) ?? ""),
  sys(
    "system:scheduled_task_fire",
    "A scheduled task started.",
    (r) => str(r.content) ?? "Scheduled task",
    (r) => ({ taskId: r.taskId, cron: r.cron }),
  ),
  sys(
    "system:stop_hook_summary",
    "Stop hooks ran at the end of a turn.",
    (r) => {
      const n = num(r.hookCount) ?? 0;
      const errs = Array.isArray(r.hookErrors) ? r.hookErrors.length : 0;
      return `${n} stop hook${n === 1 ? "" : "s"} ran${errs > 0 ? `, ${errs} error${errs === 1 ? "" : "s"}` : ""}`;
    },
    (r) => ({ preventedContinuation: r.preventedContinuation, stopReason: r.stopReason }),
  ),
  {
    kind: "system:api_error",
    disposition: "system",
    doc: "API request failed and is being retried.",
    build: (row, _att, base) => {
      const e = isObj(row.error) ? row.error : {};
      const parts: string[] = [];
      const formatted = str(e.formatted);
      if (formatted) parts.push(formatted);
      const attempt = num(row.retryAttempt);
      const max = num(row.maxRetries);
      if (attempt !== undefined) {
        parts.push(`retry ${attempt}${max !== undefined ? `/${max}` : ""}`);
      }
      const ms = num(row.retryInMs);
      if (ms !== undefined) parts.push(`in ${ms} ms`);
      const error: { message: string; details?: string } = {
        message: str(e.message) ?? "API error",
      };
      if (parts.length > 0) error.details = parts.join("; ");
      return systemMessage(base, "api_error", [{ type: "error", error }]);
    },
  },
  internal("system:turn_duration", "Turn timing; counted, not shown."),

  // attachments shown as info
  sys(
    "attachment:hook_success",
    "A hook finished successfully.",
    (_r, a) =>
      `Hook ${hookName(a)} succeeded${num(a.durationMs) !== undefined ? ` (${String(a.durationMs)} ms)` : ""}`,
    (_r, a) => ({ hookEvent: a.hookEvent, command: a.command }),
  ),
  sys(
    "attachment:hook_additional_context",
    "Context a hook injected into the session.",
    (_r, a) => str(a.content) ?? `Hook ${hookName(a)} added context`,
    (_r, a) => ({ hookEvent: a.hookEvent }),
  ),
  sys(
    "attachment:hook_cancelled",
    "A hook was cancelled or timed out.",
    (_r, a) =>
      `Hook ${hookName(a)} cancelled${a.timedOut === true ? ` (timed out after ${String(a.timeoutMs)} ms)` : ""}`,
    (_r, a) => ({ hookEvent: a.hookEvent, command: a.command }),
  ),
  sys(
    "attachment:hook_non_blocking_error",
    "A hook failed without blocking.",
    (_r, a) => `Hook ${hookName(a)} failed (exit ${String(a.exitCode)})`,
    (_r, a) => ({ hookEvent: a.hookEvent, stderr: a.stderr }),
  ),
  {
    kind: "attachment:queued_command",
    disposition: "conversation",
    doc: "A prompt queued while a turn ran, delivered to the model.",
    build: (_row, a, base) => {
      const prompt = str(a.prompt) ?? "";
      const kind = isObj(a.origin) ? str(a.origin.kind) : undefined;
      const human = kind === undefined || kind === "human";
      const segments: MessageSegment[] =
        prompt.trim() === "" ? [] : [{ type: "text", content: prompt }];
      const metadata: UnifiedMessageMetadata = { queued: true };
      if (kind !== undefined) metadata.origin = kind;
      if (!human) metadata.systemSubtype = `origin_${kind.replace(/-/g, "_")}`;
      if (base.agent !== undefined) metadata.agent = base.agent;
      return {
        id: base.id,
        role: human ? "user" : "system",
        timestamp: base.timestamp,
        segments,
        metadata,
      };
    },
  },
  sys(
    "attachment:edited_text_file",
    "A file changed outside the session.",
    (_r, a) => `File edited externally: ${str(a.filename) ?? "?"}`,
  ),
  sys(
    "attachment:file",
    "A file added to the context.",
    (_r, a) => `File attached: ${str(a.displayPath) ?? str(a.filename) ?? "?"}`,
  ),
  sys(
    "attachment:nested_memory",
    "A memory file loaded into the context.",
    (_r, a) => `Memory loaded: ${str(a.displayPath) ?? str(a.path) ?? "?"}`,
  ),
  sys(
    "attachment:compact_file_reference",
    "A file carried over a compaction.",
    (_r, a) => `File kept across compaction: ${str(a.displayPath) ?? str(a.filename) ?? "?"}`,
  ),
  sys("attachment:invoked_skills", "Skills re-attached after compaction.", (_r, a) => {
    const list = Array.isArray(a.skills)
      ? a.skills.map((s) => (isObj(s) ? str(s.name) : undefined)).filter((s) => s)
      : [];
    return `Skills re-attached: ${list.join(", ")}`;
  }),
  sys(
    "attachment:read_truncation_notice",
    "A Read result was only a partial view.",
    (_r, a) => str(a.banner) ?? "Read truncated",
  ),
  sys(
    "attachment:plan_mode_exit",
    "Plan mode ended.",
    () => "Exited plan mode",
    (_r, a) => ({ planExists: a.planExists }),
  ),
  sys(
    "attachment:ultra_effort_enter",
    "Ultra effort mode switched on.",
    () => "Ultra effort enabled",
  ),
  sys("attachment:auto_mode", "Auto mode is active.", () => "Auto mode active"),

  // attachments kept and counted, not shown
  internal("attachment:total_tokens_reminder", "Token budget reminder injected for the model."),
  internal("attachment:batching_reminder_sent", "Batching reminder injected for the model."),
  internal(
    "attachment:bash_output_audience_note",
    "Reminder that only the model sees Bash output.",
  ),
  internal("attachment:silent_turn_reminder", "Reminder to report progress."),
  internal("attachment:credential_org", "Organization id bookkeeping."),
  internal("attachment:date", "Current date injected for the model."),
  internal("attachment:environment", "Working-directory and platform snapshot."),
  internal("attachment:model", "Model identity injected for the model."),
  internal("attachment:instructions", "CLAUDE.md and rule files loaded."),
  internal("attachment:session_context", "Account context injected for the model."),
  internal("attachment:skill_listing", "Skill list injected for the model."),
  internal("attachment:agent_listing_delta", "Agent type list injected for the model."),
  internal("attachment:deferred_tools_delta", "Deferred tool and MCP availability."),
  internal("attachment:deferred_tools_record", "Deferred tool bookkeeping."),
  internal("attachment:mcp_instructions_delta", "MCP server instructions injected."),
  internal("attachment:prompt_snapshot", "System prompt snapshot."),
  internal("attachment:command_permissions", "Allowed tools for a slash command."),
  internal("attachment:thinking_drop", "Thinking-block cache diagnostics."),
  internal("attachment:remote_session_change", "Commit and PR attribution text injected."),

  // rows with no uuid: session bookkeeping, kept and counted
  internal("agent-setting", "Agent definition used by the session."),
  internal("ai-title", "Generated session title."),
  internal("api-request", "API request digest."),
  internal("api-request-blob", "API request payload blob."),
  internal("api-request-shape", "API request shape table."),
  internal("atis-latch", "Internal latch state."),
  internal("cost-state", "Cost and usage totals snapshot."),
  internal("file-history-delta", "File backup delta."),
  internal("file-history-snapshot", "File backup snapshot."),
  internal("last-prompt", "Last prompt and leaf pointer."),
  internal("mode", "Session mode."),
  internal("permission-mode", "Permission mode."),
  internal("pr-link", "Pull request created by the session."),
  internal("queue-operation", "Prompt queue enqueue/dequeue log."),
  internal("tools-used", "Tools used so far."),
];

const DEF_BY_KIND: ReadonlyMap<string, KindDef> = new Map(DEFS.map((d) => [d.kind, d]));

/** Every row kind with an explicit case, for docs/TRANSCRIPT-FORMAT.md. */
export const ROW_KIND_REGISTRY: readonly RowKindInfo[] = DEFS.map((d) => ({
  kind: d.kind,
  disposition: d.disposition,
  doc: d.doc,
}));

export const HANDLED_ROW_KINDS: readonly string[] = DEFS.map((d) => d.kind);

/** Counts rows per kind across the main transcript and any subagent transcripts; unknown kinds are listed apart. */
export function countRowKinds(
  input: ReadonlyArray<unknown>,
  subagents: Readonly<Record<string, ReadonlyArray<unknown>>> = {},
): RowKindCounts {
  const out: RowKindCounts = { total: 0, handled: {}, unknown: {}, unknownCount: 0 };
  const lists = [input, ...Object.values(subagents)];
  for (const list of lists) {
    for (const item of toItems(list)) {
      out.total++;
      const kind = item.row === null ? "unparseable" : rowKind(item.row);
      if (item.row !== null && DEF_BY_KIND.has(kind)) {
        out.handled[kind] = (out.handled[kind] ?? 0) + 1;
      } else {
        out.unknown[kind] = (out.unknown[kind] ?? 0) + 1;
        out.unknownCount++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Branch pruning (R4.2)
//
// Observed in the fixtures (04-compaction is the only one holding a real edit):
//  - Every chained row (user, assistant, system, attachment) has uuid and parentUuid; bookkeeping rows have
//    neither. A parent with several children is usually NOT an edit: an assistant message written one row per
//    content block makes the next block and the tool_result both children of the previous block, and parallel
//    tool calls give every tool_result its own parent. Walking back from the last leaf alone would drop those
//    tool_result rows, so only a fork between real prompts counts as a branch.
//  - An edited or re-sent prompt creates a second user prompt row (not a tool_result, not meta, human origin)
//    under the same parent (04-compaction: two "continue, resume." rows under one turn_duration row). The
//    branch on the path from the latest leaf to the root is kept; the sibling prompts and everything beneath
//    them are dropped.
//  - The kept leaf is the one Claude Code resumes from: the leafUuid of the last last-prompt row that names a
//    row present in the file. Only when there is none, the last chained row in file order that no row names as
//    parent (a guess: a background agent finishing later appends under an old branch).
//  - A losing branch is followed through parentUuid and logicalParentUuid edges, so a compaction that happened
//    on it is dropped together with its divider, summary and everything after.
//  - A queued_command attachment with human origin counts as a prompt row.
//  - Compaction: system compact_boundary has parentUuid null and logicalParentUuid naming the last row before
//    compaction, so the path walk continues through logicalParentUuid and the earlier history stays visible
//    above the divider. Fixtures 02, 03 and 04 confirm the pre-compaction rows lie on that path.
// ---------------------------------------------------------------------------------------------------------

function isPromptRow(row: Row): boolean {
  if (row.type === "attachment") {
    const a = isObj(row.attachment) ? row.attachment : {};
    if (a.type !== "queued_command") return false;
    const kind = isObj(a.origin) ? str(a.origin.kind) : undefined;
    return kind === undefined || kind === "human";
  }
  if (row.type !== "user" || row.isMeta === true || row.isCompactSummary === true) return false;
  const origin = isObj(row.origin) ? str(row.origin.kind) : undefined;
  if (origin !== undefined && origin !== "human") return false;
  const m = isObj(row.message) ? row.message : {};
  const c = m.content;
  if (Array.isArray(c)) return !c.some((b) => isObj(b) && b.type === "tool_result");
  return typeof c === "string";
}

/** Item indexes dropped because they sit on a superseded prompt branch. */
function supersededItems(items: Item[]): Set<number> {
  const nodes = items.filter((it) => it.row !== null && typeof it.row.uuid === "string");
  const byUuid = new Map<string, Item>();
  const children = new Map<string, Item[]>();
  for (const n of nodes) byUuid.set(n.row?.uuid as string, n);
  for (const n of nodes) {
    // compact_boundary has parentUuid null and links back only through logicalParentUuid.
    const p = str(n.row?.parentUuid) ?? str(n.row?.logicalParentUuid);
    if (p === undefined) continue;
    const list = children.get(p);
    if (list) list.push(n);
    else children.set(p, [n]);
  }
  let leaf: Item | undefined;
  for (const it of items) {
    if (it.row?.type !== "last-prompt") continue;
    const target = str(it.row.leafUuid);
    if (target !== undefined && byUuid.has(target)) leaf = byUuid.get(target);
  }
  if (leaf === undefined) {
    for (const n of nodes) if (!children.has(n.row?.uuid as string)) leaf = n;
  }
  const onPath = new Set<string>();
  let cur: Item | undefined = leaf;
  while (cur?.row && !onPath.has(cur.row.uuid as string)) {
    onPath.add(cur.row.uuid as string);
    const next = str(cur.row.parentUuid) ?? str(cur.row.logicalParentUuid);
    cur = next === undefined ? undefined : byUuid.get(next);
  }
  const dropped = new Set<number>();
  for (const kids of children.values()) {
    const prompts = kids.filter((k) => k.row !== null && isPromptRow(k.row));
    if (prompts.length < 2) continue;
    const winner =
      prompts.find((k) => onPath.has(k.row?.uuid as string)) ?? prompts[prompts.length - 1];
    for (const loser of prompts) {
      if (loser === winner) continue;
      const stack: Item[] = [loser];
      while (stack.length > 0) {
        const n = stack.pop() as Item;
        if (dropped.has(n.index)) continue;
        dropped.add(n.index);
        stack.push(...(children.get(n.row?.uuid as string) ?? []));
      }
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------

interface Ctx {
  sub: Map<string, Item[]>;
  meta: NonNullable<NormalizeOptions["subagentMeta"]>;
  metaByToolUse: Map<string, string>;
  /** Agents already expanded once; later references get subagentRef. */
  used: Set<string>;
  /** Agents spawned on a dropped branch; not orphans. */
  abandoned: Set<string>;
  /** Messages emitted into subagent threads so far. */
  subMessages: number;
}

interface ThreadResult {
  messages: UnifiedMessage[];
  usage: TokenUsage;
  contextTokens: number;
  assistantMessageCount: number;
  toolCallCount: number;
}

const ZERO_USAGE = (): TokenUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

function usageOf(x: unknown): TokenUsage | undefined {
  if (!isObj(x)) return undefined;
  return {
    input_tokens: num(x.input_tokens) ?? 0,
    output_tokens: num(x.output_tokens) ?? 0,
    cache_read_input_tokens: num(x.cache_read_input_tokens) ?? 0,
    cache_creation_input_tokens: num(x.cache_creation_input_tokens) ?? 0,
  };
}

function rawSegment(label: string, data: unknown): MessageSegment {
  return { type: "raw", label: label.slice(0, 300), data: capRaw(data) };
}

function rawMessage(
  id: string,
  timestamp: string,
  kind: string,
  label: string,
  data: unknown,
  agent?: string,
): UnifiedMessage {
  const metadata: UnifiedMessageMetadata = { systemSubtype: "raw", rawType: kind };
  if (agent !== undefined) metadata.agent = agent;
  return { id, role: "system", timestamp, segments: [rawSegment(label, data)], metadata };
}

const PERSISTED =
  /^<persisted-output>\s*Output too large \(([^)]*)\)\.\s*Full output saved to:\s*([^\n]{1,512})/;

function flattenResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return c === undefined || c === null ? "" : boundedJson(c);
  return c
    .map((b) => {
      if (isObj(b) && b.type === "text" && typeof b.text === "string") return b.text;
      if (isObj(b) && b.type === "tool_reference") return `[tool: ${str(b.tool_name) ?? "?"}]`;
      return boundedJson(b);
    })
    .join("\n");
}

function buildToolResult(block: Row, row: Row): ToolResult {
  let content = flattenResultContent(block.content);
  const result: ToolResult = { content, is_error: block.is_error === true };
  if (content.startsWith("<persisted-output>")) {
    // Large output stored outside the transcript: show the note only (Phase 4 blockers).
    const m = PERSISTED.exec(content);
    const sizeLabel = m?.[1]?.trim();
    const path = m?.[2]?.trim();
    const truncation: NonNullable<ToolResult["truncation"]> = {};
    if (sizeLabel) truncation.sizeLabel = sizeLabel;
    if (path) truncation.path = path;
    content = `Large output${sizeLabel ? ` (${sizeLabel})` : ""} stored on the laptop${path ? `: ${path}` : ""}`;
    result.content = content;
    result.truncation = truncation;
  }
  const denial = str(row.toolDenialKind);
  if (denial !== undefined) result.denial = denial;
  const ts = str(row.timestamp);
  if (ts !== undefined) result.timestamp = ts;
  return result;
}

interface AsmBlock {
  order: number;
  seg: MessageSegment;
}
interface AsmState {
  msg: UnifiedMessage;
  blocks: Map<string, AsmBlock>;
}

function segmentOfBlock(b: unknown): MessageSegment | null {
  if (!isObj(b)) return rawSegment("content block: non-object", b);
  switch (b.type) {
    case "text": {
      const t = str(b.text)?.trim();
      return t ? { type: "text", content: t } : null;
    }
    case "thinking": {
      const t = (str(b.thinking) ?? str(b.content) ?? str(b.text))?.trim();
      return t ? { type: "thinking", content: t } : null;
    }
    case "redacted_thinking":
      return null;
    case "tool_use": {
      const id = str(b.id);
      const name = str(b.name);
      if (id === undefined || name === undefined)
        return rawSegment("content block: malformed tool_use", b);
      return { type: "tool_call", tool: { id, name, input: limitInput(b.input) } };
    }
    default:
      return rawSegment(`content block: ${typeof b.type === "string" ? b.type : "untyped"}`, b);
  }
}

function userOrigin(row: Row): string | undefined {
  return isObj(row.origin) ? str(row.origin.kind) : undefined;
}

function userMessage(row: Row, base: BuildBase, callIds: Set<string>): UnifiedMessage | null {
  const m = isObj(row.message) ? row.message : {};
  const c = m.content;
  const segments: MessageSegment[] = [];
  if (typeof c === "string") {
    if (c.trim() !== "") segments.push({ type: "text", content: c });
  } else if (Array.isArray(c)) {
    for (const b of c) {
      if (isObj(b) && b.type === "tool_result") {
        const id = str(b.tool_use_id);
        if (id !== undefined && callIds.has(id)) continue; // paired onto its tool_call
        segments.push({
          type: "tool_result",
          result: { ...buildToolResult(b, row), toolCallId: id ?? "" },
        });
      } else if (isObj(b) && b.type === "text") {
        const t = str(b.text);
        if (t !== undefined && t.trim() !== "") segments.push({ type: "text", content: t });
      } else {
        segments.push(
          rawSegment(
            `content block: ${isObj(b) && typeof b.type === "string" ? b.type : "untyped"}`,
            b,
          ),
        );
      }
    }
  } else {
    segments.push(rawSegment("user content of unexpected shape", c));
  }
  if (segments.length === 0) return null;

  const text = segments.flatMap((s) => (s.type === "text" ? [s.content] : [])).join("\n");
  const origin = userOrigin(row);
  let subtype: string | undefined;
  if (row.isCompactSummary === true) subtype = "compact_summary";
  else if (/^<(local-command-|command-name>|command-message>)/.test(text))
    subtype = "local_command";
  else if (text.startsWith("[Request interrupted")) subtype = "interrupted";
  else if (origin !== undefined && origin !== "human")
    subtype = `origin_${origin.replace(/-/g, "_")}`;
  else if (row.isMeta === true) subtype = "meta";

  const metadata: UnifiedMessageMetadata = {};
  if (subtype !== undefined) metadata.systemSubtype = subtype;
  if (origin !== undefined) metadata.origin = origin;
  const ps = str(row.promptSource);
  if (ps !== undefined) metadata.promptSource = ps;
  if (base.agent !== undefined) metadata.agent = base.agent;
  return {
    id: base.id,
    role: subtype === undefined ? "user" : "system",
    timestamp: base.timestamp,
    segments,
    metadata,
  };
}

/** Notes the subagents spawned on a dropped branch so they are not rendered as orphans. */
function markAbandoned(row: Row | null, ctx: Ctx): void {
  if (!row) return;
  const tur = isObj(row.toolUseResult) ? row.toolUseResult : undefined;
  const aid = tur ? str(tur.agentId) : undefined;
  if (aid !== undefined) ctx.abandoned.add(aid);
  const m = isObj(row.message) ? row.message : {};
  if (!Array.isArray(m.content)) return;
  for (const b of m.content) {
    if (!isObj(b)) continue;
    const id =
      b.type === "tool_use" ? str(b.id) : b.type === "tool_result" ? str(b.tool_use_id) : undefined;
    const mapped = id === undefined ? undefined : ctx.metaByToolUse.get(id);
    if (mapped !== undefined) ctx.abandoned.add(mapped);
  }
}

function buildThread(
  items: Item[],
  ctx: Ctx,
  agentId: string | undefined,
  depth: number,
): ThreadResult {
  // Same uuid twice (a re-sent line): first position, last content.
  const firstByUuid = new Map<string, Item>();
  const deduped: Item[] = [];
  for (const it of items) {
    const u = it.row ? str(it.row.uuid) : undefined;
    if (u !== undefined) {
      const first = firstByUuid.get(u);
      if (first) {
        first.row = it.row;
        continue;
      }
      firstByUuid.set(u, it);
    }
    deduped.push(it);
  }
  const dropped = supersededItems(deduped);
  let kept = deduped.filter((it) => !dropped.has(it.index));
  for (const it of deduped) if (dropped.has(it.index)) markAbandoned(it.row, ctx);
  let rowsTruncated = false;
  if (kept.length > MAX_THREAD_ROWS) {
    kept = kept.slice(0, MAX_THREAD_ROWS);
    rowsTruncated = true;
  }

  const idPrefix = agentId === undefined ? "" : `${agentId}:`;
  const callIds = new Set<string>();
  const results = new Map<string, { result: ToolResult; agentId?: string; reported?: Row }>();
  for (const it of kept) {
    const row = it.row;
    if (!row) continue;
    const m = isObj(row.message) ? row.message : {};
    if (row.type === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content)
        if (isObj(b) && b.type === "tool_use" && typeof b.id === "string") callIds.add(b.id);
    }
  }
  for (const it of kept) {
    const row = it.row;
    if (!row || row.type !== "user") continue;
    const m = isObj(row.message) ? row.message : {};
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const tur = isObj(row.toolUseResult) ? row.toolUseResult : undefined;
      let result: ToolResult;
      try {
        result = buildToolResult(b, row);
      } catch {
        result = { content: "[unreadable tool result]", is_error: false };
      }
      const entry: { result: ToolResult; agentId?: string; reported?: Row } = { result };
      const aid = tur ? str(tur.agentId) : undefined;
      if (aid !== undefined && tur) {
        entry.agentId = aid;
        entry.reported = tur;
      }
      results.set(b.tool_use_id, entry);
    }
  }

  const out: UnifiedMessage[] = [];
  const asm = new Map<string, AsmState>();
  const usageByMsg = new Map<string, TokenUsage>();

  for (const it of kept) {
    const row = it.row;
    if (row === null) {
      if (it.sidechain) {
        out.push(
          rawMessage(
            str(it.sidechain.uuid) ?? `${idPrefix}raw:${it.index}`,
            str(it.sidechain.timestamp) ?? "",
            "sidechain-no-agent",
            "sidechain row without agentId",
            it.sidechain,
            agentId,
          ),
        );
        continue;
      }
      const text = typeof it.raw === "string" ? it.raw.slice(0, 2000) : it.raw;
      out.push(
        rawMessage(
          `${idPrefix}raw:${it.index}`,
          "",
          "unparseable",
          "unparseable line",
          text,
          agentId,
        ),
      );
      continue;
    }
    const kind = rowKind(row);
    const def = DEF_BY_KIND.get(kind);
    const uuid = str(row.uuid);
    const base: BuildBase = {
      id: uuid ?? `${idPrefix}raw:${it.index}`,
      timestamp: str(row.timestamp) ?? "",
    };
    if (agentId !== undefined) base.agent = agentId;
    if (!def) {
      // attachment:* and system:* kinds fail closed: key names only, never the values.
      const closed = kind.startsWith("attachment:") || kind.startsWith("system:");
      const data = closed
        ? {
            keys: Object.keys(row).slice(0, RAW_KEYS_MAX),
            ...(isObj(row.attachment)
              ? { attachmentKeys: Object.keys(row.attachment).slice(0, RAW_KEYS_MAX) }
              : {}),
          }
        : row;
      out.push(
        rawMessage(
          base.id,
          base.timestamp,
          kind.slice(0, KIND_LABEL_MAX),
          `unknown row type: ${kind.slice(0, KIND_LABEL_MAX)}`,
          data,
          agentId,
        ),
      );
      continue;
    }
    if (def.disposition === "internal") continue;
    try {
      if (kind === "assistant") {
        addAssistant(row, base, asm, out, usageByMsg);
      } else if (kind === "user") {
        const msg = userMessage(row, base, callIds);
        if (msg) out.push(msg);
      } else if (def.build) {
        const att = kind.startsWith("attachment:") && isObj(row.attachment) ? row.attachment : row;
        const msg = def.build(row, att, base);
        if (msg) out.push(msg);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      out.push(
        rawMessage(
          base.id,
          base.timestamp,
          kind,
          `normalizer error on ${kind}: ${why}`,
          row,
          agentId,
        ),
      );
    }
  }

  if (rowsTruncated) {
    out.push(
      rawMessage(
        `${idPrefix}truncated:rows`,
        "",
        "truncated",
        `truncated: more than ${MAX_THREAD_ROWS} rows in this thread`,
        { limit: MAX_THREAD_ROWS },
        agentId,
      ),
    );
  }

  // Finish assistant messages, pair results and nest subagent threads.
  let toolCallCount = 0;
  const pairedIds = new Set<string>();
  for (const st of asm.values()) {
    st.msg.segments = [...st.blocks.values()].sort((a, b) => a.order - b.order).map((b) => b.seg);
  }
  for (const msg of out) {
    for (const seg of msg.segments) {
      if (seg.type !== "tool_call") continue;
      toolCallCount++;
      const call = seg.tool;
      // One result per id: later calls reusing an id get nothing (no output amplification).
      if (pairedIds.has(call.id)) continue;
      pairedIds.add(call.id);
      const paired = results.get(call.id);
      if (paired) call.result = paired.result;
      const aid = paired?.agentId ?? ctx.metaByToolUse.get(call.id);
      if (aid !== undefined && ctx.sub.has(aid)) {
        if (ctx.used.has(aid)) {
          call.subagentRef = aid; // already expanded elsewhere: link, not copy
        } else {
          const thread = buildSubagent(aid, call.input, paired?.reported, ctx, depth + 1);
          if (thread) call.subagent = thread;
        }
      }
    }
  }

  const usage = ZERO_USAGE();
  let contextTokens = 0;
  for (const u of usageByMsg.values()) {
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.cache_read_input_tokens += u.cache_read_input_tokens;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens;
    contextTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  }
  return {
    messages: out,
    usage,
    contextTokens,
    assistantMessageCount: usageByMsg.size,
    toolCallCount,
  };
}

function addAssistant(
  row: Row,
  base: BuildBase,
  asm: Map<string, AsmState>,
  out: UnifiedMessage[],
  usageByMsg: Map<string, TokenUsage>,
): void {
  const m = isObj(row.message) ? row.message : {};
  const content = m.content;
  const blocks: unknown[] = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  if (row.isApiErrorMessage === true) {
    const text = blocks
      .map((b) => (isObj(b) ? str(b.text) : undefined))
      .filter((t) => t)
      .join("\n");
    const details = [str(row.apiError), str(row.error)].filter((t) => t).join(": ");
    const error: { message: string; details?: string } = { message: text || "API error" };
    if (details) error.details = details;
    out.push(systemMessage(base, "api_error", [{ type: "error", error }]));
    return;
  }

  const mid = str(m.id);
  const rid = str(row.requestId) ?? str(m.requestId) ?? "";
  const key = mid === undefined ? `uuid:${base.id}` : `${mid}|${rid}`;
  let st = asm.get(key);
  if (!st) {
    const metadata: UnifiedMessageMetadata = {};
    if (base.agent !== undefined) metadata.agent = base.agent;
    st = {
      msg: {
        id: mid ?? base.id,
        role: "assistant",
        timestamp: base.timestamp,
        segments: [],
        metadata,
      },
      blocks: new Map(),
    };
    asm.set(key, st);
    out.push(st.msg);
  }
  const idx = num(row.apiBlockIndex);
  if (idx === undefined) {
    // A row without a block index carries the whole message so far: it replaces earlier content.
    for (const k of [...st.blocks.keys()]) if (k.startsWith("r")) st.blocks.delete(k);
  }
  blocks.forEach((b, i) => {
    const bk = idx === undefined ? `r${i}` : `b${idx}:${i}`;
    const seg = segmentOfBlock(b);
    if (seg === null) st.blocks.delete(bk);
    else st.blocks.set(bk, { order: idx === undefined ? i : idx + i / 1000, seg });
  });

  const md = st.msg.metadata as UnifiedMessageMetadata;
  const model = str(m.model);
  if (model !== undefined) md.model = model;
  const usage = usageOf(m.usage);
  if (usage) {
    md.usage = usage;
    md.tokens = usage.output_tokens;
    usageByMsg.set(key, usage);
  }
  const stop = str(m.stop_reason);
  if (stop !== undefined) md.stopReason = stop;
  if (rid) md.requestId = rid;
  const think = num(row.thinkingDurationMs);
  if (think !== undefined) md.thinkingDurationMs = think;
}

function buildSubagent(
  agentId: string,
  callInput: unknown,
  reportedRow: Row | undefined,
  ctx: Ctx,
  depth: number,
): SubagentThread | undefined {
  const items = ctx.sub.get(agentId);
  if (!items || ctx.used.has(agentId)) return undefined;
  const tooDeep = depth > MAX_SUBAGENT_DEPTH;
  // A depth-truncated placeholder must not claim the agent: a shallower call can still get the thread.
  if (!tooDeep) ctx.used.add(agentId);
  let t: ThreadResult;
  if (tooDeep || ctx.subMessages > MAX_SUBAGENT_MESSAGES) {
    const why =
      depth > MAX_SUBAGENT_DEPTH
        ? `truncated: subagent nesting deeper than ${MAX_SUBAGENT_DEPTH}`
        : `truncated: more than ${MAX_SUBAGENT_MESSAGES} subagent messages`;
    t = {
      messages: [rawMessage(`${agentId}:truncated`, "", "truncated", why, {}, agentId)],
      usage: ZERO_USAGE(),
      contextTokens: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
    };
  } else {
    t = buildThread(items, ctx, agentId, depth);
  }
  ctx.subMessages += t.messages.length;
  const meta = ctx.meta[agentId] ?? {};
  const input = isObj(callInput) ? callInput : {};
  const thread: SubagentThread = {
    agentId,
    messages: t.messages,
    usage: t.usage,
    contextTokens: t.contextTokens,
    assistantMessageCount: t.assistantMessageCount,
    toolCallCount: t.toolCallCount,
  };
  const agentType = meta.agentType ?? str(reportedRow?.agentType) ?? str(input.subagent_type);
  if (agentType !== undefined) thread.agentType = agentType;
  const description = meta.description ?? str(input.description);
  if (description !== undefined) thread.description = description;
  if (reportedRow) {
    const reported: NonNullable<SubagentThread["reported"]> = {};
    const status = str(reportedRow.status);
    if (status !== undefined) reported.status = status;
    const tt = num(reportedRow.totalTokens);
    if (tt !== undefined) reported.totalTokens = tt;
    const td = num(reportedRow.totalDurationMs);
    if (td !== undefined) reported.totalDurationMs = td;
    const tc = num(reportedRow.totalToolUseCount);
    if (tc !== undefined) reported.totalToolUseCount = tc;
    thread.reported = reported;
  }
  return thread;
}

/**
 * Normalizes the rows of a main transcript (parsed objects or raw JSONL lines) into messages.
 * Never throws: rows it has no case for, and lines that do not parse, become raw messages.
 * Sidechain rows leave the main list; their threads nest under the spawning Agent/Task call.
 *
 * Callers MUST enforce an input byte cap before calling: known-kind text is not capped here, and
 * cost is linear in row count (1M tiny rows take about 10 s). The hub transcript API enforces it.
 */
export function normalizeTranscript(
  input: ReadonlyArray<unknown>,
  options: NormalizeOptions = {},
): UnifiedMessage[] {
  const sub = new Map<string, Item[]>();
  for (const [id, rows] of Object.entries(options.subagents ?? {})) sub.set(id, toItems(rows));

  // isSidechain separation: sidechain rows in the main file go to their agent's thread.
  const main: Item[] = [];
  const side = new Map<string, Row[]>();
  for (const it of toItems(input)) {
    if (it.row?.isSidechain === true) {
      const aid = str(it.row.agentId);
      if (aid === undefined) {
        main.push({ index: main.length, row: null, sidechain: it.row });
      } else if (!sub.has(aid)) {
        const list = side.get(aid);
        if (list) list.push(it.row);
        else side.set(aid, [it.row]);
      }
      continue;
    }
    main.push({ ...it, index: main.length });
  }
  for (const [aid, rows] of side) sub.set(aid, toItems(rows));

  const meta = options.subagentMeta ?? {};
  const metaByToolUse = new Map<string, string>();
  for (const [aid, m] of Object.entries(meta))
    if (m.toolUseId !== undefined) metaByToolUse.set(m.toolUseId, aid);
  const ctx: Ctx = {
    sub,
    meta,
    metaByToolUse,
    used: new Set(),
    abandoned: new Set(),
    subMessages: 0,
  };

  const messages = buildThread(main, ctx, undefined, 0).messages;

  // Threads whose spawning call is not in the main list still show up.
  for (const aid of sub.keys()) {
    if (ctx.used.has(aid) || ctx.abandoned.has(aid)) continue;
    const thread = buildSubagent(aid, {}, undefined, ctx, 1);
    if (!thread) continue;
    const first = thread.messages[0];
    messages.push({
      id: `orphan-agent:${aid}`,
      role: "system",
      timestamp: first?.timestamp ?? "",
      segments: [
        {
          type: "tool_call",
          tool: { id: `orphan-agent:${aid}`, name: "Agent", input: {}, subagent: thread },
        },
      ],
      metadata: { systemSubtype: "orphan_subagent", agent: aid },
    });
  }
  return messages;
}
