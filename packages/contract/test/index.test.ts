import { describe, expect, it } from "vitest";
import * as contract from "../src/index";

describe("index exports", () => {
  it("re-exports the public surface", () => {
    expect(contract.CONTRACT_PACKAGE).toBe("@sessiondeck/contract");
    for (const name of [
      "EnvelopeSchema",
      "parseEnvelope",
      "safeParseEnvelope",
      "isHookEnvelope",
      "SESSION_STATES",
      "createSnapshot",
      "IngestRequestSchema",
      "StatusLinePayloadSchema",
      "normalizeRateLimitWindow",
    ]) {
      expect(contract).toHaveProperty(name);
    }
  });
});
