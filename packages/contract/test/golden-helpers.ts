/**
 * Replay helpers for fixture-driven reducer tests. The payloads are committed, scrubbed captures
 * (or, for synthetic fixtures, hand-written ones); only the envelope around them is built here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../src/envelope";
import { isHookEnvelope } from "../src/envelope";
import { createSnapshot } from "../src/snapshot";
import type { SessionSnapshot } from "../src/snapshot";
import { reduce } from "../src/state";
import type { LoadedFixture } from "./helpers";
import { FIXTURES_DIR, wrapFixture } from "./helpers";

/** Epoch ms of the snapshot's creation; event i is delivered at BASE_TS + (i + 1) * STEP_MS. */
export const BASE_TS = 1_760_000_000_000;
export const STEP_MS = 1_000;

export function tsOfEvent(index: number): number {
  return BASE_TS + (index + 1) * STEP_MS;
}

/** The fixture as a hook envelope delivered at event number `index` (0-based). */
export function hookEnvelope(fx: LoadedFixture, index: number): Envelope<"hook"> {
  const env = { ...wrapFixture(fx), ts: tsOfEvent(index), seq: index };
  if (!isHookEnvelope(env)) throw new Error(`fixture ${fx.dir}/${fx.file} is not a hook payload`);
  return env;
}

/** A fresh snapshot for the session a fixture belongs to, created at BASE_TS. */
export function snapshotFor(fx: LoadedFixture, state?: SessionSnapshot["state"]): SessionSnapshot {
  const env = wrapFixture(fx);
  const cwd = (fx.payload as { cwd?: unknown }).cwd;
  const base = createSnapshot({
    session_id: env.session_id ?? "unknown",
    host: env.host,
    cwd: typeof cwd === "string" ? cwd : "",
    ts: BASE_TS,
  });
  return state === undefined ? base : { ...base, state };
}

/** Reduces the fixtures in order, delivering the first at event number `firstIndex`. */
export function replay(
  start: SessionSnapshot,
  fixtures: readonly LoadedFixture[],
  firstIndex = 0,
): SessionSnapshot {
  return fixtures.reduce((s, fx, i) => reduce(s, hookEnvelope(fx, firstIndex + i)), start);
}

/** One committed fixture by directory and file name; throws when it does not exist. */
export function fixtureAt(dir: string, file: string): LoadedFixture {
  const path = join(FIXTURES_DIR, dir, file);
  return {
    dir: dir.split("/").pop() ?? dir,
    file,
    payload: JSON.parse(readFileSync(path, "utf8")),
  };
}

/** A copy of a fixture with extra top-level payload fields (a derived variant, not a capture). */
export function withPayload(fx: LoadedFixture, extra: Record<string, unknown>): LoadedFixture {
  return { ...fx, payload: { ...(fx.payload as Record<string, unknown>), ...extra } };
}
