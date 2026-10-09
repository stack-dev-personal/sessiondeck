import { describe, expect, it } from "vitest";
import {
  EVENT_KINDS,
  isHookEnvelope,
  parseEnvelope,
  safeParseEnvelope,
  type Envelope,
} from "../src/envelope";
import { loadFixtures, makeEnvelope, wrapFixture } from "./helpers";

describe("EnvelopeSchema", () => {
  it.each(EVENT_KINDS)("accepts a valid envelope of kind %s", (kind) => {
    const input = makeEnvelope({
      kind,
      session_id: kind === "probe" ? null : "sess-1",
      hook_event_name: kind === "hook" ? "Stop" : undefined,
    });
    expect(safeParseEnvelope(input).success).toBe(true);
  });

  it.each(["v", "id", "host", "kind", "ts", "seq"])("rejects a missing %s", (field) => {
    const input = makeEnvelope();
    delete input[field];
    expect(safeParseEnvelope(input).success).toBe(false);
  });

  it("rejects a missing payload key but accepts payload null", () => {
    const missing = makeEnvelope();
    delete missing["payload"];
    expect(safeParseEnvelope(missing).success).toBe(false);
    const parsed = parseEnvelope(makeEnvelope({ payload: null }));
    expect(parsed.payload).toBeNull();
    expect("payload" in parsed).toBe(true);
  });

  it("rejects wrong v, bad ULID, empty host, unknown os, negative or fractional ts/seq", () => {
    expect(safeParseEnvelope(makeEnvelope({ v: 2 })).success).toBe(false);
    expect(safeParseEnvelope(makeEnvelope({ id: "not-a-ulid" })).success).toBe(false);
    expect(safeParseEnvelope(makeEnvelope({ id: "01HZX3K9QJ5V8M2N4P6R7S8T9U" })).success).toBe(
      false,
    );
    expect(safeParseEnvelope(makeEnvelope({ host: "" })).success).toBe(false);
    expect(safeParseEnvelope(makeEnvelope({ os: "freebsd" })).success).toBe(false);
    expect(safeParseEnvelope(makeEnvelope({ ts: -1 })).success).toBe(false);
    expect(safeParseEnvelope(makeEnvelope({ seq: 1.5 })).success).toBe(false);
  });

  it("allows null session_id only for kind probe", () => {
    expect(safeParseEnvelope(makeEnvelope({ kind: "liveness", session_id: null })).success).toBe(
      false,
    );
    expect(safeParseEnvelope(makeEnvelope({ kind: "hook", session_id: null })).success).toBe(false);
    expect(
      safeParseEnvelope(
        makeEnvelope({ kind: "probe", session_id: null, hook_event_name: undefined }),
      ).success,
    ).toBe(true);
  });

  it("requires hook_event_name for kind hook", () => {
    expect(safeParseEnvelope(makeEnvelope({ hook_event_name: undefined })).success).toBe(false);
    expect(safeParseEnvelope(makeEnvelope({ hook_event_name: "" })).success).toBe(false);
  });

  it("accepts optional agent_id", () => {
    expect(parseEnvelope(makeEnvelope({ agent_id: "agent-7" })).agent_id).toBe("agent-7");
  });

  it("passes the payload through untouched, including unknown nested keys", () => {
    const payload = { a: 1, nested: { unknown_key: [1, { deep: true }], n: null }, extra: "x" };
    const snapshot = structuredClone(payload);
    const parsed = parseEnvelope(makeEnvelope({ payload }));
    expect(parsed.payload).toBe(payload);
    expect(parsed.payload).toEqual(snapshot);
  });

  it("parseEnvelope throws on invalid input", () => {
    expect(() => parseEnvelope({})).toThrow();
  });
});

describe("isHookEnvelope", () => {
  it("narrows hook envelopes with a hook_event_name", () => {
    const hook = parseEnvelope(makeEnvelope());
    expect(isHookEnvelope(hook)).toBe(true);
  });

  it("is false for other kinds and for hooks lacking a name", () => {
    const status = parseEnvelope(makeEnvelope({ kind: "statusline", hook_event_name: undefined }));
    expect(isHookEnvelope(status)).toBe(false);
    const nameless: Envelope = { ...parseEnvelope(makeEnvelope()), hook_event_name: undefined };
    expect(isHookEnvelope(nameless)).toBe(false);
  });
});

const fixtures = loadFixtures();

// TODO(fixture): captured fixtures arrive in S0b; this block un-skips itself when they exist.
if (fixtures.length === 0)
  it.skip("TODO(fixture): no captured fixtures yet; envelope walk not exercised", () => {});
describe.skipIf(fixtures.length === 0)("captured fixtures wrapped in an envelope", () => {
  it.each(fixtures.map((f) => [`${f.dir}/${f.file}`, f] as const))("%s parses", (_name, fx) => {
    const parsed = safeParseEnvelope(wrapFixture(fx));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload).toEqual(fx.payload);
    }
  });
});
