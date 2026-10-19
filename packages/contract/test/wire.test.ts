import { describe, expect, it } from "vitest";
import { IngestRequestSchema, IngestResponseSchema, STREAM_HEARTBEAT_MS } from "../src/wire";
import { makeEnvelope } from "./helpers";

describe("IngestRequestSchema", () => {
  it("accepts a host with envelopes", () => {
    const parsed = IngestRequestSchema.parse({
      host: "h",
      envelopes: [makeEnvelope(), makeEnvelope({ seq: 2 })],
    });
    expect(parsed.envelopes).toHaveLength(2);
  });

  it("accepts an empty envelope list", () => {
    expect(IngestRequestSchema.safeParse({ host: "h", envelopes: [] }).success).toBe(true);
  });

  it("rejects a missing host and an invalid envelope", () => {
    expect(IngestRequestSchema.safeParse({ envelopes: [] }).success).toBe(false);
    expect(IngestRequestSchema.safeParse({ host: "h", envelopes: [{}] }).success).toBe(false);
  });
});

describe("IngestResponseSchema", () => {
  it("accepts accepted and last_seq, rejects negatives", () => {
    expect(IngestResponseSchema.parse({ accepted: 3, last_seq: 9 })).toEqual({
      accepted: 3,
      last_seq: 9,
    });
    expect(IngestResponseSchema.safeParse({ accepted: -1, last_seq: 0 }).success).toBe(false);
  });
});

describe("stream constants", () => {
  it("heartbeat is 25 seconds", () => {
    expect(STREAM_HEARTBEAT_MS).toBe(25_000);
  });
});
