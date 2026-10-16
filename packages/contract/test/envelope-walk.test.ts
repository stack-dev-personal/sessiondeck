/* R0.1: every committed fixture, wrapped as a probe would, passes EnvelopeSchema. Reported per category. */
import { describe, expect, it } from "vitest";
import { safeParseEnvelope } from "../src/envelope";
import {
  kindForFixtureDir,
  loadFixtures,
  loadGoldenSession,
  loadSyntheticFixtures,
  wrapFixture,
  type LoadedFixture,
} from "./helpers";

const captured = loadFixtures();
const categories: Record<string, LoadedFixture[]> = {
  "captured hook events": captured.filter((f) => kindForFixtureDir(f.dir) === "hook"),
  statusLine: captured.filter((f) => f.dir === "statusLine"),
  subagentStatusLine: captured.filter((f) => f.dir === "subagentStatusLine"),
  "golden session": loadGoldenSession(),
  "synthetic (not captured)": loadSyntheticFixtures(),
};

describe("envelope walk: the fixture set is not empty", () => {
  it.each(Object.entries(categories))("category %s has fixtures", (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
  });

  it("walks hooks (>= 50), statusLine (>= 20), subagentStatusLine (>= 5), golden session, synthetic", () => {
    expect(categories["captured hook events"]?.length).toBeGreaterThanOrEqual(50);
    expect(categories["statusLine"]?.length).toBeGreaterThanOrEqual(20);
    expect(categories["subagentStatusLine"]?.length).toBeGreaterThanOrEqual(5);
    expect(categories["golden session"]?.length).toBeGreaterThan(1);
    expect(categories["synthetic (not captured)"]?.length).toBeGreaterThanOrEqual(5);
  });
});

describe.each(Object.entries(categories))("envelope walk: %s", (_category, list) => {
  it.each(list.map((f) => [`${f.dir}/${f.file}`, f] as const))("%s parses", (_name, fx) => {
    const parsed = safeParseEnvelope(wrapFixture(fx));
    expect(parsed.success).toBe(true);
    if (kindForFixtureDir(fx.dir) === "hook") {
      expect((fx.payload as Record<string, unknown>)["hook_event_name"]).toBe(fx.dir);
    }
    if (parsed.success) {
      expect(parsed.data.payload).toEqual(fx.payload);
    }
  });

  it("rejects each of v, id, host, kind, ts, seq when removed from a wrapped fixture", () => {
    const first = list[0];
    expect(first).toBeDefined();
    for (const field of ["v", "id", "host", "kind", "ts", "seq"]) {
      const wrapped: Record<string, unknown> = { ...wrapFixture(first as LoadedFixture) };
      delete wrapped[field];
      expect(safeParseEnvelope(wrapped).success, field).toBe(false);
    }
  });
});
