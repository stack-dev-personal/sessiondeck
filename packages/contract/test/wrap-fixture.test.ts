/* Review iteration 2 (R0.1): wrapFixture copies the payload agent_id onto the envelope. SYNTHETIC. */
import { describe, expect, it } from "vitest";
import { wrapFixture } from "./helpers";

const fx = (payload: unknown) => ({ dir: "PreToolUse", file: "x.json", payload });

describe("wrapFixture agent_id", () => {
  it("copies a string payload agent_id onto the envelope, as the probe does", () => {
    const e = wrapFixture(fx({ session_id: "s", hook_event_name: "PreToolUse", agent_id: "a1" }));
    expect(e.agent_id).toBe("a1");
  });

  it("leaves the key out when the payload has none or a non-string one", () => {
    expect("agent_id" in wrapFixture(fx({ session_id: "s" }))).toBe(false);
    expect("agent_id" in wrapFixture(fx({ session_id: "s", agent_id: 3 }))).toBe(false);
    expect("agent_id" in wrapFixture(fx(null))).toBe(false);
  });
});
