import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("throws without HUB_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(/HUB_TOKEN/);
  });
  it("throws on a short token and does not echo it", () => {
    expect(() => loadConfig({ HUB_TOKEN: "short-secret" })).toThrow(/HUB_TOKEN/);
    try {
      loadConfig({ HUB_TOKEN: "short-secret" });
    } catch (e) {
      expect(String(e)).not.toContain("short-secret");
    }
  });
  it("applies defaults", () => {
    const c = loadConfig({ HUB_TOKEN: "a".repeat(16) });
    expect(c.port).toBe(8787);
    expect(c.bind).toBe("127.0.0.1");
    expect(c.dbPath).toMatch(/hub\.sqlite$/);
  });
  it("honors overrides and rejects bad ports", () => {
    const c = loadConfig({
      HUB_TOKEN: "a".repeat(16),
      HUB_PORT: "9000",
      HUB_BIND: "0.0.0.0",
      HUB_DB_PATH: "x.db",
    });
    expect([c.port, c.bind, c.dbPath]).toEqual([9000, "0.0.0.0", "x.db"]);
    expect(() => loadConfig({ HUB_TOKEN: "a".repeat(16), HUB_PORT: "abc" })).toThrow(/HUB_PORT/);
  });
  it("treats empty HUB_PORT as unset and rejects 0, negatives, decimals, overflow", () => {
    const t = "a".repeat(16);
    expect(loadConfig({ HUB_TOKEN: t, HUB_PORT: "" }).port).toBe(8787);
    for (const p of ["0", "-1", "1.5", "65536", " 80", "1e3", "0x10"]) {
      expect(() => loadConfig({ HUB_TOKEN: t, HUB_PORT: p }), p).toThrow(/HUB_PORT/);
    }
    expect(loadConfig({ HUB_TOKEN: t, HUB_PORT: "65535" }).port).toBe(65535);
  });
});
