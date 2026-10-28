// Usage aggregation over stored transcript lines: ccusage v19.0.3 dedup and cost mode "auto".
//
// Borrowed from ryoppippi/ccusage (MIT, Copyright (c) 2025 ryoppippi), tag v19.0.3,
// apps/ccusage/src/adapter/claude/data-loader.ts:
//   usageDataSchema, createUniqueHash, sumUsageTokens, shouldReplaceEntryMetadata,
//   calculateCostForEntry / createCostCalculator (mode "auto"), collectSessionEntriesFromFile and
//   collectDailyEntriesFromFile (dedup loop), addTokenFieldsToSummaryAccumulator and
//   finalizeUsageSummary (grouping, <synthetic> handling), resolveClaudeSessionPath (subagent
//   files belong to the parent session).
// apps/ccusage/src/date-utils.ts: createCachedDateFormatter (day bucketing, en-CA).
// Changes: valibot replaced by zod; file walking replaced by rows of the transcript_lines table
// (the hub session_id is the parent session, subagent rows arrive with agent_id set); rows are
// fed incrementally in any order and the winner per message hash is chosen by (larger token
// total, speed present, earlier position in ccusage's sorted file order), which equals ccusage's
// sequential pass over sorted files; sidechain rows are counted, exactly like ccusage (it has no
// sidechain filter). Pricing and day bucketing are applied at read time.
import { z } from "zod";
import type { PricingTable } from "../pricing/pricing.ts";

/** SQL prefilter and ccusage's own marker: only lines containing this are considered. */
export const USAGE_MARKER = '"usage":{';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const VERSION = /^\d+\.\d+\.\d+/;

/** Token counts are non-negative integers; a negative, fractional or 1e999 count skips the line. */
const tokens = z.number().int().nonnegative();

/** ccusage usageDataSchema (valibot) re-expressed in zod; nulls are rejected like valibot optional. */
const UsageLineSchema = z.object({
  cwd: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  timestamp: z.string().regex(ISO_TIMESTAMP),
  version: z.string().regex(VERSION).optional(),
  message: z.object({
    usage: z.object({
      input_tokens: tokens,
      output_tokens: tokens,
      cache_creation_input_tokens: tokens.optional(),
      cache_read_input_tokens: tokens.optional(),
      speed: z.enum(["standard", "fast"]).optional(),
      // TTL split of the cache writes; an unexpected shape is ignored, not a reason to skip the line.
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: tokens.optional(),
          ephemeral_5m_input_tokens: tokens.optional(),
        })
        .optional()
        .catch(undefined),
    }),
    model: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    content: z.array(z.object({ text: z.string().optional() })).optional(),
  }),
  costUSD: z.number().finite().nonnegative().optional(),
  requestId: z.string().min(1).optional(),
  isApiErrorMessage: z.boolean().optional(),
});
export type UsageData = z.infer<typeof UsageLineSchema>;

/** Returns null for lines ccusage would skip (no usage marker, bad JSON, schema mismatch). */
export function parseUsageLine(raw: string): UsageData | null {
  if (!raw.includes(USAGE_MARKER)) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = UsageLineSchema.safeParse(json);
  return r.success ? r.data : null;
}

export function createUniqueHash(d: UsageData): string | null {
  const id = d.message.id;
  if (id == null) return null;
  return d.requestId == null ? id : `${id}:${d.requestId}`;
}

function sumTokens(u: UsageData["message"]["usage"]): number {
  return (
    u.input_tokens +
    u.output_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

/** Local day when tz is undefined (ccusage default), else the day in an IANA zone ("UTC" included). */
export function makeDayFormatter(tz: string | undefined): (iso: string) => string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  if (tz === undefined) {
    return (iso) => {
      const d = new Date(iso);
      return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
  }
  if (tz === "UTC") {
    return (iso) => {
      const d = new Date(iso);
      return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    };
  }
  const f = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  });
  return (iso) => f.format(new Date(iso));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface UsageRowIn {
  session_id: string;
  raw: string;
  /** Agent id of the file the line came from ('' = the main transcript). */
  agent_id?: string;
  /** Line number within that file; with the file key it is the position ccusage would read it at. */
  line_no?: number;
  /** Session's project_dir (a cwd); ccusage's file order starts with the encoded project dir. */
  project_dir?: string | null;
}

interface Entry {
  sessionId: string;
  /** Path-like key of the source file, ordered like ccusage's `collectJsonlFiles` sort. */
  file: string;
  line: number;
  timestamp: string;
  /** Model as written (used to price). */
  model: string | undefined;
  /** Model as reported: `-fast` suffix for speed "fast" (ccusage). */
  displayModel: string | undefined;
  speed: string | undefined;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** TTL split of cacheCreation; undefined when the row has none. */
  cache1h: number | undefined;
  cache5m: number | undefined;
  costUSD: number | undefined;
  tokenTotal: number;
  hasSpeed: boolean;
  version: string | undefined;
  // Read-time caches, valid for the table / formatter they were computed with.
  pricedBy: PricingTable | undefined;
  priced: number;
  /** Model name when this row had tokens but no price (and no costUSD), else undefined. */
  unpriced: string | undefined;
  dayBy: DayFmt | undefined;
  day: string;
}

export interface TokenStats {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}
export interface ModelBreakdown extends TokenStats {
  model: string;
}
export interface UsageSummary extends TokenStats {
  total_tokens: number;
  /** First-seen order, `<synthetic>` excluded (ccusage modelsUsed). */
  models: string[];
  model_breakdowns: ModelBreakdown[];
  /** Models seen with tokens but no pricing entry; their cost counted as 0. Additive field. */
  unpricedModels: string[];
}
export interface SessionUsage extends UsageSummary {
  session_id: string;
  /** Local-or-tz day of the newest counted row (ccusage lastActivity). */
  last_activity: string;
  versions: string[];
}
export interface DailyUsage extends UsageSummary {
  date: string;
}

const emptyStats = (): TokenStats => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  cost_usd: 0,
});

function add(s: TokenStats, e: Entry, cost: number): void {
  s.input_tokens += e.input;
  s.output_tokens += e.output;
  s.cache_creation_tokens += e.cacheCreation;
  s.cache_read_tokens += e.cacheRead;
  s.cost_usd += cost;
}

class Summary {
  readonly totals = emptyStats();
  readonly byModel = new Map<string, TokenStats>();
  private readonly unpriced = new Set<string>();
  /** Earliest (file, line) each model was seen at: models list in ccusage's file order, not ingest order. */
  private readonly firstAt = new Map<string, { file: string; line: number }>();
  add(e: Entry, cost: number): void {
    add(this.totals, e, cost);
    if (e.unpriced !== undefined) this.unpriced.add(e.unpriced);
    if (e.displayModel === "<synthetic>") return;
    const name = e.displayModel ?? "unknown";
    if (e.displayModel !== undefined) {
      const f = this.firstAt.get(name);
      if (f === undefined || e.file < f.file || (e.file === f.file && e.line < f.line))
        this.firstAt.set(name, { file: e.file, line: e.line });
    }
    let m = this.byModel.get(name);
    if (m === undefined) {
      m = emptyStats();
      this.byModel.set(name, m);
    }
    add(m, e, cost);
  }
  /** `sorted`: ccusage `daily` lists models alphabetically; `session` keeps file order. */
  finish(sorted = false): UsageSummary {
    return {
      ...this.totals,
      total_tokens:
        this.totals.input_tokens +
        this.totals.output_tokens +
        this.totals.cache_creation_tokens +
        this.totals.cache_read_tokens,
      models: sorted
        ? [...this.firstAt.keys()].sort()
        : [...this.firstAt]
            .sort(([, a], [, b]) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
            .map(([m]) => m),
      model_breakdowns: [...this.byModel]
        .map(([model, s]) => ({ model, ...s }))
        .sort((a, b) => b.cost_usd - a.cost_usd),
      unpricedModels: [...this.unpriced].sort(),
    };
  }
}

export const emptyUsage = (): UsageSummary => new Summary().finish();

interface DayFmt {
  readonly tz: string | undefined;
  readonly of: (iso: string) => string;
}
const fmtCache = new Map<string, DayFmt>();
function dayFmt(tz: string | undefined): DayFmt {
  const k = tz ?? "\0local";
  let f = fmtCache.get(k);
  if (f === undefined) {
    if (fmtCache.size >= 64) fmtCache.clear();
    f = { tz, of: makeDayFormatter(tz) };
    fmtCache.set(k, f);
  }
  return f;
}

/** `YYYY-MM-DD` shifted by whole days (UTC arithmetic on the calendar date). */
function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Encoded project directory name Claude Code uses under ~/.claude/projects (non-alphanumerics to '-'). */
export function encodeProjectDir(dir: string | null | undefined): string {
  return dir == null ? "" : dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Parsed, globally deduplicated usage entries. Rows are append-only, so the index is fed
 * incrementally (addRow) and never re-parses a line. The result does not depend on the order rows
 * are added: for one message hash the winner is the largest token total, then a row carrying
 * `speed`, then the earliest in ccusage's file order (path sort, then line), which is exactly what
 * ccusage's sequential pass over sorted files yields. Pricing and time zone are applied at read.
 */
export class UsageCollector {
  private readonly entries: Entry[] = [];
  private readonly byHash = new Map<string, number>();
  private readonly bySession = new Map<string, Set<number>>();
  private readonly fileKeys = new Map<string, string>();
  /**
   * project_dir each session's rows were keyed with. The file key (tie-break) depends on it, and
   * project_dir arrives with a later statusLine, so the owner rebuilds the index when it changes
   * (see staleProjects); that makes the result equal to a cold build whatever the arrival order.
   * Memory bound: one indexed row costs about 250 to 330 bytes measured (bench-history: 248 B/row at 75% unique; strings shared via fileKeys and the
   * session id), so 1M usage rows is about 300 MB. No eviction.
   */
  private readonly projects = new Map<string, string | null>();
  private ver = 0;

  /** @param onUnpriced called each time a row is priced and its model has no pricing entry. */
  constructor(private readonly onUnpriced?: (model: string) => void) {}

  /** Bumps whenever a row changes what any read would return. */
  get version(): number {
    return this.ver;
  }
  get count(): number {
    return this.entries.length;
  }

  /** True when a session already indexed now has a different project_dir than its rows were keyed with. */
  staleProjects(current: ReadonlyMap<string, string | null>): boolean {
    for (const [session, project] of this.projects) {
      if ((current.get(session) ?? null) !== project) return true;
    }
    return false;
  }

  private fileKey(session: string, agent: string, project: string | null | undefined): string {
    const k = `${project ?? ""}\0${session}\0${agent}`;
    let f = this.fileKeys.get(k);
    if (f === undefined) {
      const dir = encodeProjectDir(project);
      f =
        agent === ""
          ? `${dir}/${session}.jsonl`
          : `${dir}/${session}/subagents/agent-${agent}.jsonl`;
      this.fileKeys.set(k, f);
    }
    return f;
  }

  /** Returns true when the row was a usage row that changed the index. */
  addRow(row: UsageRowIn): boolean {
    const d = parseUsageLine(row.raw);
    if (d === null) return false;
    const u = d.message.usage;
    this.projects.set(row.session_id, row.project_dir ?? null);
    const hash = createUniqueHash(d);
    const tokenTotal = sumTokens(u);
    const hasSpeed = u.speed != null;
    const file = this.fileKey(row.session_id, row.agent_id ?? "", row.project_dir);
    const line = row.line_no ?? this.entries.length;
    let at: number | undefined;
    if (hash !== null) {
      at = this.byHash.get(hash);
      if (at !== undefined) {
        const ex = this.entries[at]!;
        let better: boolean;
        if (tokenTotal !== ex.tokenTotal) better = tokenTotal > ex.tokenTotal;
        else if (hasSpeed !== ex.hasSpeed) better = hasSpeed;
        else better = file < ex.file || (file === ex.file && line < ex.line);
        if (!better) return false;
      }
    }
    const model = d.message.model ?? undefined;
    const entry: Entry = {
      sessionId: row.session_id,
      file,
      line,
      timestamp: d.timestamp,
      model,
      displayModel: model === undefined ? undefined : u.speed === "fast" ? `${model}-fast` : model,
      speed: u.speed,
      input: u.input_tokens,
      output: u.output_tokens,
      // Reported = priced: with a 1-hour share the TTL split wins when it exceeds the total
      // (see cacheWriteCost). Rows with no 1-hour tokens keep ccusage's value unchanged.
      cacheCreation:
        (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0
          ? Math.max(
              u.cache_creation_input_tokens ?? 0,
              (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
                (u.cache_creation?.ephemeral_5m_input_tokens ?? 0),
            )
          : (u.cache_creation_input_tokens ?? 0),
      cacheRead: u.cache_read_input_tokens ?? 0,
      cache1h: u.cache_creation?.ephemeral_1h_input_tokens,
      cache5m: u.cache_creation?.ephemeral_5m_input_tokens,
      // Cost mode "auto": costUSD when present, else priced from tokens at read time.
      costUSD: d.costUSD,
      tokenTotal,
      hasSpeed,
      version: d.version,
      pricedBy: undefined,
      priced: 0,
      unpriced: undefined,
      dayBy: undefined,
      day: "",
    };
    if (at === undefined) {
      at = this.entries.length;
      this.entries.push(entry);
      if (hash !== null) this.byHash.set(hash, at);
    } else this.entries[at] = entry;
    let set = this.bySession.get(entry.sessionId);
    if (set === undefined) this.bySession.set(entry.sessionId, (set = new Set()));
    set.add(at);
    this.ver++;
    return true;
  }

  private cost(e: Entry, pricing: PricingTable): number {
    if (e.pricedBy !== pricing) {
      e.priced =
        e.costUSD ??
        pricing.cost(
          {
            input_tokens: e.input,
            output_tokens: e.output,
            cache_creation_input_tokens: e.cacheCreation,
            cache_read_input_tokens: e.cacheRead,
            cache_creation_1h_tokens: e.cache1h,
            cache_creation_5m_tokens: e.cache5m,
          },
          e.model,
          e.speed,
        );
      e.pricedBy = pricing;
      e.unpriced =
        e.costUSD === undefined &&
        e.model !== undefined &&
        e.model !== "<synthetic>" &&
        e.tokenTotal > 0 &&
        !pricing.isPriced(e.model)
          ? e.model
          : undefined;
      if (e.unpriced !== undefined) this.onUnpriced?.(e.unpriced);
    }
    return e.priced;
  }

  private dayOf(e: Entry, f: DayFmt): string {
    if (e.dayBy !== f) {
      e.day = f.of(e.timestamp);
      e.dayBy = f;
    }
    return e.day;
  }

  /**
   * Per-session totals (ccusage `session`). With `sessionId` only that session is aggregated; the
   * dedup is still global, so a message replayed into a resumed session counts once, where ccusage
   * counts it.
   */
  sessions(pricing: PricingTable, tz: string | undefined, sessionId?: string): SessionUsage[] {
    const f = dayFmt(tz);
    const groups = new Map<string, { latest: Entry; s: Summary; versions: Set<string> }>();
    const visit = (e: Entry): void => {
      let g = groups.get(e.sessionId);
      if (g === undefined) {
        g = { latest: e, s: new Summary(), versions: new Set() };
        groups.set(e.sessionId, g);
      } else if (e.timestamp > g.latest.timestamp) g.latest = e;
      if (e.version != null) g.versions.add(e.version);
      g.s.add(e, this.cost(e, pricing));
    };
    if (sessionId === undefined) this.entries.forEach(visit);
    else {
      const idx = this.bySession.get(sessionId);
      if (idx !== undefined) {
        for (const i of [...idx].sort((a, b) => a - b)) {
          const e = this.entries[i]!;
          if (e.sessionId === sessionId) visit(e);
        }
      }
    }
    return [...groups].map(([session_id, g]) => ({
      session_id,
      ...g.s.finish(),
      last_activity: this.dayOf(g.latest, f),
      versions: [...g.versions].sort(),
    }));
  }

  /** Ascending by date; from/to are inclusive YYYY-MM-DD in the response timezone. */
  daily(pricing: PricingTable, tz: string | undefined, from?: string, to?: string): DailyUsage[] {
    const f = dayFmt(tz);
    // No zone is more than 14 h from UTC: entries a whole day outside [from, to] on the UTC date
    // cannot land inside it, so they skip the (costly) zone conversion.
    const lo = from === undefined ? undefined : shiftDay(from, -1);
    const hi = to === undefined ? undefined : shiftDay(to, 1);
    const groups = new Map<string, Summary>();
    for (const e of this.entries) {
      if (lo !== undefined || hi !== undefined) {
        const utc = e.timestamp.slice(0, 10);
        if ((lo !== undefined && utc < lo) || (hi !== undefined && utc > hi)) continue;
      }
      const date = this.dayOf(e, f);
      if ((from !== undefined && date < from) || (to !== undefined && date > to)) continue;
      let s = groups.get(date);
      if (s === undefined) {
        s = new Summary();
        groups.set(date, s);
      }
      s.add(e, this.cost(e, pricing));
    }
    return [...groups]
      .map(([date, s]) => ({ date, ...s.finish(true) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
}
