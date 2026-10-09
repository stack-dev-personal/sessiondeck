import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, EventKind } from "../src/envelope";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");
const EXCLUDED_DIRS = new Set(["raw", "settings"]);

/** Test-only ULID-shaped id. */
export const TEST_ULID = "01HZX3K9QJ5V8M2N4P6R7S8T9W";

export interface LoadedFixture {
  dir: string;
  file: string;
  payload: unknown;
}

/** Lists every JSON file under fixtures/<event>/ except raw/ and settings/. Empty when none exist. */
export function loadFixtures(root: string = FIXTURES_DIR): LoadedFixture[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: LoadedFixture[] = [];
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    if (EXCLUDED_DIRS.has(dir) || !statSync(dirPath).isDirectory()) {
      continue;
    }
    for (const file of readdirSync(dirPath)) {
      if (file.endsWith(".json")) {
        out.push({ dir, file, payload: JSON.parse(readFileSync(join(dirPath, file), "utf8")) });
      }
    }
  }
  return out;
}

/** Which envelope kind a fixture directory maps to. */
export function kindForFixtureDir(dir: string): EventKind {
  if (dir === "statusLine") return "statusline";
  if (dir === "subagentStatusLine") return "subagents";
  return "hook";
}

export function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: TEST_ULID,
    kind: "hook",
    host: "test-host",
    os: "win32",
    session_id: "sess-1",
    hook_event_name: "Stop",
    ts: 1_760_000_000_000,
    seq: 1,
    payload: { any: "thing" },
    ...overrides,
  };
}

export function wrapFixture(fx: LoadedFixture): Envelope {
  const kind = kindForFixtureDir(fx.dir);
  return {
    v: 1,
    id: TEST_ULID,
    kind,
    host: "test-host",
    os: "win32",
    session_id: "fixture-session",
    ...(kind === "hook" ? { hook_event_name: fx.dir } : {}),
    ts: 0,
    seq: 0,
    payload: fx.payload,
  };
}
