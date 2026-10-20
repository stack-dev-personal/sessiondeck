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

/** Minimal shape check for what the board dereferences. Anything else is dropped. */
export function isSnapshot(v: unknown): v is SessionSnapshot {
  return (
    isObj(v) &&
    typeof v["session_id"] === "string" &&
    v["session_id"] !== "" &&
    typeof v["host"] === "string" &&
    typeof v["state"] === "string" &&
    isObj(v["context"]) &&
    isObj(v["rate_limits"])
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
    if (current)
      armLiveness(); // a quiet probe failed; the old socket stays, probe again later
    else scheduleRetry();
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
