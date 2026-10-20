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
) {
  return {
    v: 1,
    id: ulid(),
    kind: "hook",
    host: HOST,
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

export async function ingest(envelopes: unknown[]): Promise<void> {
  const res = await fetch(`${LIVE.directUrl}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LIVE.token}` },
    body: JSON.stringify({ host: HOST, envelopes }),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
}

export const newSessionId = (): string => crypto.randomUUID();

/** Stores hub URL and token the way Settings does, before any page script runs. */
export async function configureHub(page: Page): Promise<void> {
  await page.addInitScript(
    (s) => {
      try {
        window.localStorage.setItem("sd.settings", JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
    { hubUrl: LIVE.hubUrl, token: LIVE.token, notifications: false },
  );
}

export async function waitConnected(page: Page): Promise<void> {
  await expect(page.getByTestId("connection")).toHaveText("● connected", { timeout: 15_000 });
}

export const card = (page: Page, id: string) =>
  page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);
