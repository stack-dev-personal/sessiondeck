import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  window.localStorage.clear();
});

describe("useFilters", () => {
  it("persists to localStorage and restores on load", async () => {
    let m = await import("./filters");
    m.useFilters.getState().setHost("h2");
    m.useFilters.getState().setProject("alpha");
    expect(JSON.parse(window.localStorage.getItem("sd.filters")!)).toEqual({
      host: "h2",
      project: "alpha",
    });
    vi.resetModules();
    m = await import("./filters");
    expect(m.useFilters.getState()).toMatchObject({ host: "h2", project: "alpha" });
    m.useFilters.getState().clear();
    expect(m.loadFilters()).toEqual({ host: null, project: null });
  });

  it("ignores corrupt storage and survives a throwing localStorage", async () => {
    window.localStorage.setItem("sd.filters", "{nope");
    let m = await import("./filters");
    expect(m.useFilters.getState()).toMatchObject({ host: null, project: null });
    vi.resetModules();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    m = await import("./filters");
    expect(() => m.useFilters.getState().setHost("x")).not.toThrow();
    expect(m.useFilters.getState().host).toBe("x");
  });
});
