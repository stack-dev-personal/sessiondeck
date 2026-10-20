import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect } from "node:net";
import { request } from "node:http";
import { AUTH, batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";

let h: TestHub;
afterEach(async () => {
  await h.cleanup();
});

// The clock is frozen, so a bucket never refills inside a test.
const get = (url: string, headers: Record<string, string> = AUTH) =>
  h.app.inject({ method: "GET", url, headers });

describe("D-S3-14 read rate limit", () => {
  it("REST reads over the burst get 429 with an empty body; health and ingest are unaffected", async () => {
    h = await makeHub({ HUB_READ_BURST: "3" }, () => 1_800_000_000_000);
    for (let i = 0; i < 3; i++) expect((await get("/sessions")).statusCode).toBe(200);
    const r = await get("/sessions");
    expect([r.statusCode, r.body]).toEqual([429, ""]);
    expect((await get("/hosts")).statusCode).toBe(429);
    expect((await get("/health", {})).statusCode).toBe(200);
    expect((await h.post(batch([mkEnv()]))).statusCode).toBe(200);
    // unauthenticated requests are still 401, and do not drain the bucket
    expect((await get("/sessions", {})).statusCode).toBe(401);
  });

  it("refills over time", async () => {
    let t = 1_800_000_000_000;
    h = await makeHub({ HUB_READ_BURST: "2", HUB_READ_RATE: "1" }, () => t);
    expect((await get("/sessions")).statusCode).toBe(200);
    expect((await get("/sessions")).statusCode).toBe(200);
    expect((await get("/sessions")).statusCode).toBe(429);
    t += 1500;
    expect((await get("/sessions")).statusCode).toBe(200);
  });

  it("WS upgrades share the read bucket and are refused with 429", async () => {
    h = await makeHub({ HUB_READ_BURST: "2" }, () => 1_800_000_000_000);
    const u = await h.listen();
    const up = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = request(`${u.http}/stream`, {
          headers: {
            ...AUTH,
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
          },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await up()).toBe(101);
    expect(await up()).toBe(101);
    expect(await up()).toBe(429);
    expect((await get("/sessions")).statusCode).toBe(429);
  });
});

describe("refused upgrades release the socket", () => {
  it("the server closes a refused upgrade socket while the client keeps its side open", async () => {
    h = await makeHub();
    const u = await h.listen();
    const port = Number(new URL(u.http).port);
    const sockets = await Promise.all(
      Array.from(
        { length: 10 },
        () =>
          new Promise<{ closed: Promise<void>; head: () => string }>((resolve) => {
            // allowHalfOpen: our side never sends FIN after the request
            const s = netConnect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => {
              s.write(
                "GET /stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
                  "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n",
              );
            });
            let data = "";
            s.on("data", (d) => (data += String(d)));
            s.on("error", () => undefined);
            resolve({
              closed: new Promise<void>((r) => s.once("end", () => r())), // server FIN or close
              head: () => data,
            });
          }),
      ),
    );
    const timeout = new Promise<string>((r) => setTimeout(() => r("timeout"), 3000));
    const res = await Promise.race([
      Promise.all(sockets.map((s) => s.closed)).then(() => "closed"),
      timeout,
    ]);
    expect(res).toBe("closed");
    for (const s of sockets) expect(s.head()).toMatch(/^HTTP\/1\.1 401 /);
  });
});
