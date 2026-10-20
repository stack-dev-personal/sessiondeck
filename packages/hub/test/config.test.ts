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

describe("loadConfig bucket sizes and WS settings", () => {
  const base = { HUB_TOKEN: "a".repeat(16) };
  it("refuses burst sizes below the max batch size", () => {
    expect(() => loadConfig({ ...base, HUB_INGEST_BURST: "4999" })).toThrow(/HUB_INGEST_BURST/);
    expect(() => loadConfig({ ...base, HUB_HOST_BURST: "10" })).toThrow(/HUB_HOST_BURST/);
    expect(loadConfig({ ...base, HUB_INGEST_BURST: "5000" }).ingestBurst).toBe(5000);
  });
  it("defaults and parses WS settings", () => {
    const d = loadConfig(base);
    expect([d.maxWsClients, d.allowedOrigins]).toEqual([64, []]);
    expect([d.readRate, d.readBurst]).toEqual([50, 100]);
    const c = loadConfig({
      ...base,
      HUB_MAX_WS_CLIENTS: "3",
      HUB_ALLOWED_ORIGINS: "https://a.example, https://b.example,",
    });
    expect([c.maxWsClients, c.allowedOrigins]).toEqual([
      3,
      ["https://a.example", "https://b.example"],
    ]);
  });
});

describe("loadConfig retention", () => {
  const base = { HUB_TOKEN: "a".repeat(16) };
  it("defaults to 30 days, hourly, and parses overrides", () => {
    const d = loadConfig(base);
    expect([d.eventRetentionDays, d.sampleRetentionDays, d.retentionIntervalMs]).toEqual([
      30, 30, 3_600_000,
    ]);
    const c = loadConfig({
      ...base,
      HUB_EVENT_RETENTION_DAYS: "7",
      HUB_SAMPLE_RETENTION_DAYS: "14",
      HUB_RETENTION_INTERVAL_MS: "0",
    });
    expect([c.eventRetentionDays, c.sampleRetentionDays, c.retentionIntervalMs]).toEqual([
      7, 14, 0,
    ]);
  });
  it("rejects bad values", () => {
    expect(() => loadConfig({ ...base, HUB_EVENT_RETENTION_DAYS: "0" })).toThrow(
      /HUB_EVENT_RETENTION_DAYS/,
    );
    expect(() => loadConfig({ ...base, HUB_SAMPLE_RETENTION_DAYS: "x" })).toThrow(
      /HUB_SAMPLE_RETENTION_DAYS/,
    );
    expect(() => loadConfig({ ...base, HUB_RETENTION_INTERVAL_MS: "-1" })).toThrow(
      /HUB_RETENTION_INTERVAL_MS/,
    );
  });
});
