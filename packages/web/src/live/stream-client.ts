import type { SessionSnapshot } from "@sessiondeck/contract";

/** Mirrors packages/hub/src/stream.ts (the contract does not export the names). */
export const STREAM_PROTOCOL = "sessiondeck.v1";
export const BEARER_PROTOCOL_PREFIX = "sessiondeck.bearer.";

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 10_000;
/**
 * Browsers do not expose WebSocket ping frames, so "no ping" cannot be observed. The hub only
 * sends data on change, so an idle hub is silent. After this long without a message the client
 * opens a second socket quietly (status stays as is) and swaps over when it is up, which also
 * resyncs; a half-open connection is thereby replaced without a banner flicker on a healthy one.
 */
export const LIVENESS_MS = 60_000;

export type LinkStatus = "connecting" | "open" | "closed";

export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}
export type WebSocketCtor = new (url: string, protocols: string[]) => WebSocketLike;

export interface StreamClientOptions {
  /** ws:// or wss:// URL of /stream. Never carries the token. */
  url: string;
  token: string;
  /** Called with the full live set on every (re)connect; the consumer REPLACES its state. */
  onInitial: (sessions: SessionSnapshot[]) => void;
  /** Called per delta, only after the socket's own initial. */
  onSession: (s: SessionSnapshot) => void;
  /** `retryAt` is the epoch ms of the next attempt while closed, else null. */
  onStatus: (status: LinkStatus, retryAt: number | null) => void;
  WebSocketCtor?: WebSocketCtor;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  random?: () => number;
  now?: () => number;
  livenessMs?: number;
}

export interface StreamClient {
  start: () => void;
  stop: () => void;
}

/** Delay before reconnect attempt `attempt` (0-based): exponential, capped, jittered to 50-100%. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(exp * (0.5 + 0.5 * random()));
}

export function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function protocolsFor(token: string): string[] {
  return [STREAM_PROTOCOL, `${BEARER_PROTOCOL_PREFIX}${base64url(token)}`];
}

/** Resolves the /stream URL: empty hubUrl means same origin; http(s) maps to ws(s). */
export function streamUrl(hubUrl: string, loc: { protocol: string; host: string }): string | null {
  const raw = hubUrl.trim();
  let base: URL;
  try {
    base = raw === "" ? new URL(`${loc.protocol}//${loc.host}`) : new URL(raw);
  } catch {
    return null;
  }
  const scheme = base.protocol;
  if (scheme === "http:") base.protocol = "ws:";
  else if (scheme === "https:") base.protocol = "wss:";
  else if (scheme !== "ws:" && scheme !== "wss:") return null;
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/stream`;
  return base.toString();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const numOrNull = (v: unknown): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v));
const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const windowOk = (v: unknown): boolean =>
  v === null || (isObj(v) && numOrNull(v["used_pct"]) && numOrNull(v["resets_at"]));

/** Ids that would act on the prototype when used as a plain-object key. */
export const RESERVED_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Shape check for everything the board and drawer dereference. Anything else is dropped. */
export function isSnapshot(v: unknown): v is SessionSnapshot {
  if (!isObj(v)) return false;
  const id = v["session_id"];
  if (typeof id !== "string" || id === "" || RESERVED_IDS.has(id)) return false;
  if (typeof v["host"] !== "string" || typeof v["state"] !== "string") return false;
  const ctx = v["context"];
  if (!isObj(ctx)) return false;
  for (const k of ["used_pct", "window", "input", "output"]) if (!numOrNull(ctx[k])) return false;
  const rl = v["rate_limits"];
  if (!isObj(rl)) return false;
  if (!windowOk(rl["five_hour"]) || !windowOk(rl["seven_day"]) || !numOrNull(rl["captured_at"]))
    return false;
  const cost = v["cost"];
  if (!isObj(cost)) return false;
  for (const k of ["usd", "duration_ms", "lines_added", "lines_removed"])
    if (!numOrNull(cost[k])) return false;
  const tasks = v["tasks"];
  if (
    !isObj(tasks) ||
    typeof tasks["total"] !== "number" ||
    typeof tasks["completed"] !== "number" ||
    !strOrNull(tasks["last_subject"])
  )
    return false;
  if (!Array.isArray(v["subagents"]) || !v["subagents"].every(isObj)) return false;
  const git = v["git"];
  if (!isObj(git) || !strOrNull(git["branch"]) || !strOrNull(git["worktree"])) return false;
  const model = v["model"];
  if (
    model !== null &&
    !(isObj(model) && strOrNull(model["id"]) && strOrNull(model["display_name"]))
  )
    return false;
  return (
    typeof v["state_since"] === "number" &&
    typeof v["started_at"] === "number" &&
    typeof v["last_event_at"] === "number"
  );
}

export type Parsed =
  | { type: "initial"; sessions: SessionSnapshot[] }
  | { type: "session"; data: SessionSnapshot }
  | null;

/** Never throws. Unknown message types (transcript, alert) and malformed input give null. */
export function parseMessage(data: unknown): Parsed {
  if (typeof data !== "string") return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  if (m["type"] === "initial" && Array.isArray(m["sessions"])) {
    return { type: "initial", sessions: m["sessions"].filter(isSnapshot) };
  }
  if (m["type"] === "session" && isSnapshot(m["data"])) {
    return { type: "session", data: m["data"] };
  }
  return null;
}

export function createStreamClient(opts: StreamClientOptions): StreamClient {
  const Ctor = opts.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
  const setT = opts.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clearT = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const livenessMs = opts.livenessMs ?? LIVENESS_MS;

  let running = false;
  let current: WebSocketLike | null = null;
  let candidate: WebSocketLike | null = null;
  let attempt = 0;
  let retryTimer: unknown = null;
  let liveTimer: unknown = null;

  const detach = (s: WebSocketLike | null): void => {
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };
  const clearTimers = (): void => {
    if (retryTimer !== null) clearT(retryTimer);
    if (liveTimer !== null) clearT(liveTimer);
    retryTimer = liveTimer = null;
  };
  const armLiveness = (): void => {
    if (liveTimer !== null) clearT(liveTimer);
    liveTimer = setT(() => {
      liveTimer = null;
      if (running && current && !candidate) open();
    }, livenessMs);
  };

  const scheduleRetry = (): void => {
    if (!running || retryTimer !== null) return;
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    opts.onStatus("closed", now() + delay);
    retryTimer = setT(() => {
      retryTimer = null;
      if (running) open();
    }, delay);
  };

  /** A socket (current or candidate) failed or closed. */
  const lost = (sock: WebSocketLike): void => {
    detach(sock);
    if (sock === candidate) candidate = null;
    if (sock === current) {
      current = null;
      if (liveTimer !== null) clearT(liveTimer);
      liveTimer = null;
      if (candidate === null) scheduleRetry();
      else opts.onStatus("connecting", null);
      return;
    }
    if (current) {
      // A quiet liveness probe failed while the old socket was silent for the whole window: the
      // link is half-open or the hub is gone. Treat the old socket as dead so the banner shows.
      const dead = current;
      current = null;
      if (liveTimer !== null) clearT(liveTimer);
      liveTimer = null;
      detach(dead);
    }
    scheduleRetry();
  };

  function open(): void {
    if (!running || candidate) return;
    if (current === null) opts.onStatus("connecting", null);
    let sock: WebSocketLike;
    try {
      sock = new Ctor(opts.url, protocolsFor(opts.token));
    } catch {
      // Bad URL or blocked construction: treat as a failed attempt.
      scheduleRetry();
      return;
    }
    candidate = sock;
    let ready = false;
    sock.onmessage = (ev) => {
      if (sock !== candidate && sock !== current) return;
      const msg = parseMessage(ev.data);
      if (msg === null) return;
      if (liveTimer !== null) armLiveness();
      if (msg.type === "initial") {
        if (sock === candidate) {
          const old = current;
          candidate = null;
          current = sock;
          detach(old);
        }
        ready = true;
        attempt = 0;
        opts.onInitial(msg.sessions);
        opts.onStatus("open", null);
        armLiveness();
      } else if (ready) {
        opts.onSession(msg.data);
      }
    };
    sock.onclose = () => lost(sock);
    sock.onerror = () => lost(sock);
  }

  return {
    start: () => {
      if (running) return;
      running = true;
      attempt = 0;
      open();
    },
    stop: () => {
      running = false;
      clearTimers();
      detach(current);
      detach(candidate);
      current = candidate = null;
    },
  };
}
