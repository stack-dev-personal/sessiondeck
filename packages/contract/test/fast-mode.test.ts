import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSnapshot, readFastMode } from "../src/snapshot";
import { StatusLinePayloadSchema } from "../src/statusline";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "statusLine", "04-mid.json"), "utf8"),
) as Record<string, unknown>;

describe("statusLine fast_mode", () => {
  it("a fixture statusLine yields false", () => {
    expect(StatusLinePayloadSchema.parse(fixture).fast_mode).toBe(false);
  });
  it("true yields true", () => {
    expect(StatusLinePayloadSchema.parse({ ...fixture, fast_mode: true }).fast_mode).toBe(true);
  });
  it("absent stays undefined so the apply path keeps the previous value", () => {
    const rest = { ...fixture };
    delete rest["fast_mode"];
    expect(StatusLinePayloadSchema.parse(rest).fast_mode).toBeUndefined();
  });
  it("a non-boolean yields null without rejecting the payload", () => {
    const r = StatusLinePayloadSchema.safeParse({ ...fixture, fast_mode: "yes" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.fast_mode).toBeNull();
  });
});

describe("snapshot fast_mode", () => {
  it("defaults to null", () => {
    expect(createSnapshot({ session_id: "s", host: "h", cwd: "/", ts: 1 }).fast_mode).toBeNull();
  });
  it("readFastMode: booleans stay, a row stored without it or with junk reads null", () => {
    expect(readFastMode(true)).toBe(true);
    expect(readFastMode(false)).toBe(false);
    const old: Record<string, unknown> = {
      ...createSnapshot({ session_id: "s", host: "h", cwd: "/", ts: 1 }),
    };
    delete old["fast_mode"];
    expect(readFastMode(old["fast_mode"])).toBeNull();
    expect(readFastMode("true")).toBeNull();
  });
});
