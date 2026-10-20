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
// (the hub session_id is the parent session, subagent rows arrive with agent_id set); a single
// pass over rows in (session_id, agent_id, line_no) order replaces ccusage's per-file pass plus
// global merge (same result: strictly larger token total replaces, ties keep the first); sidechain
// rows are counted, exactly like ccusage (it has no sidechain filter).
import { z } from "zod";
import type { PricingTable } from "../pricing/pricing.ts";

/** SQL prefilter and ccusage's own marker: only lines containing this are considered. */
export const USAGE_MARKER = '"usage":{';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const VERSION = /^\d+\.\d+\.\d+/;

/** ccusage usageDataSchema (valibot) re-expressed in zod; nulls are rejected like valibot optional. */
const UsageLineSchema = z.object({
  cwd: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  timestamp: z.string().regex(ISO_TIMESTAMP),
  version: z.string().regex(VERSION).optional(),
  message: z.object({
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      speed: z.enum(["standard", "fast"]).optional(),
    }),
    model: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    content: z.array(z.object({ text: z.string().optional() })).optional(),
  }),
  costUSD: z.number().optional(),
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
}

interface Entry {
  sessionId: string;
  date: string;
  timestamp: string;
  model: string | undefined;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
  uniqueHash: string | null;
  tokenTotal: number;
  hasSpeed: boolean;
  version: string | undefined;
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

function add(s: TokenStats, e: Entry): void {
  s.input_tokens += e.input;
  s.output_tokens += e.output;
  s.cache_creation_tokens += e.cacheCreation;
  s.cache_read_tokens += e.cacheRead;
  s.cost_usd += e.cost;
}

class Summary {
  readonly totals = emptyStats();
  readonly byModel = new Map<string, TokenStats>();
  readonly models: string[] = [];
  add(e: Entry): void {
    add(this.totals, e);
    if (e.model === "<synthetic>") return;
    const name = e.model ?? "unknown";
    if (e.model !== undefined && !this.byModel.has(name)) this.models.push(name);
    let m = this.byModel.get(name);
    if (m === undefined) {
      m = emptyStats();
      this.byModel.set(name, m);
    }
    add(m, e);
  }
  finish(): UsageSummary {
    return {
      ...this.totals,
      total_tokens:
        this.totals.input_tokens +
        this.totals.output_tokens +
        this.totals.cache_creation_tokens +
        this.totals.cache_read_tokens,
      models: this.models,
      model_breakdowns: [...this.byModel]
        .map(([model, s]) => ({ model, ...s }))
        .sort((a, b) => b.cost_usd - a.cost_usd),
    };
  }
}

export const emptyUsage = (): UsageSummary => new Summary().finish();

/**
 * Feed rows in (session_id, agent_id, line_no) order. dedupeScope "global" keys the dedup on the
 * message hash alone (ccusage: one pass over all files); "session" keeps a separate key space per
 * session, which is what the cheap single-session read can afford.
 */
export class UsageCollector {
  private readonly entries: Entry[] = [];
  private readonly index = new Map<string, number>();
  private readonly day: (iso: string) => string;

  constructor(
    private readonly pricing: PricingTable,
    tz: string | undefined,
    private readonly scope: "global" | "session" = "global",
  ) {
    this.day = makeDayFormatter(tz);
  }

  addRow(row: UsageRowIn): void {
    const d = parseUsageLine(row.raw);
    if (d === null) return;
    const u = d.message.usage;
    const hash = createUniqueHash(d);
    const tokenTotal = sumTokens(u);
    const hasSpeed = u.speed != null;
    const key =
      hash === null ? null : this.scope === "global" ? hash : `${row.session_id}\0${hash}`;
    let at: number | undefined;
    if (key !== null) {
      at = this.index.get(key);
      if (at !== undefined) {
        const ex = this.entries[at]!;
        // shouldReplaceEntryMetadata: larger total wins; on a tie only gaining a speed field wins.
        const replace =
          tokenTotal !== ex.tokenTotal ? tokenTotal > ex.tokenTotal : hasSpeed && !ex.hasSpeed;
        if (!replace) return;
      }
    }
    const model = d.message.model;
    const entry: Entry = {
      sessionId: row.session_id,
      date: this.day(d.timestamp),
      timestamp: d.timestamp,
      model: model == null ? undefined : u.speed === "fast" ? `${model}-fast` : model,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      // Cost mode "auto": costUSD when present, else priced from tokens.
      cost: d.costUSD ?? this.pricing.cost(u, model, u.speed),
      uniqueHash: hash,
      tokenTotal,
      hasSpeed,
      version: d.version,
    };
    if (at !== undefined) this.entries[at] = entry;
    else {
      this.entries.push(entry);
      if (key !== null) this.index.set(key, this.entries.length - 1);
    }
  }

  get count(): number {
    return this.entries.length;
  }

  sessions(): SessionUsage[] {
    const groups = new Map<string, { latest: Entry; s: Summary; versions: Set<string> }>();
    for (const e of this.entries) {
      let g = groups.get(e.sessionId);
      if (g === undefined) {
        g = { latest: e, s: new Summary(), versions: new Set() };
        groups.set(e.sessionId, g);
      } else if (e.timestamp > g.latest.timestamp) g.latest = e;
      if (e.version != null) g.versions.add(e.version);
      g.s.add(e);
    }
    return [...groups].map(([session_id, g]) => ({
      session_id,
      ...g.s.finish(),
      last_activity: g.latest.date,
      versions: [...g.versions].sort(),
    }));
  }

  /** Ascending by date; from/to are inclusive YYYY-MM-DD in the collector's timezone. */
  daily(from?: string, to?: string): DailyUsage[] {
    const groups = new Map<string, Summary>();
    for (const e of this.entries) {
      if ((from !== undefined && e.date < from) || (to !== undefined && e.date > to)) continue;
      let s = groups.get(e.date);
      if (s === undefined) {
        s = new Summary();
        groups.set(e.date, s);
      }
      s.add(e);
    }
    return [...groups]
      .map(([date, s]) => ({ date, ...s.finish() }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
}
