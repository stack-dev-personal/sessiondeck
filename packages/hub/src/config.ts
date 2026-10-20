import path from "node:path";

export interface HubConfig {
  token: string;
  dbPath: string;
  port: number;
  bind: string;
}

export const MIN_TOKEN_LENGTH = 16;

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
  return {
    token,
    dbPath: env["HUB_DB_PATH"] ?? path.join(".", "data", "hub.sqlite"),
    port,
    bind: env["HUB_BIND"] ?? "127.0.0.1",
  };
}
