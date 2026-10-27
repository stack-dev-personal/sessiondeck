/*
 * Fixture layout (enforced by test/fixtures-layout.test.ts):
 *   fixtures/raw/<Event>/*.json     captured raw payloads. Gitignored. Never loaded by tests.
 *   fixtures/<Event>/*.json         scrubbed, committed fixtures. <Event> is the hook_event_name
 *                                   for hook events, plus statusLine/ and subagentStatusLine/.
 *   fixtures/settings/              settings-merge test inputs. Not a payload directory.
 *   fixtures/sessions/              golden session (.jsonl). Not a payload directory.
 *   fixtures/synthetic/<Event>/     hand-written payloads for uncaptured events. Not loaded by loadFixtures().
 *   fixtures/transcripts/<NN-slug>/ scrubbed session transcripts (.jsonl, README.md). Not a payload directory.
 * A .json directly in fixtures/, or nested deeper than fixtures/<Event>/, is a layout error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, EventKind } from "../src/envelope";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");
const EXCLUDED_DIRS = new Set(["raw", "settings", "sessions", "synthetic", "transcripts"]);

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

/** Relative paths of .json files under root that loadFixtures() would never pick up. */
export function findMisplacedFixtures(root: string = FIXTURES_DIR): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const entryPath = join(root, entry);
    if (!statSync(entryPath).isDirectory()) {
      if (entry.endsWith(".json")) out.push(entry);
      continue;
    }
    if (EXCLUDED_DIRS.has(entry)) continue;
    for (const nested of readdirSync(entryPath)) {
      const nestedPath = join(entryPath, nested);
      if (statSync(nestedPath).isDirectory()) {
        out.push(...listJsonRecursive(nestedPath).map((p) => `${entry}/${nested}/${p}`));
      }
    }
  }
  return out;
}

function listJsonRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...listJsonRecursive(p).map((c) => `${name}/${c}`));
    } else if (name.endsWith(".json")) {
      out.push(name);
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

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Wraps a fixture as a probe would: session_id, hook_event_name and agent_id come from the payload itself. */
export function wrapFixture(fx: LoadedFixture): Envelope {
  const kind = kindForFixtureDir(fx.dir);
  const hookName = stringField(fx.payload, "hook_event_name");
  const agentId = stringField(fx.payload, "agent_id");
  return {
    v: 1,
    id: TEST_ULID,
    kind,
    host: "test-host",
    os: "win32",
    session_id: stringField(fx.payload, "session_id"),
    ...(kind === "hook" && hookName !== null ? { hook_event_name: hookName } : {}),
    ...(agentId !== null ? { agent_id: agentId } : {}),
    ts: 0,
    seq: 0,
    payload: fx.payload,
  };
}

/** Hand-written payloads for uncaptured events: fixtures/synthetic/<Event>/*.json. Never part of loadFixtures(). */
export function loadSyntheticFixtures(root: string = FIXTURES_DIR): LoadedFixture[] {
  return loadFixtures(join(root, "synthetic"));
}

/** The golden session: one bare hook payload per line, in capture order. Dir is the payload's event name. */
export function loadGoldenSession(root: string = FIXTURES_DIR): LoadedFixture[] {
  const path = join(root, "sessions", "golden-session.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line, i) => {
      const payload: unknown = JSON.parse(line);
      return {
        dir: stringField(payload, "hook_event_name") ?? "unknown",
        file: `line-${i + 1}`,
        payload,
      };
    });
}
