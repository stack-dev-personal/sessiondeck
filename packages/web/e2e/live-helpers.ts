import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

/**
 * Live specs (R3.1, R3.9) need a real hub. They run only when SD_E2E_HUB_URL is set; see
 * playwright.config.ts for the variables and packages/web/scripts/e2e-live.sh for the harness.
 */
export const LIVE = {
  /** What the browser connects to (hub or the ws-gate in front of it). */
  hubUrl: process.env["SD_E2E_HUB_URL"] ?? "",
  /** Where the test process POSTs /ingest; always the hub itself, never the gate. */
  directUrl: process.env["SD_E2E_HUB_DIRECT_URL"] ?? process.env["SD_E2E_HUB_URL"] ?? "",
  token: process.env["SD_E2E_HUB_TOKEN"] ?? "",
  /** ws-gate control endpoint (R3.9 only). */
  gateUrl: process.env["SD_E2E_GATE_URL"] ?? "",
};

const fixtureDir = fileURLToPath(new URL("../../contract/fixtures/", import.meta.url));
export const fixture = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${fixtureDir}${rel}`, "utf8")) as Record<string, unknown>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(): string {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)]!;
  return time + rand;
}

let seq = 0;
export const HOST = `e2e-${Math.random().toString(36).slice(2, 8)}`;

export function hookEnvelope(
  sessionId: string,
  name: string,
  fixtureRel: string,
  extra: Record<string, unknown> = {},
  host: string = HOST,
) {
  return {
    v: 1,
    id: ulid(),
    kind: "hook",
    host,
    os: "linux",
    session_id: sessionId,
    hook_event_name: name,
    ts: Date.now(),
    seq: ++seq,
    payload: { ...fixture(fixtureRel), session_id: sessionId, hook_event_name: name, ...extra },
  };
}

export const startEnv = (id: string) =>
  hookEnvelope(id, "SessionStart", "SessionStart/01-startup.json");
export const promptEnv = (id: string) =>
  hookEnvelope(id, "UserPromptSubmit", "UserPromptSubmit/01-sample.json");
export const stopEnv = (id: string) => hookEnvelope(id, "Stop", "Stop/02-sample.json");
export const endEnv = (id: string) => hookEnvelope(id, "SessionEnd", "SessionEnd/01-other.json");

export async function ingest(envelopes: unknown[], host: string = HOST): Promise<void> {
  const res = await fetch(`${LIVE.directUrl}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LIVE.token}` },
    body: JSON.stringify({ host, envelopes }),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
}

export const newSessionId = (): string => crypto.randomUUID();

/** Stores hub URL and token the way Settings does, before any page script runs. */
export async function configureHub(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    (s) => {
      try {
        window.localStorage.setItem("sd.settings", JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
    { hubUrl: LIVE.hubUrl, token: LIVE.token, notifications: false, ...overrides },
  );
}

export async function waitConnected(page: Page): Promise<void> {
  await expect(page.getByTestId("connection")).toHaveText("● connected", { timeout: 15_000 });
}

export const card = (page: Page, id: string) =>
  page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);

/**
 * The hub sends no CORS headers (the web app is normally served from the hub's origin or behind
 * one proxy). The live e2e serves the app from another origin than the hub, so REST calls from the
 * page are forwarded through Playwright, which is not subject to CORS, with CORS headers added.
 * WebSocket traffic is not touched.
 */
export async function allowHubCors(page: Page): Promise<void> {
  const hubOrigin = new URL(LIVE.hubUrl).origin;
  await page.route(
    (url) => url.origin === hubOrigin,
    async (route) => {
      const req = route.request();
      const cors = {
        "access-control-allow-origin": req.headers()["origin"] ?? "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, PATCH, POST, OPTIONS",
        "access-control-max-age": "60",
      };
      if (req.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
    },
  );
}

/** Name of the hub container, set by scripts/e2e-live.sh together with the docker socket mount. */
export const HUB_CONTAINER = process.env["SD_E2E_HUB_CONTAINER"] ?? "";
const DOCKER_SOCK = process.env["SD_E2E_DOCKER_SOCK"] ?? "/var/run/docker.sock";

/** Restarts the hub process (container restart, same data volume) through the Docker Engine API. */
export async function restartHub(): Promise<void> {
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        socketPath: DOCKER_SOCK,
        method: "POST",
        path: `/containers/${encodeURIComponent(HUB_CONTAINER)}/restart?t=2`,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
  if (status !== 204) throw new Error(`hub restart failed: HTTP ${status}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${LIVE.directUrl}/health`)).ok) return;
    } catch {
      /* still down */
    }
    if (Date.now() > deadline) throw new Error("hub did not come back within 30 s");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Authenticated GET against the hub itself (not through the gate). */
export async function hubJson<T>(path: string): Promise<T> {
  const res = await fetch(`${LIVE.directUrl}${path}`, {
    headers: { authorization: `Bearer ${LIVE.token}` },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return (await res.json()) as T;
}
