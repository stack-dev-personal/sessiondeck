import path from "node:path";
import { isValidTimeZone } from "./usage/usage.ts";

export interface HubConfig {
  token: string;
  dbPath: string;
  port: number;
  bind: string;
  /**
   * D-S3-5. Global ingest limit in envelopes per second and bucket size, keyed on the
   * authenticated principal (SHA-256 of the bearer token; one token in the MVP, so a global cap).
   */
  ingestRate: number;
  ingestBurst: number;
  /** Per-host fairness buckets (keyed on the validated body.host), same units. */
  hostRate: number;
  hostBurst: number;
  /** Hosts not yet in the hosts table are refused (429) once the table holds this many. */
  maxHosts: number;
  /** D-S3-14. Per-principal read limit (GET routes and WS upgrades), requests per second and burst. */
  readRate: number;
  readBurst: number;
  /** Extra per-principal limit on /history/* (each call aggregates every stored usage row). */
  historyRate: number;
  historyBurst: number;
  /** Concurrent WS /stream clients; further upgrades get 503. */
  maxWsClients: number;
  /** HUB_ALLOWED_ORIGINS; when non-empty, an upgrade with any other Origin is refused (403). */
  allowedOrigins: string[];
  /** New sessions for a host are not created once it has this many open (non-ended) sessions. */
  maxOpenSessionsPerHost: number;
  /** HUB_PRICING_FILE: LiteLLM-shaped pricing file; highest precedence, disables the fetch. */
  pricingFile?: string;
  /** HUB_PRICING_FETCH (default on): fetch LiteLLM prices once at startup, in the background. */
  pricingFetch: boolean;
  /**
   * HUB_TIMEZONE: IANA zone used to bucket history days when a request gives no `tz`. Unset means
   * the process-local zone, which is ccusage's default.
   */
  timezone?: string;
  /** HUB_EVENT_RETENTION_DAYS: events older than this are folded into baselines and deleted. */
  eventRetentionDays: number;
  /** HUB_SAMPLE_RETENTION_DAYS: statusline samples older than this are deleted. */
  sampleRetentionDays: number;
  /** HUB_RETENTION_INTERVAL_MS: time between retention passes; 0 disables the timer. */
  retentionIntervalMs: number;
  /** HUB_MAX_CLOCK_SKEW_MS: ingest rejects an envelope whose ts is further ahead of the hub clock. */
  maxClockSkewMs: number;
  /** HUB_COMPACT_BATCH_SIZE / HUB_COMPACT_BATCH_MS: events and fold time budget per compaction batch. */
  compactBatchSize: number;
  compactBatchBudgetMs: number;
  /** HUB_COMPACT_MAX_EVENTS: events compacted per pass (0 = no cap); a backlog drains over several passes. */
  compactMaxEvents: number;
}

/** What the replay and compact subcommands need; no token, no network settings. */
export interface RetentionSettings {
  dbPath: string;
  eventRetentionDays: number;
  sampleRetentionDays: number;
  retentionIntervalMs: number;
  maxOpenSessionsPerHost: number;
  maxClockSkewMs: number;
  compactBatchSize: number;
  compactBatchBudgetMs: number;
  /** HUB_COMPACT_MAX_EVENTS: events compacted per pass (0 = no cap); a backlog drains over several passes. */
  compactMaxEvents: number;
}

function nonNegInt(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadRetentionSettings(env: Record<string, string | undefined>): RetentionSettings {
  return {
    dbPath: env["HUB_DB_PATH"] ?? path.join(".", "data", "hub.sqlite"),
    eventRetentionDays: posInt(env, "HUB_EVENT_RETENTION_DAYS", 30),
    sampleRetentionDays: posInt(env, "HUB_SAMPLE_RETENTION_DAYS", 30),
    retentionIntervalMs: nonNegInt(env, "HUB_RETENTION_INTERVAL_MS", 3_600_000),
    maxOpenSessionsPerHost: posInt(env, "HUB_MAX_OPEN_SESSIONS", 1000),
    maxClockSkewMs: skewMs(env),
    compactBatchSize: posInt(env, "HUB_COMPACT_BATCH_SIZE", 100),
    compactBatchBudgetMs: posInt(env, "HUB_COMPACT_BATCH_MS", 10),
    compactMaxEvents: nonNegInt(env, "HUB_COMPACT_MAX_EVENTS", 1_000_000),
  };
}

export const MIN_TOKEN_LENGTH = 16;

/** Largest ingest batch (envelopes); a bucket smaller than this would under-charge a full batch. */
export const MIN_BUCKET = 5000;

function posInt(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export const MIN_CLOCK_SKEW_MS = 60_000;
export const MAX_CLOCK_SKEW_MS = 7 * 86_400_000;

/** HUB_MAX_CLOCK_SKEW_MS: one minute to seven days; outside that range startup fails. */
function skewMs(env: Record<string, string | undefined>): number {
  const n = posInt(env, "HUB_MAX_CLOCK_SKEW_MS", 86_400_000);
  if (n < MIN_CLOCK_SKEW_MS || n > MAX_CLOCK_SKEW_MS) {
    throw new Error(
      `HUB_MAX_CLOCK_SKEW_MS must be between ${MIN_CLOCK_SKEW_MS} and ${MAX_CLOCK_SKEW_MS}`,
    );
  }
  return n;
}

function bool(env: Record<string, string | undefined>, name: string, dflt: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be 0, 1, true or false`);
}

// Exact origins only: http(s)://host[:port], no path, never "*" or "null". Lowercased at load so the
// exact-match checks (CORS and WS) compare like with like. Errors name the entry, not the env.
function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const entry of (raw ?? "").split(",").map((o) => o.trim())) {
    if (entry === "") continue;
    const shown = JSON.stringify(entry.slice(0, 80));
    const m = entry.match(/^(https?):\/\/([^/?#@\s\\]+)$/i);
    let ok = m !== null;
    if (ok) {
      try {
        const u = new URL(entry);
        ok = u.username === "" && u.password === "" && u.hostname !== "";
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      throw new Error(
        `HUB_ALLOWED_ORIGINS entry ${shown} is not a valid origin (want http(s)://host[:port], no path; "*" and "null" are not allowed)`,
      );
    }
    out.push(entry.toLowerCase());
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined>): HubConfig {
  const token = env["HUB_TOKEN"];
  if (token === undefined || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`HUB_TOKEN is required and must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const rawPort = env["HUB_PORT"];
  const portRaw = rawPort === undefined || rawPort === "" ? "8787" : rawPort;
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HUB_PORT must be an integer between 1 and 65535");
  }
  const ingestRate = posInt(env, "HUB_INGEST_RATE", 5000);
  const hostRate = posInt(env, "HUB_HOST_RATE", ingestRate);
  const ingestBurst = posInt(env, "HUB_INGEST_BURST", Math.max(ingestRate * 2, MIN_BUCKET));
  const hostBurst = posInt(env, "HUB_HOST_BURST", Math.max(hostRate * 2, MIN_BUCKET));
  for (const [name, v] of [
    ["HUB_INGEST_BURST", ingestBurst],
    ["HUB_HOST_BURST", hostBurst],
  ] as const) {
    if (v < MIN_BUCKET) throw new Error(`${name} must be at least ${MIN_BUCKET} (max batch size)`);
  }
  const timezone = env["HUB_TIMEZONE"];
  if (timezone !== undefined && timezone !== "" && !isValidTimeZone(timezone)) {
    throw new Error("HUB_TIMEZONE must be an IANA time zone name");
  }
  const pricingFile = env["HUB_PRICING_FILE"];
  const retention = loadRetentionSettings(env);
  return {
    eventRetentionDays: retention.eventRetentionDays,
    sampleRetentionDays: retention.sampleRetentionDays,
    retentionIntervalMs: retention.retentionIntervalMs,
    maxClockSkewMs: retention.maxClockSkewMs,
    compactBatchSize: retention.compactBatchSize,
    compactBatchBudgetMs: retention.compactBatchBudgetMs,
    compactMaxEvents: retention.compactMaxEvents,
    ...(pricingFile !== undefined && pricingFile !== "" ? { pricingFile } : {}),
    ...(timezone !== undefined && timezone !== "" ? { timezone } : {}),
    pricingFetch: bool(env, "HUB_PRICING_FETCH", true),
    token,
    ingestRate,
    ingestBurst,
    hostRate,
    hostBurst,
    readRate: posInt(env, "HUB_READ_RATE", 50),
    readBurst: posInt(env, "HUB_READ_BURST", 100),
    historyRate: posInt(env, "HUB_HISTORY_RATE", 1),
    historyBurst: posInt(env, "HUB_HISTORY_BURST", 2),
    maxWsClients: posInt(env, "HUB_MAX_WS_CLIENTS", 64),
    allowedOrigins: parseAllowedOrigins(env["HUB_ALLOWED_ORIGINS"]),
    maxHosts: posInt(env, "HUB_MAX_HOSTS", 32),
    maxOpenSessionsPerHost: posInt(env, "HUB_MAX_OPEN_SESSIONS", 1000),
    dbPath: env["HUB_DB_PATH"] ?? path.join(".", "data", "hub.sqlite"),
    port,
    bind: env["HUB_BIND"] ?? "127.0.0.1",
  };
}
