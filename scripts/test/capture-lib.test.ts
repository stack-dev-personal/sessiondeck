import { describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import { isInside, safeEventName, safeSessionId, toPosix } from "../lib/capture-paths.mjs";
import { shouldRecordStatus, statusSignature } from "../lib/capture-throttle.mjs";

describe("HOOK_EVENTS", () => {
  it("lists the 17 events, frozen, without WorktreeCreate", () => {
    expect(HOOK_EVENTS).toHaveLength(17);
    expect(new Set(HOOK_EVENTS).size).toBe(17);
    expect(Object.isFrozen(HOOK_EVENTS)).toBe(true);
    expect(HOOK_EVENTS).not.toContain("WorktreeCreate");
    expect(HOOK_EVENTS).toContain("PermissionDenied");
  });
});

describe("path helpers", () => {
  it("accepts plain names and maps everything else to _unknown", () => {
    expect(safeEventName("PreToolUse")).toBe("PreToolUse");
    const bad: unknown[] = [
      "../../evil",
      "a/b",
      "a\\b",
      "C:\\x",
      "C:",
      "",
      " ",
      "x".repeat(65),
      "NUL",
      "con",
      "_unparsed",
      "a.b",
      42,
      null,
      undefined,
      {},
    ];
    for (const value of bad) expect(safeEventName(value)).toBe("_unknown");
  });

  it("shortens session ids and falls back", () => {
    expect(safeSessionId("abcdef0123456789")).toBe("abcdef01");
    expect(safeSessionId("../x")).toBe("nosession");
    expect(safeSessionId(undefined)).toBe("nosession");
  });

  it("isInside rejects the root itself and escapes", () => {
    expect(isInside("/tmp/out", "/tmp/out/a/b.json")).toBe(true);
    expect(isInside("/tmp/out", "/tmp/out")).toBe(false);
    expect(isInside("/tmp/out", "/tmp/out/../evil")).toBe(false);
    expect(isInside("/tmp/out", "/tmp/outside/x")).toBe(false);
  });

  it("toPosix turns backslashes into slashes", () => {
    expect(toPosix("C:\\a\\b")).toBe("C:/a/b");
  });
});

describe("status throttle", () => {
  const base = { model: {}, session_id: "s" };

  it("signature tracks top-level keys and rate_limits presence", () => {
    expect(statusSignature(base)).toBe(statusSignature({ session_id: "x", model: 1 }));
    expect(statusSignature(base)).not.toBe(statusSignature({ ...base, rate_limits: null }));
    expect(statusSignature({ ...base, rate_limits: null })).toBe(
      statusSignature({ ...base, rate_limits: { a: 1 } }),
    );
  });

  it("records the first sample, skips within the interval, records changes", () => {
    const sig = statusSignature(base);
    expect(shouldRecordStatus(undefined, sig, 1000, 500)).toBe(true);
    expect(shouldRecordStatus({ t: 1000, sig }, sig, 1200, 500)).toBe(false);
    expect(shouldRecordStatus({ t: 1000, sig }, sig, 1500, 500)).toBe(true);
    expect(shouldRecordStatus({ t: 1000, sig }, "other", 1001, 500)).toBe(true);
  });
});
