// WS /stream. Written from the ws API; no code copied from any project.
import { STREAM_HEARTBEAT_MS, type StreamMessage } from "@sessiondeck/contract";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Store } from "./db/store.ts";
import type { HubEmitter } from "./ingest/ingestor.ts";
import { liveSnapshots } from "./routes/read.ts";
import { MAX_LIMIT } from "./snapshots.ts";
import { applyRateLimitStaleness } from "./ingest/reduce.ts";

export const STREAM_PROTOCOL = "sessiondeck.v1";
export const BEARER_PROTOCOL_PREFIX = "sessiondeck.bearer.";
/** A client whose send buffer exceeds this is terminated rather than buffered without bound. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Clients send nothing meaningful; anything bigger than a ping payload is refused by ws. */
const MAX_INCOMING_BYTES = 256;

export interface StreamDeps {
  store: Store;
  events: HubEmitter;
  now: () => number;
  /** True when the upgrade request carries a valid bearer (header) or protocol token. */
  authenticate: (req: IncomingMessage) => boolean;
  /** D-S3-14: false when the principal is over its read rate (upgrade refused with 429). */
  allowRead: (req: IncomingMessage) => boolean;
  maxClients: number;
  allowedOrigins: string[];
  heartbeatMs?: number;
  maxBufferedBytes?: number;
}

/** Offered subprotocols, in order. */
export function offeredProtocols(header: string | string[] | undefined): string[] {
  if (typeof header !== "string") return [];
  return header
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** The token carried in a `sessiondeck.bearer.<base64url>` subprotocol, if the offer is usable. */
export function tokenFromProtocols(header: string | string[] | undefined): string | null {
  const offered = offeredProtocols(header);
  if (!offered.includes(STREAM_PROTOCOL)) return null;
  const p = offered.find((x) => x.startsWith(BEARER_PROTOCOL_PREFIX));
  if (p === undefined) return null;
  const b64 = p.slice(BEARER_PROTOCOL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(b64)) return null;
  return Buffer.from(b64, "base64url").toString("utf8");
}

/**
 * After the `upgrade` event Node no longer applies header/request timeouts and keeps the socket
 * half-open, so a refused socket must be destroyed by us: once the refusal is flushed, or after a
 * short deadline when the peer never reads.
 */
function refuse(socket: Duplex, status: string): void {
  const t = setTimeout(() => socket.destroy(), 2000);
  t.unref();
  socket.once("close", () => clearTimeout(t));
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

export function registerStream(app: FastifyInstance, deps: StreamDeps): void {
  const heartbeatMs = deps.heartbeatMs ?? STREAM_HEARTBEAT_MS;
  const maxBuffered = deps.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INCOMING_BYTES,
    // Select the plain protocol only; the bearer subprotocol is never echoed back.
    handleProtocols: (protocols) => (protocols.has(STREAM_PROTOCOL) ? STREAM_PROTOCOL : false),
  });
  const clients = new Map<WebSocket, { alive: boolean }>();

  const send = (ws: WebSocket, text: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > maxBuffered) {
      app.log.warn({ buffered: ws.bufferedAmount }, "ws client too slow, terminated");
      ws.terminate();
      return;
    }
    ws.send(text, (err) => {
      if (err) ws.terminate();
    });
  };

  // Raw `upgrade` events bypass Fastify's onRequest hook, so authentication happens here, before
  // handleUpgrade writes the 101. Every refusal is a bare status line; nothing about the
  // credentials is logged.
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => undefined);
    const url = (req.url ?? "").split("?")[0];
    if (!deps.authenticate(req)) return refuse(socket, "401 Unauthorized");
    if (url !== "/stream") return refuse(socket, "404 Not Found");
    if (!deps.allowRead(req)) return refuse(socket, "429 Too Many Requests");
    const origin = req.headers.origin;
    if (
      deps.allowedOrigins.length > 0 &&
      origin !== undefined &&
      !deps.allowedOrigins.includes(origin)
    ) {
      app.log.warn("ws upgrade refused: origin not allowed");
      return refuse(socket, "403 Forbidden");
    }
    if (clients.size >= deps.maxClients) {
      app.log.warn({ max: deps.maxClients }, "ws upgrade refused: client cap reached");
      return refuse(socket, "503 Service Unavailable");
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // One synchronous block (handleUpgrade invokes this callback synchronously; better-sqlite3
      // is synchronous too): compute the initial payload and join the broadcast set with no await
      // between. Ingest commits and emits in a single synchronous run, so it cannot interleave:
      // a batch committed before this block is inside the initial payload and was emitted to the
      // old client set; a batch committed after it is emitted to this client. No delta is lost
      // or duplicated across connect, and a reconnect never replays older deltas.
      const initial: StreamMessage = {
        type: "initial",
        sessions: liveSnapshots(deps.store, deps.now(), MAX_LIMIT, app.log),
      };
      clients.set(ws, { alive: true });
      send(ws, JSON.stringify(initial));

      ws.on("pong", () => {
        const c = clients.get(ws);
        if (c) c.alive = true;
      });
      ws.on("message", () => ws.close(1003, "no client messages"));
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => ws.terminate());
    });
  };
  app.server.on("upgrade", onUpgrade);

  // Only `session` deltas are broadcast. {type:'transcript'} is typed NormalizedEntry[] in the
  // contract and needs the normalizer (S7), so committed transcript lines are not pushed yet.
  const onBatch = (b: { sessions: Parameters<typeof applyRateLimitStaleness>[0][] }): void => {
    if (clients.size === 0) return;
    const t = deps.now();
    for (const snap of b.sessions) {
      const text = JSON.stringify({
        type: "session",
        data: applyRateLimitStaleness(snap, t),
      } satisfies StreamMessage);
      for (const ws of clients.keys()) send(ws, text);
    }
  };
  deps.events.on("batch", onBatch);

  const timer = setInterval(() => {
    for (const [ws, c] of clients) {
      if (!c.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      c.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, heartbeatMs);
  timer.unref();

  // preClose runs before Fastify calls server.close(), which would otherwise wait forever on the
  // upgraded sockets. Idempotent: a second app.close() finds nothing left to do.
  app.addHook("preClose", async () => {
    clearInterval(timer);
    deps.events.off("batch", onBatch);
    app.server.off("upgrade", onUpgrade);
    for (const ws of clients.keys()) ws.terminate();
    clients.clear();
  });
  app.addHook("onClose", async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
}
