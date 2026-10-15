import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES_DIR, findMisplacedFixtures, loadFixtures } from "./helpers";

// R0.7 acceptance counts over the committed, scrubbed set. Needs no raw/ directory, so it runs in CI.
const MIN_HOOK_FIXTURES = 50;
const MIN_HOOK_EVENTS = 12;
const MIN_STATUSLINE = 20;
const MIN_SUBAGENT_STATUSLINE = 5;
const NON_HOOK_DIRS = new Set(["statusLine", "subagentStatusLine"]);

const all = loadFixtures();
const hooks = all.filter((f) => !NON_HOOK_DIRS.has(f.dir));
const statusLines = all.filter((f) => f.dir === "statusLine");

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

describe("R0.7 fixture counts (committed set)", () => {
  it(`has at least ${MIN_HOOK_FIXTURES} captured hook fixtures`, () => {
    expect(hooks.length).toBeGreaterThanOrEqual(MIN_HOOK_FIXTURES);
  });

  it(`covers at least ${MIN_HOOK_EVENTS} distinct hook events, and each file names its directory's event`, () => {
    const events = new Set(hooks.map((f) => f.dir));
    expect(events.size).toBeGreaterThanOrEqual(MIN_HOOK_EVENTS);
    const mismatched = hooks.filter((f) => field(f.payload, "hook_event_name") !== f.dir);
    expect(mismatched.map((f) => `${f.dir}/${f.file}`)).toEqual([]);
  });

  it("counts captured fixtures only: synthetic/ is excluded", () => {
    expect(all.some((f) => f.dir === "synthetic")).toBe(false);
  });

  it(`has at least ${MIN_STATUSLINE} statusLine samples, with and without rate_limits`, () => {
    expect(statusLines.length).toBeGreaterThanOrEqual(MIN_STATUSLINE);
    const withLimits = statusLines.filter((f) => field(f.payload, "rate_limits") != null);
    expect(withLimits.length).toBeGreaterThanOrEqual(1);
    expect(statusLines.length - withLimits.length).toBeGreaterThanOrEqual(1);
  });

  it(`has at least ${MIN_SUBAGENT_STATUSLINE} subagentStatusLine samples`, () => {
    const n = all.filter((f) => f.dir === "subagentStatusLine").length;
    expect(n).toBeGreaterThanOrEqual(MIN_SUBAGENT_STATUSLINE);
  });

  it("has the golden session: one session_id, starting at SessionStart", () => {
    const lines = readFileSync(join(FIXTURES_DIR, "sessions", "golden-session.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const events = lines.map((l) => JSON.parse(l) as unknown);
    expect(events.length).toBeGreaterThan(1);
    expect(new Set(events.map((e) => field(e, "session_id"))).size).toBe(1);
    expect(field(events[0], "hook_event_name")).toBe("SessionStart");
  });
});

describe("layout guard ignores generated directories", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it("does not flag or load synthetic/<Event>/ and sessions/ files", () => {
    const root = mkdtempSync(join(tmpdir(), "sd-fixtures-counts-"));
    roots.push(root);
    for (const rel of ["synthetic/StopFailure/01.json", "sessions/g.json", "Stop/a.json"]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "{}");
    }
    expect(findMisplacedFixtures(root)).toEqual([]);
    expect(loadFixtures(root).map((f) => f.dir)).toEqual(["Stop"]);
  });
});
