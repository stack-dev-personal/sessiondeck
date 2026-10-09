import { describe, expect, it } from "vitest";

describe("scripts smoke", () => {
  it("runs under the workspace test runner", () => {
    expect(1 + 1).toBe(2);
  });
});
