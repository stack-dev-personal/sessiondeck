import path from "node:path";

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
  /** Concurrent WS /stream clients; further upgrades get 503. */
  maxWsClients: number;
  /** HUB_ALLOWED_ORIGINS; when non-empty, an upgrade with any other Origin is refused (403). */
  allowedOrigins: string[];
  /** New sessions for a host are not created once it has this many open (non-ended) sessions. */
  maxOpenSessionsPerHost: number;
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
  return {
    token,
    ingestRate,
    ingestBurst,
    hostRate,
    hostBurst,
    maxWsClients: posInt(env, "HUB_MAX_WS_CLIENTS", 64),
    allowedOrigins: (env["HUB_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
    maxHosts: posInt(env, "HUB_MAX_HOSTS", 32),
    maxOpenSessionsPerHost: posInt(env, "HUB_MAX_OPEN_SESSIONS", 1000),
    dbPath: env["HUB_DB_PATH"] ?? path.join(".", "data", "hub.sqlite"),
    port,
    bind: env["HUB_BIND"] ?? "127.0.0.1",
  };
}
