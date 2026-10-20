import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot, StreamMessage } from "@sessiondeck/contract";
import { request } from "node:http";
import { WebSocket } from "ws";
import { rowOf } from "../src/ingest/ingestor.ts";
import { AUTH, TOKEN, batch, makeHub, mkEnv, seedSession, type TestHub } from "./support/hub.ts";

const NOW = 1_800_000_000_000;
let h: TestHub;
let urls: { ws: string; http: string };
const open: WebSocket[] = [];

async function boot(env: Record<string, string> = {}, extra = {}): Promise<void> {
  h = await makeHub(env, () => NOW, extra);
  urls = await h.listen();
}
afterEach(async () => {
  for (const w of open.splice(0)) w.terminate();
  await h.cleanup();
});

interface Client {
  ws: WebSocket;
  msgs: StreamMessage[];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects and resolves after the `initial` message has arrived. */
async function connect(
  opts: { headers?: Record<string, string>; protocols?: string[]; autoPong?: boolean } = {},
): Promise<Client> {
  const ws = new WebSocket(`${urls.ws}/stream`, opts.protocols ?? [], {
    headers: opts.headers ?? AUTH,
    ...(opts.autoPong === false ? { autoPong: false } : {}),
  });
  open.push(ws);
  const msgs: StreamMessage[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as StreamMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  await waitFor(() => msgs.length > 0);
  return { ws, msgs };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

/** Raw upgrade attempt; resolves the status code and body of the refusal (or 101). */
function upgrade(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; protocol: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(`${urls.http}${path}`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += String(c)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, protocol: undefined }));
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({
        status: res.statusCode ?? 0,
        body: "",
        protocol: res.headers["sec-websocket-protocol"],
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const sessionsOf = (c: Client): SessionSnapshot[] =>
  c.msgs.flatMap((m) => (m.type === "session" ? [m.data] : []));
const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("R2.8 WS upgrade authentication", () => {
  beforeEach(() => boot());

  it("refuses unauthenticated upgrades with 401 and an empty body", async () => {
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
      { authorization: TOKEN },
      { "sec-websocket-protocol": "sessiondeck.v1" },
      { "sec-websocket-protocol": `sessiondeck.v1, sessiondeck.bearer.${b64("wrong-token")}` },
      // the token protocol without the v1 protocol is not accepted
      { "sec-websocket-protocol": `sessiondeck.bearer.${b64(TOKEN)}` },
      { "sec-websocket-protocol": "sessiondeck.v1, sessiondeck.bearer.%%%" },
    ];
    for (const headers of cases) {
      const r = await upgrade("/stream", headers);
      expect([r.status, r.body]).toEqual([401, ""]);
    }
  });

  it("does not accept a token in the query string", async () => {
    const r = await upgrade(`/stream?token=${TOKEN}&access_token=${TOKEN}`, {});
    expect(r.status).toBe(401);
  });

  it("unknown upgrade paths are 401 without auth and 404 with it", async () => {
    expect((await upgrade("/other", {})).status).toBe(401);
    expect((await upgrade("/other", AUTH)).status).toBe(404);
  });

  it("the token subprotocol authenticates and only sessiondeck.v1 is selected", async () => {
    const protos = ["sessiondeck.v1", `sessiondeck.bearer.${b64(TOKEN)}`];
    const c = await connect({ headers: {}, protocols: protos });
    expect(c.ws.protocol).toBe("sessiondeck.v1");
    const raw = await upgrade("/stream", { "sec-websocket-protocol": protos.join(", ") });
    expect(raw.status).toBe(101);
    expect(raw.protocol).toBe("sessiondeck.v1");
    expect(raw.protocol).not.toContain("bearer");
  });

  it("the Authorization header works without any subprotocol", async () => {
    const c = await connect();
    expect(c.ws.protocol).toBe("");
    expect(c.msgs[0]?.type).toBe("initial");
  });

  it("logs contain no token, in any encoding", async () => {
    await upgrade("/stream", {});
    await upgrade("/stream", {
      "sec-websocket-protocol": `sessiondeck.v1, sessiondeck.bearer.${b64("zzzz-secret-guess")}`,
    });
    await connect({
      headers: {},
      protocols: ["sessiondeck.v1", `sessiondeck.bearer.${b64(TOKEN)}`],
    });
    await connect();
    const all = h.logs.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(b64(TOKEN));
    expect(all).not.toContain("zzzz-secret-guess");
    expect(all).not.toContain(b64("zzzz-secret-guess"));
  });
});

describe("WS upgrade limits", () => {
  it("HUB_ALLOWED_ORIGINS: other origins get 403, listed and absent origins pass", async () => {
    await boot({ HUB_ALLOWED_ORIGINS: "https://deck.example" });
    expect((await upgrade("/stream", { ...AUTH, origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await upgrade("/stream", { ...AUTH, origin: "https://deck.example" })).status).toBe(
      101,
    );
    expect((await upgrade("/stream", AUTH)).status).toBe(101);
    // auth still comes first
    expect((await upgrade("/stream", { origin: "https://evil.example" })).status).toBe(401);
  });

  it("HUB_MAX_WS_CLIENTS caps concurrent clients with 503, and frees slots on close", async () => {
    await boot({ HUB_MAX_WS_CLIENTS: "2" });
    const a = await connect();
    await connect();
    expect((await upgrade("/stream", AUTH)).status).toBe(503);
    a.ws.close();
    await waitFor(() => a.ws.readyState === WebSocket.CLOSED);
    await sleep(20);
    expect((await upgrade("/stream", AUTH)).status).toBe(101);
  });

  it("closes a client that sends a message", async () => {
    await boot();
    const c = await connect();
    const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
    c.ws.send("hello");
    expect(await closed).toBe(1003);
  });

  it("server close terminates connected clients", async () => {
    await boot();
    const c = await connect();
    const closed = new Promise<void>((r) => c.ws.once("close", () => r()));
    await h.app.close();
    await closed;
    // cleanup() closes again; Fastify tolerates it
  });
});

describe("R2.5 stream", () => {
  beforeEach(() => boot());

  it("sends initial on connect, equal to the live set", async () => {
    seedSession(h.store, "a", { started_at: NOW - 1000 });
    seedSession(h.store, "b", { started_at: NOW - 2000 });
    h.store.upsertSession({
      ...rowOf(seedSession(h.store, "old", {})),
      state: "ended",
      ended_at: NOW - 11 * 60_000,
    });
    const c = await connect();
    const live = await h.app.inject({ method: "GET", url: "/sessions?live=1", headers: AUTH });
    expect(c.msgs).toHaveLength(1);
    expect(c.msgs[0]).toEqual({ type: "initial", sessions: live.json() });
    expect((c.msgs[0] as { sessions: unknown[] }).sessions).toHaveLength(2);
  });

  it("every committed delta reaches every client exactly once; rejected batches produce none", async () => {
    const clients = await Promise.all([connect(), connect(), connect()]);
    const e1 = mkEnv({ session_id: "d1" });
    const e2 = mkEnv({ session_id: "d2" });
    expect((await h.post(batch([e1, e2]))).statusCode).toBe(200);
    // rejected: 400 (bad envelope) and a pure duplicate (accepted 0)
    expect((await h.post({ host: "h1", envelopes: [{ nope: 1 }] })).statusCode).toBe(400);
    expect((await h.post(batch([e1]))).statusCode).toBe(200);
    const e3 = mkEnv({ session_id: "d1" });
    expect((await h.post(batch([e3]))).statusCode).toBe(200);
    await waitFor(() => clients.every((c) => sessionsOf(c).length === 3));
    await sleep(50);
    for (const c of clients) {
      expect(sessionsOf(c).map((s) => s.session_id)).toEqual(["d1", "d2", "d1"]);
    }
  });

  it("a SQL-level rollback produces no delta", async () => {
    const c = await connect();
    const orig = h.store.upsertSession.bind(h.store);
    h.store.upsertSession = () => {
      throw new Error("disk full");
    };
    const r = await h.post(batch([mkEnv({ session_id: "rb" })]));
    h.store.upsertSession = orig;
    expect(r.statusCode).toBe(500);
    await sleep(50);
    expect(sessionsOf(c)).toHaveLength(0);
    expect(h.store.getSession("rb")).toBeUndefined();
  });

  it("reconnect resyncs: fresh initial with all committed state and no replayed deltas", async () => {
    const a = await connect();
    const b = await connect();
    await h.post(batch([mkEnv({ session_id: "r1" })]));
    await waitFor(() => sessionsOf(b).length === 1);
    b.ws.close();
    await waitFor(() => b.ws.readyState === WebSocket.CLOSED);
    await h.post(batch([mkEnv({ session_id: "r2" })]));
    const b2 = await connect();
    const init = b2.msgs[0] as { sessions: SessionSnapshot[] };
    expect(init.sessions.map((s) => s.session_id).sort()).toEqual(["r1", "r2"]);
    await h.post(batch([mkEnv({ session_id: "r3" })]));
    await waitFor(() => sessionsOf(b2).length === 1);
    await sleep(50);
    expect(sessionsOf(b2).map((s) => s.session_id)).toEqual(["r3"]);
    expect(sessionsOf(a).map((s) => s.session_id)).toEqual(["r1", "r2", "r3"]);
  });

  it("a batch committed while a client connects is in its initial or its deltas, never both or neither", async () => {
    // Connect and post concurrently, repeatedly; each round uses a fresh session id.
    for (let i = 0; i < 15; i++) {
      const id = `race${i}`;
      const [c] = await Promise.all([connect(), h.post(batch([mkEnv({ session_id: id })]))]);
      const initial = (): boolean =>
        (c.msgs[0] as { sessions: SessionSnapshot[] }).sessions.some((s) => s.session_id === id);
      // Wait with a deadline until the batch is visible in the initial or as a delta.
      await waitFor(() => initial() || sessionsOf(c).some((s) => s.session_id === id));
      await sleep(30); // then give a (wrong) duplicate time to show up
      const inInitial = (c.msgs[0] as { sessions: SessionSnapshot[] }).sessions.some(
        (s) => s.session_id === id,
      );
      const inDeltas = sessionsOf(c).filter((s) => s.session_id === id).length;
      expect(Number(inInitial) + inDeltas).toBeGreaterThanOrEqual(1);
      expect(inInitial && inDeltas > 0).toBe(false);
    }
  });
});

describe("R2.7 staleness over WS", () => {
  beforeEach(() => boot());

  it("initial and deltas show a window past resets_at as null", async () => {
    const base = seedSession(h.store, "stale", { started_at: NOW });
    const win = { used_pct: 77, resets_at: NOW - 5 };
    h.store.upsertSession(
      rowOf({ ...base, rate_limits: { ...base.rate_limits, five_hour: win, seven_day: win } }),
    );
    const c = await connect();
    const init = (c.msgs[0] as { sessions: SessionSnapshot[] }).sessions[0]!;
    expect(init.rate_limits.five_hour).toEqual({ used_pct: null, resets_at: NOW - 5 });
    // A hook for the stored session changes the snapshot; the delta still carries the stale window
    // in storage, and must go out nulled.
    await h.post(batch([mkEnv({ session_id: "stale" })]));
    await waitFor(() => sessionsOf(c).length === 1);
    const d = sessionsOf(c)[0]!;
    expect(d.rate_limits.five_hour?.used_pct).toBeNull();
    expect(d.rate_limits.seven_day?.used_pct).toBeNull();
    expect(JSON.parse(h.store.getSession("stale")!.snapshot).rate_limits.five_hour.used_pct).toBe(
      77,
    );
  });
});

describe("D-S3-12 live set limits", () => {
  it("REST ?live=1 default and the WS initial agree beyond 200 sessions, and truncation warns", async () => {
    await boot();
    for (let i = 0; i < 250; i++) seedSession(h.store, `lv${i}`, { started_at: NOW - i });
    const c = await connect();
    const rest = await h.app.inject({ method: "GET", url: "/sessions?live=1", headers: AUTH });
    const restIds = (rest.json() as SessionSnapshot[]).map((s) => s.session_id);
    expect(restIds).toHaveLength(250);
    expect(c.msgs[0]).toEqual({ type: "initial", sessions: rest.json() });
    // a limit equal to the available count is reported as truncation
    const capped = await h.app.inject({
      method: "GET",
      url: "/sessions?live=1&limit=100",
      headers: AUTH,
    });
    expect(capped.statusCode).toBe(200);
    expect(
      h.logLines().some((l) => l["msg"] === "live session set truncated" && l["count"] === 100),
    ).toBe(true);
  });
});

describe("slow client", () => {
  it("terminates a client whose send buffer exceeds the cap; others keep receiving", async () => {
    await boot({}, { maxBufferedBytes: 1000 });
    const slow = await connect();
    const good = await connect();
    // A stalled peer: its socket is paused, and the server-side socket reports a backed-up send
    // buffer (loopback kernel buffers are too large to fill quickly in a test).
    const sock = (w: WebSocket) =>
      (w as unknown as { _socket: { pause(): void; localPort: number; remotePort: number } })
        ._socket;
    sock(slow.ws).pause();
    const slowPort = sock(slow.ws).localPort;
    const real = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount")!;
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      configurable: true,
      get(this: WebSocket) {
        return sock(this).remotePort === slowPort ? 5_000_000 : (real.get!.call(this) as number);
      },
    });
    try {
      expect((await h.post(batch([mkEnv({ session_id: "sl1" })]))).statusCode).toBe(200);
      await waitFor(() => slow.ws.readyState === WebSocket.CLOSED, 5000);
      expect((await h.post(batch([mkEnv({ session_id: "sl2" })]))).statusCode).toBe(200);
      await waitFor(() => sessionsOf(good).length === 2);
      expect(sessionsOf(good).map((s) => s.session_id)).toEqual(["sl1", "sl2"]);
      expect(good.ws.readyState).toBe(WebSocket.OPEN);
      expect(h.logs.join("\n")).toContain("ws client too slow, terminated");
    } finally {
      Object.defineProperty(WebSocket.prototype, "bufferedAmount", real);
    }
  });
});

describe("heartbeat", () => {
  it("terminates a client that stops answering pings; a healthy one stays", async () => {
    await boot({}, { heartbeatMs: 150 });
    const dead = await connect({ autoPong: false });
    const live = await connect();
    await waitFor(() => dead.ws.readyState === WebSocket.CLOSED, 5000);
    await sleep(300);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
  });
});
