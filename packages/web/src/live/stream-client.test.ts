import type { SessionSnapshot } from "@sessiondeck/contract";
import { createSnapshot } from "@sessiondeck/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardStore } from "../store/board";
import {
  BACKOFF_CAP_MS,
  backoffDelay,
  base64url,
  createStreamClient,
  parseMessage,
  protocolsFor,
  streamUrl,
  type LinkStatus,
  type WebSocketLike,
} from "./stream-client";
import { wireStream } from "./start";

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWs.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  send(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  drop() {
    this.onclose?.({});
  }
}

const snap = (id: string, state: SessionSnapshot["state"] = "working"): SessionSnapshot => ({
  ...createSnapshot({ session_id: id, host: "h1", cwd: "/p", ts: 1 }),
  state,
});

interface Timer {
  at: number;
  cb: () => void;
  id: number;
}
function clock() {
  let t = 1_000;
  let n = 0;
  let timers: Timer[] = [];
  return {
    now: () => t,
    setTimeout: (cb: () => void, ms: number) => {
      const id = ++n;
      timers.push({ at: t + ms, cb, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers = timers.filter((x) => x.id !== id);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((x) => x !== next);
        t = next.at;
        next.cb();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

function setup(over: { random?: () => number } = {}) {
  const c = clock();
  const frames: (() => void)[] = [];
  const store = createBoardStore((cb) => frames.push(cb));
  const writes = vi.fn();
  store.subscribe(writes);
  const statuses: [LinkStatus, number | null][] = [];
  const client = createStreamClient({
    url: "ws://hub/stream",
    token: "tok-tok-tok-tok-1234",
    onInitial: (l) => store.getState().replaceAll(l),
    onSession: (s) => store.getState().enqueueSnapshot(s),
    onStatus: (s, r) => statuses.push([s, r]),
    WebSocketCtor: FakeWs,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    now: c.now,
    random: over.random ?? (() => 1),
  });
  const flush = () => frames.splice(0).forEach((f) => f());
  return { c, store, writes, statuses, client, flush, frames };
}

beforeEach(() => {
  FakeWs.all = [];
});

describe("stream client", () => {
  it("offers the plain protocol plus the bearer subprotocol, token not in the URL", () => {
    const { client } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    expect(ws.url).toBe("ws://hub/stream");
    expect(ws.protocols[0]).toBe("sessiondeck.v1");
    expect(ws.protocols[1]).toBe(`sessiondeck.bearer.${base64url("tok-tok-tok-tok-1234")}`);
    expect(ws.url).not.toContain("tok");
    expect(protocolsFor("a?b>c")[1]).toMatch(/^sessiondeck\.bearer\.[A-Za-z0-9_-]+$/);
  });

  it("initial replaces the session map; status goes connecting then open", () => {
    const { client, store, statuses } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.send({ type: "initial", sessions: [snap("a"), snap("b")] });
    expect(Object.keys(store.getState().sessions).sort()).toEqual(["a", "b"]);
    expect(statuses.map((s) => s[0])).toEqual(["connecting", "open"]);
  });

  it("coalesces 50 deltas into one store write per frame, latest snapshot wins", () => {
    const { client, store, writes, flush, frames } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.send({ type: "initial", sessions: [snap("a", "idle")] });
    writes.mockClear();
    for (let i = 0; i < 50; i++) {
      ws.send({ type: "session", data: { ...snap("a", i === 49 ? "waiting_input" : "working") } });
    }
    ws.send({ type: "session", data: snap("b") });
    expect(frames).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
    flush();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.getState().sessions["a"]?.state).toBe("waiting_input");
    expect(store.getState().sessions["b"]).toBeDefined();
  });

  it("disconnect sets closed with a retry time; reconnect resync drops a stale working session", () => {
    const { client, store, statuses, c } = setup();
    client.start();
    const first = FakeWs.all[0]!;
    first.send({ type: "initial", sessions: [snap("a"), snap("b")] });
    expect(store.getState().sessions["a"]?.state).toBe("working");
    first.drop();
    expect(statuses.at(-1)).toEqual(["closed", c.now() + 500]);
    c.advance(500);
    expect(statuses.at(-1)![0]).toBe("connecting");
    const second = FakeWs.all[1]!;
    second.send({ type: "initial", sessions: [snap("b")] });
    expect(store.getState().sessions["a"]).toBeUndefined();
    expect(Object.keys(store.getState().sessions)).toEqual(["b"]);
    expect(statuses.at(-1)).toEqual(["open", null]);
  });

  it("ignores deltas that arrive before the socket's initial", () => {
    const { client, store, flush } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.send({ type: "session", data: snap("early") });
    ws.send({ type: "initial", sessions: [snap("a")] });
    flush();
    expect(Object.keys(store.getState().sessions)).toEqual(["a"]);
  });

  it("a delta queued before the drop is discarded when the new initial replaces the set", () => {
    const { client, store, flush, c } = setup();
    client.start();
    const first = FakeWs.all[0]!;
    first.send({ type: "initial", sessions: [snap("a")] });
    first.send({ type: "session", data: snap("a", "working") });
    first.drop();
    c.advance(500);
    FakeWs.all[1]!.send({ type: "initial", sessions: [] });
    flush();
    expect(store.getState().sessions).toEqual({});
  });

  it("backs off exponentially to the cap and resets after a successful initial", () => {
    const { client, statuses, c } = setup();
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      FakeWs.all.at(-1)!.drop();
      const s = statuses.at(-1)!;
      delays.push(s[1]! - c.now());
      c.advance(s[1]! - c.now());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
    FakeWs.all.at(-1)!.send({ type: "initial", sessions: [] });
    FakeWs.all.at(-1)!.drop();
    expect(statuses.at(-1)![1]! - c.now()).toBe(500);
  });

  it("backoffDelay jitters between 50% and 100% and caps", () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(30, () => 1)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelay(30, () => 0)).toBe(BACKOFF_CAP_MS / 2);
  });

  it("error without close also reconnects once", () => {
    const { client, c } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.onerror?.({});
    ws.onclose?.({});
    c.advance(10_000);
    expect(FakeWs.all).toHaveLength(2);
  });

  it("a silent socket is replaced quietly after the liveness window, status stays open", () => {
    const { client, statuses, c, store } = setup();
    client.start();
    const first = FakeWs.all[0]!;
    first.send({ type: "initial", sessions: [snap("a")] });
    const before = statuses.length;
    c.advance(60_000);
    expect(FakeWs.all).toHaveLength(2);
    expect(statuses).toHaveLength(before);
    FakeWs.all[1]!.send({ type: "initial", sessions: [] });
    expect(first.closed).toBe(true);
    expect(store.getState().sessions).toEqual({});
  });

  it("messages keep the liveness timer from firing", () => {
    const { client, c } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.send({ type: "initial", sessions: [] });
    for (let i = 0; i < 5; i++) {
      c.advance(40_000);
      ws.send({ type: "session", data: snap("a") });
    }
    expect(FakeWs.all).toHaveLength(1);
  });

  it("drops malformed messages without throwing", () => {
    const { client, store, flush } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.send({ type: "initial", sessions: [snap("a"), { session_id: 5 }, null, "x"] });
    for (const bad of [
      "not json",
      "{",
      "[]",
      "null",
      '{"type":"session"}',
      '{"type":"session","data":{"session_id":"z"}}',
      '{"type":"mystery"}',
    ]) {
      expect(() => ws.send(bad)).not.toThrow();
    }
    ws.onmessage?.({ data: new ArrayBuffer(2) });
    flush();
    expect(Object.keys(store.getState().sessions)).toEqual(["a"]);
  });

  it("stop() detaches handlers and cancels timers", () => {
    const { client, c } = setup();
    client.start();
    const ws = FakeWs.all[0]!;
    ws.send({ type: "initial", sessions: [] });
    client.stop();
    expect(ws.closed).toBe(true);
    expect(c.pending()).toBe(0);
    ws.drop();
    expect(c.pending()).toBe(0);
  });

  it("parseMessage ignores transcript and alert types", () => {
    expect(parseMessage('{"type":"alert","message":"x"}')).toBeNull();
    expect(parseMessage('{"type":"transcript","session_id":"a","lines":[]}')).toBeNull();
  });
});

describe("streamUrl", () => {
  const loc = { protocol: "https:", host: "deck.example:8443" };
  it("same origin when empty, mapping http to ws and https to wss", () => {
    expect(streamUrl("", loc)).toBe("wss://deck.example:8443/stream");
    expect(streamUrl("", { protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/stream",
    );
    expect(streamUrl("http://hub:8787/", loc)).toBe("ws://hub:8787/stream");
    expect(streamUrl("wss://h/base", loc)).toBe("wss://h/base/stream");
  });
  it("strips credentials and query so the token cannot ride in the URL", () => {
    expect(streamUrl("http://u:p@hub:1?token=x#y", loc)).toBe("ws://hub:1/stream");
  });
  it("rejects junk", () => {
    expect(streamUrl("ftp://x", loc)).toBeNull();
    expect(streamUrl("not a url", loc)).toBeNull();
  });
});

describe("wireStream banner state", () => {
  it("maps link status into the store", () => {
    const store = createBoardStore(() => undefined);
    const c = clock();
    const stop = wireStream(store, {
      hubUrl: "http://hub:8787",
      token: "tok-tok-tok-tok-1234",
      WebSocketCtor: FakeWs,
      setTimeout: c.setTimeout,
      clearTimeout: c.clearTimeout,
      now: c.now,
      random: () => 1,
      location: { protocol: "http:", host: "x" },
    });
    expect(store.getState().connection).toBe("connecting");
    FakeWs.all[0]!.send({ type: "initial", sessions: [snap("a")] });
    expect(store.getState().connection).toBe("open");
    FakeWs.all[0]!.drop();
    expect(store.getState().connection).toBe("closed");
    expect(store.getState().retryAt).toBe(c.now() + 500);
    stop();
  });
});
