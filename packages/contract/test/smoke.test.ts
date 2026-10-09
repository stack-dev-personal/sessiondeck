import { describe, expect, it } from "vitest";
import { CONTRACT_PACKAGE } from "../src/index";

describe("contract smoke", () => {
  it("exports the package marker", () => {
    expect(CONTRACT_PACKAGE).toBe("@sessiondeck/contract");
  });
});
