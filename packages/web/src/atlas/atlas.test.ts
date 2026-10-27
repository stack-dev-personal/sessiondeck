// @vitest-environment node
import { createSnapshot } from "@sessiondeck/contract";
import { describe, expect, it, vi } from "vitest";
import { AtlasError, createHttpAtlasApi, restBase } from "./api";
import { cssColor, isValidColor } from "./color";
import { formatCount, formatHours, formatTotalCost } from "./format";
import { mergeLive } from "./live";
import { carryAtlas, type AtlasSession } from "./types";

const snap = (id: string, over: Partial<AtlasSession> = {}): AtlasSession => ({
  ...createSnapshot({ session_id: id, host: "h", cwd: "/p", ts: 1 }),
  ...over,
});

describe("color allow-list", () => {
  it("maps token names to var() and passes only valid #rrggbb", () => {
    expect(cssColor("state-working")).toBe("var(--state-working)");
    expect(cssColor("#3e63DD")).toBe("#3e63DD");
    for (const bad of [
      "red",
      "#fff",
      "#12345g",
      "url(x)",
      "var(--x)",
      "#3e63dd;color:red",
      "",
      null,
      undefined,
    ]) {
      expect(cssColor(bad as string | null)).toBeNull();
    }
    expect(isValidColor("accent-attention")).toBe(true);
    expect(isValidColor("#abcdef")).toBe(true);
    expect(isValidColor("expression(1)")).toBe(false);
  });
});

describe("totals formatting", () => {
  it("formats hours, cost and counts; n/a for unknown", () => {
    expect(formatHours(12.345)).toBe("12.3 h");
    expect(formatHours(0)).toBe("0.0 h");
    expect(formatHours(null)).toBe("n/a");
    expect(formatTotalCost(1.8)).toBe("$1.80");
    expect(formatTotalCost(1234.5)).toBe("$1,234.50");
    expect(formatTotalCost(undefined)).toBe("n/a");
    expect(formatTotalCost(Number.NaN)).toBe("n/a");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(null)).toBe("n/a");
  });
});

describe("carryAtlas", () => {
  const prev = snap("a", {
    project_id: "p_1",
    project_name: "one",
    project_color: "#3e63dd",
    phase: "P3",
    phase_source: "inferred",
  });
  it("keeps the delta as is when it carries the fields (even null)", () => {
    const delta = snap("a", {
      project_id: "p_2",
      project_name: "two",
      project_color: null,
      phase: null,
      phase_source: null,
    });
    expect(carryAtlas(delta, prev)).toBe(delta);
  });
  it("keeps the previous fields when the delta lacks them", () => {
    const out = carryAtlas(snap("a"), prev) as AtlasSession;
    expect(out.project_id).toBe("p_1");
    expect(out.phase).toBe("P3");
    expect(out.phase_source).toBe("inferred");
  });
  it("is a no-op without a previous snapshot", () => {
    const d = snap("a");
    expect(carryAtlas(d, undefined)).toBe(d);
  });
});

describe("mergeLive", () => {
  it("prefers the board copy, drops sessions that moved out, adds ones that moved in", () => {
    const api = [
      snap("a", { project_id: "p1", last_event_at: 5 }),
      snap("b", { project_id: "p1", last_event_at: 4 }),
    ];
    const board = {
      a: snap("a", { project_id: "p1", phase: "X", last_event_at: 9 }),
      b: snap("b", { project_id: "p2", last_event_at: 9 }),
      c: snap("c", { project_id: "p1", last_event_at: 1 }),
    };
    const out = mergeLive(api, board, "p1");
    expect(out.map((s) => s.session_id)).toEqual(["a", "c"]);
    expect(out[0]!.phase).toBe("X");
  });
});

describe("mergeLive grace", () => {
  it("drops long-ended and archived board additions, keeps recently ended", () => {
    const now = 10_000_000;
    const board = {
      old: snap("old", { project_id: "p1", state: "ended", state_since: now - 2 * 3_600_000 }),
      exited: snap("exited", {
        project_id: "p1",
        state: "exited",
        state_since: 0,
        last_event_at: 5,
      }),
      arch: snap("arch", { project_id: "p1", state: "archived" as AtlasSession["state"] }),
      recent: snap("recent", { project_id: "p1", state: "ended", state_since: now - 60_000 }),
      run: snap("run", { project_id: "p1", state: "working" }),
    };
    const out = mergeLive([], board, "p1", now);
    expect(out.map((s) => s.session_id).sort()).toEqual(["recent", "run"]);
  });
});

describe("http client", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  it("sends the bearer token and a JSON body, never the token in the URL", async () => {
    const f = vi.fn(async () =>
      ok({ session_id: "s1", phase: "Hardening", phase_source: "manual" }),
    );
    const api = createHttpAtlasApi({
      config: () => ({ hubUrl: "wss://hub.example.test:8787/", token: "tok" }),
      fetchImpl: f as unknown as typeof fetch,
    });
    const s = await api.setSessionPhase("s 1", "Hardening");
    expect(s.phase).toBe("Hardening");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example.test:8787/sessions/s%201/phase");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    expect(init.body).toBe('{"phase":"Hardening"}');
    expect(url).not.toContain("tok");
  });
  it("cuts the search query to the hub's 200 character limit", async () => {
    const f = vi.fn(async () => ok({ results: [], took_ms: 1 }));
    const api = createHttpAtlasApi({
      config: () => ({ hubUrl: "", token: "" }),
      fetchImpl: f as unknown as typeof fetch,
    });
    await api.search("x".repeat(300), { limit: 5 });
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe(`/search?q=${"x".repeat(200)}&limit=5`);
  });
  it("does not cut an emoji in half at the query limit", async () => {
    const f = vi.fn(async () => ok({ results: [], took_ms: 1 }));
    const api = createHttpAtlasApi({
      config: () => ({ hubUrl: "", token: "" }),
      fetchImpl: f as unknown as typeof fetch,
    });
    await api.search("a".repeat(199) + "😀", { limit: 5 });
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe(`/search?q=${"a".repeat(199)}&limit=5`);
  });
  it("uses the same origin for an empty hub URL and sends null to clear", async () => {
    const f = vi.fn(async () => ok({ session_id: "s1" }));
    const api = createHttpAtlasApi({
      config: () => ({ hubUrl: "", token: "" }),
      fetchImpl: f as unknown as typeof fetch,
    });
    await api.setSessionProject("s1", null);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/sessions/s1/project");
    expect(init.body).toBe('{"project_id":null}');
    expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });
  it("maps HTTP and network failures to AtlasError", async () => {
    const mk = (f: unknown) =>
      createHttpAtlasApi({
        config: () => ({ hubUrl: "", token: "t" }),
        fetchImpl: f as typeof fetch,
      });
    await expect(
      mk(async () => new Response("", { status: 401 })).listProjects(),
    ).rejects.toMatchObject({ status: 401, message: "Token rejected" });
    await expect(
      mk(async () => {
        throw new TypeError("x");
      }).listProjects(),
    ).rejects.toBeInstanceOf(AtlasError);
  });
  it("parses the project detail", async () => {
    const f = async () =>
      ok({
        project: {
          id: "p_1",
          project_dir: "/x/y",
          name: "y",
          color: "#3e63dd",
          vault_collection: null,
          sessions: 3,
          live: 1,
        },
        live: [{ session_id: "a" }],
        archived: [],
        totals: { sessions: 3, hours: 2.5, cost_usd: 4.2 },
        branches: [{ branch: "main", sessions: 1 }],
      });
    const d = await createHttpAtlasApi({
      config: () => ({ hubUrl: "", token: "" }),
      fetchImpl: f as unknown as typeof fetch,
    }).getProject("p_1");
    expect(d.totals).toEqual({ sessions: 3, hours: 2.5, cost_usd: 4.2 });
    expect(d.branches).toEqual([{ branch: "main", sessions: 1 }]);
    expect(restBase("ws://h:1")).toBe("http://h:1");
    expect(restBase("ftp://h")).toBe("");
  });
});
