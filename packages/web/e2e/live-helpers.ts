import { readFileSync } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
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

/** Directory inside this container that scripts/e2e-live.sh checks with `docker exec`; no shared mount, no Docker socket. */
export const HUB_RESTART_DIR = process.env["SD_E2E_RESTART_DIR"] ?? "";

/**
 * Restarts the hub process (container restart, same data volume). The Playwright container has no
 * Docker access: this creates restart.req in HUB_RESTART_DIR and waits for restart.ack, which the host-side
 * poller in scripts/e2e-live.sh creates (via docker exec) after `docker restart` of the hub container, then waits for
 * /health.
 */
export async function restartHub(): Promise<void> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const req = `${HUB_RESTART_DIR}/restart.req`;
  const ack = `${HUB_RESTART_DIR}/restart.ack`;
  await rm(ack, { force: true });
  await writeFile(req, id);
  const ackDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      await access(ack);
      break;
    } catch {
      /* not yet */
    }
    if (Date.now() > ackDeadline)
      throw new Error("host did not acknowledge the hub restart in 60 s");
    await new Promise((r) => setTimeout(r, 200));
  }
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
