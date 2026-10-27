import { useUi } from "../store/ui";
import type {
  AtlasSession,
  BranchCount,
  PhaseCount,
  ProjectDetail,
  ProjectSummary,
  SearchKind,
  SearchResponse,
  SearchResult,
  Totals,
} from "./types";

/** What the project and phase UI needs from the hub (docs/ATLAS.md). Mock mode swaps the implementation. */
export interface AtlasApi {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectDetail>;
  patchProject(id: string, patch: { name?: string; color?: string }): Promise<ProjectSummary>;
  listPhases(id: string): Promise<PhaseCount[]>;
  /** `null` clears the manual assignment and re-infers. Resolves with the annotated session. */
  setSessionProject(sessionId: string, projectId: string | null): Promise<AtlasSession>;
  /** `null` restores the inferred phase. Resolves with the annotated session. */
  setSessionPhase(sessionId: string, phase: string | null): Promise<AtlasSession>;
  /** GET /sessions: every session the hub keeps, ended and archived included (newest start first). */
  listSessions(opts?: { signal?: AbortSignal }): Promise<AtlasSession[]>;
  /** GET /search. An empty `q` returns recent items. Rejects with an AbortError when `signal` aborts. */
  search(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchResponse>;
}

/** True for the rejection a cancelled request produces; callers drop those silently. */
export const isAbort = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";

const KINDS: readonly SearchKind[] = ["session", "project", "phase"];

/** Defensive parse of the /search body: unknown kinds and malformed rows are dropped. */
export function parseSearch(v: unknown): SearchResponse {
  if (typeof v !== "object" || v === null) throw new AtlasError(0, "Bad response");
  const o = v as Record<string, unknown>;
  const rows = Array.isArray(o["results"]) ? o["results"] : [];
  const results: SearchResult[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const x = r as Record<string, unknown>;
    const kind = x["kind"];
    if (!KINDS.includes(kind as SearchKind) || typeof x["id"] !== "string") continue;
    results.push({
      kind: kind as SearchKind,
      id: x["id"],
      project_id: typeof x["project_id"] === "string" ? x["project_id"] : "",
      title: typeof x["title"] === "string" ? x["title"] : "",
      snippet: typeof x["snippet"] === "string" ? x["snippet"] : "",
      ...(typeof x["state"] === "string" ? { state: x["state"] } : {}),
      score: typeof x["score"] === "number" ? x["score"] : 0,
    });
  }
  return { results, took_ms: typeof o["took_ms"] === "number" ? o["took_ms"] : 0 };
}

export class AtlasError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AtlasError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseProject(v: unknown): ProjectSummary {
  if (!isObj(v) || typeof v["id"] !== "string") throw new AtlasError(0, "bad project payload");
  return {
    id: v["id"],
    project_dir: str(v["project_dir"]),
    name: str(v["name"]),
    color: str(v["color"]),
    vault_collection: typeof v["vault_collection"] === "string" ? v["vault_collection"] : null,
    sessions: num(v["sessions"]),
    live: num(v["live"]),
  };
}

const sessionList = (v: unknown): AtlasSession[] =>
  Array.isArray(v)
    ? (v.filter((s) => isObj(s) && typeof s["session_id"] === "string") as AtlasSession[])
    : [];

export function parseDetail(v: unknown): ProjectDetail {
  if (!isObj(v)) throw new AtlasError(0, "bad project payload");
  const t = isObj(v["totals"]) ? v["totals"] : {};
  const totals: Totals = {
    sessions: num(t["sessions"]),
    hours: num(t["hours"]),
    cost_usd: num(t["cost_usd"]),
  };
  const branches: BranchCount[] = Array.isArray(v["branches"])
    ? v["branches"]
        .filter(isObj)
        .map((b) => ({ branch: str(b["branch"]), sessions: num(b["sessions"]) }))
    : [];
  return {
    project: parseProject(v["project"]),
    live: sessionList(v["live"]),
    archived: sessionList(v["archived"]),
    totals,
    branches,
  };
}

/** Base URL for REST: the Settings hub URL with ws(s) mapped to http(s); empty means same origin. */
export function restBase(hubUrl: string): string {
  const raw = hubUrl.trim();
  if (raw === "") return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "ws:") u.protocol = "http:";
    else if (u.protocol === "wss:") u.protocol = "https:";
    else if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const abortError = (): Error => Object.assign(new Error("Aborted"), { name: "AbortError" });

export interface HttpOptions {
  config: () => { hubUrl: string; token: string };
  fetchImpl?: typeof fetch;
}

/** Same bearer token as the WebSocket (Settings); never put in a URL. */
export function createHttpAtlasApi(opts: HttpOptions): AtlasApi {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const { hubUrl, token } = opts.config();
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== "") headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    let res: Response;
    try {
      res = await f(`${restBase(hubUrl)}${path}`, {
        method,
        headers,
        ...(signal ? { signal } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw e instanceof Error ? e : abortError();
      throw new AtlasError(0, "Hub unreachable");
    }
    if (!res.ok) {
      const reason =
        res.status === 401
          ? "Token rejected"
          : res.status === 404
            ? "Not found"
            : `Hub error ${res.status}`;
      throw new AtlasError(res.status, reason);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new AtlasError(res.status, "Bad response");
    }
  };
  const enc = encodeURIComponent;
  return {
    listProjects: async () => {
      const v = await call("GET", "/projects");
      const list = isObj(v) && Array.isArray(v["projects"]) ? v["projects"] : [];
      return list.map(parseProject);
    },
    getProject: async (id) => parseDetail(await call("GET", `/projects/${enc(id)}`)),
    patchProject: async (id, patch) => {
      const v = await call("PATCH", `/projects/${enc(id)}`, patch);
      return parseProject(isObj(v) ? v["project"] : null);
    },
    listPhases: async (id) => {
      const v = await call("GET", `/projects/${enc(id)}/phases`);
      const list = isObj(v) && Array.isArray(v["phases"]) ? v["phases"] : [];
      return list
        .filter(isObj)
        .map((p) => ({ phase: str(p["phase"]), sessions: num(p["sessions"]) }));
    },
    setSessionProject: async (sid, projectId) =>
      (await call("PATCH", `/sessions/${enc(sid)}/project`, {
        project_id: projectId,
      })) as AtlasSession,
    setSessionPhase: async (sid, phase) =>
      (await call("PATCH", `/sessions/${enc(sid)}/phase`, { phase })) as AtlasSession,
    listSessions: async (o) =>
      sessionList(await call("GET", `/sessions?limit=${SESSION_LIST_LIMIT}`, undefined, o?.signal)),
    search: async (q, o) =>
      parseSearch(
        await call(
          "GET",
          `/search?q=${enc(q.slice(0, MAX_QUERY_CHARS))}&limit=${o?.limit ?? 20}`,
          undefined,
          o?.signal,
        ),
      ),
  };
}

/** The hub rejects /search `q` longer than this (MAX_QUERY_CHARS in the hub's search route). */
export const MAX_QUERY_CHARS = 200;
/** The hub's MAX_LIMIT for /sessions: exactly this many rows back means the list may be cut off. */
export const SESSION_LIST_LIMIT = 1000;

let impl: AtlasApi | null = null;
let ready: Promise<unknown> = Promise.resolve();

/** Mock mode and tests install their own implementation. */
export function setAtlasApi(api: AtlasApi | null): void {
  impl = api;
}

/** Calls wait for `p` first (mock mode: the mock module is loaded dynamically). */
export function setAtlasApiReady(p: Promise<unknown>): void {
  ready = p;
}

const http = createHttpAtlasApi({
  config: () => {
    const s = useUi.getState().settings;
    return { hubUrl: s.hubUrl, token: s.token };
  },
});

async function cur(): Promise<AtlasApi> {
  await ready;
  return impl ?? http;
}

/** The api every component uses; resolves the active implementation per call. */
export const atlasApi: AtlasApi = {
  listProjects: async () => (await cur()).listProjects(),
  getProject: async (id) => (await cur()).getProject(id),
  patchProject: async (id, p) => (await cur()).patchProject(id, p),
  listPhases: async (id) => (await cur()).listPhases(id),
  setSessionProject: async (s, p) => (await cur()).setSessionProject(s, p),
  setSessionPhase: async (s, p) => (await cur()).setSessionPhase(s, p),
  listSessions: async (o) => (await cur()).listSessions(o),
  search: async (q, o) => (await cur()).search(q, o),
};
