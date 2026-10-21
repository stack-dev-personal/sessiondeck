import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@sessiondeck/contract";
import { BACKOFF_CAP_MS, backoffDelay } from "../src/daemon/backoff.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.ts";
import { DayFileReader } from "../src/daemon/reader.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { appendSpoolLines } from "../src/spool-writer.ts";
import { spoolDir } from "../src/paths.ts";
import type { SpoolLine } from "../src/spool-format.ts";

let home: string;
const open: DaemonHandle[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sd-daemon-"));
});
afterEach(async () => {
  for (const d of open.splice(0)) await d.kill();
  rmSync(home, { recursive: true, force: true });
});

const noLog = (): void => undefined;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(10);
  if (!cond()) throw new Error("timed out waiting");
}

function line(n: number, ts = Date.now()): SpoolLine {
  return buildEnvelope({
    kind: "hook",
    host: "h",
    session_id: "s1",
    hook_event_name: "PostToolUse",
    payload: { n },
    ts,
  });
}

describe("R1.4 backoff", () => {
  it("stays inside [0, min(cap, base*2^n)) and caps at 30 s", () => {
    for (let n = 0; n < 40; n++) {
      const ceiling = Math.min(BACKOFF_CAP_MS, 500 * 2 ** Math.min(n, 30));
      expect(backoffDelay(n, () => 0)).toBe(0);
      const hi = backoffDelay(n, () => 0.999999);
      expect(hi).toBeLessThan(ceiling);
      expect(hi).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
    expect(backoffDelay(100, () => 0.999999)).toBeGreaterThan(29_000);
  });
  it("honours a custom cap", () => {
    expect(backoffDelay(50, () => 0.999999, 500, 2000)).toBeLessThan(2000);
  });
  it("grows with the attempt number", () => {
    const d = (n: number): number => backoffDelay(n, () => 0.5);
    expect(d(0)).toBeLessThan(d(3));
    expect(d(3)).toBeLessThan(d(6));
  });
});

describe("R1.4 day-file reader cursor", () => {
  it("reads across day files in order and resumes from the cursor", async () => {
    const dir = join(home, "spool");
    appendSpoolLines(dir, [line(0), line(1)], () => Date.parse("2026-01-01T10:00:00Z"));
    appendSpoolLines(dir, [line(2)], () => Date.parse("2026-01-02T10:00:00Z"));
    appendSpoolLines(dir, [line(3), line(4)], () => Date.parse("2026-01-04T10:00:00Z"));
    const later = (): number => Date.now() + 120_000; // past the day-file grace
    const r = new DayFileReader(dir, undefined, noLog, later);
    const a = await r.read(3, 1e6);
    expect(a.items.map((i) => (i.payload as { n: number }).n)).toEqual([0, 1, 2]);
    const saved = JSON.parse(JSON.stringify(r.position)) as { file: string; offset: number };
    const r2 = new DayFileReader(dir, saved, noLog, later);
    const b = await r2.read(10, 1e6);
    expect(b.items.map((i) => (i.payload as { n: number }).n)).toEqual([3, 4]);
    expect(r2.position?.file).toBe("2026-01-04.jsonl");
    expect((await r2.read(10, 1e6)).items).toEqual([]);
  });

  it("holds back a partial last line until its newline arrives", async () => {
    const dir = join(home, "spool");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "2026-01-01.jsonl");
    const full = JSON.stringify(line(7));
    writeFileSync(f, `${JSON.stringify(line(6))}\n${full.slice(0, 30)}`);
    const r = new DayFileReader(dir, undefined, noLog);
    expect((await r.read(10, 1e6)).items).toHaveLength(1);
    const before = r.position?.offset;
    expect((await r.read(10, 1e6)).items).toHaveLength(0);
    expect(r.position?.offset).toBe(before);
    appendFileSync(f, `${full.slice(30)}\n`);
    const c = await r.read(10, 1e6);
    expect(c.items.map((i) => (i.payload as { n: number }).n)).toEqual([7]);
  });

  it("skips invalid lines without a seq, and logs them", async () => {
    const dir = join(home, "spool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01.jsonl"),
      `not json\n${JSON.stringify(line(1))}\n{"v":1}\n${JSON.stringify(line(2))}\n`,
    );
    const logs: string[] = [];
    const r = new DayFileReader(dir, undefined, (_l, m) => logs.push(m));
    const out = await r.read(10, 1e6);
    expect(out.items).toHaveLength(2);
    expect(r.skipped).toBe(2);
    expect(logs.length).toBe(2);
  });

  it("restarts a shrunken file from 0 (no inode on Windows)", async () => {
    const dir = join(home, "spool");
    appendSpoolLines(dir, [line(0), line(1), line(2)], () => Date.parse("2026-01-01T10:00:00Z"));
    const r = new DayFileReader(dir, undefined, noLog);
    await r.read(10, 1e6);
    const f = join(dir, "2026-01-01.jsonl");
    truncateSync(f, 0);
    appendSpoolLines(dir, [line(9)], () => Date.parse("2026-01-01T11:00:00Z"));
    expect(statSync(f).size).toBeLessThan(r.position?.offset ?? 0);
    const out = await r.read(10, 1e6);
    expect(out.items.map((i) => (i.payload as { n: number }).n)).toEqual([9]);
  });

  it("closes a read at the byte budget", async () => {
    const dir = join(home, "spool");
    appendSpoolLines(
      dir,
      Array.from({ length: 20 }, (_, i) => line(i)),
    );
    const r = new DayFileReader(dir, undefined, noLog);
    const out = await r.read(200, 2000);
    expect(out.full).toBe(true);
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items.length).toBeLessThan(20);
  });
});

interface Sent {
  status: number;
  envs: Envelope[];
}

/** A fetch stand-in that records POST /ingest bodies and answers from `answer`. */
function fakeFetch(answer: (n: number) => number | "hang") {
  const sent: Sent[] = [];
  const auth: (string | null)[] = [];
  const f = (async (_url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { host: string; envelopes: Envelope[] };
    auth.push(new Headers(init?.headers).get("authorization"));
    const a = answer(sent.length);
    sent.push({ status: a === "hang" ? 0 : a, envs: body.envelopes });
    if (a === "hang") {
      await new Promise<void>((_r, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      });
    }
    return new Response("{}", { status: a === "hang" ? 500 : a });
  }) as typeof fetch;
  return { f, sent, auth };
}

const cfg = { hubUrl: "http://127.0.0.1:9", token: "secret", host: "h" };
const fast = { pollMs: 5, batchMs: 20, heartbeatMs: 0, rng: () => 0 };

describe("R1.4 journal, seq and ack", () => {
  it("assigns seq in read order, sends the bearer token, commits on ack", async () => {
    appendSpoolLines(spoolDir(home), [line(0), line(1), line(2)]);
    const fx = fakeFetch(() => 200);
    const d = await startDaemon({ home, config: cfg, fetch: fx.f, ...fast });
    open.push(d as DaemonHandle);
    await waitFor(() => d!.pending() === 0 && d!.nextSeq() >= 4);
    const all = fx.sent.flatMap((s) => s.envs);
    expect(all.map((e) => e.seq)).toEqual([...all.keys()]);
    expect(fx.auth[0]).toBe("Bearer secret");
    const hooks = all.filter((e) => e.kind === "hook").map((e) => (e.payload as { n: number }).n);
    expect(hooks).toEqual([0, 1, 2]);
    expect(all.some((e) => e.kind === "probe")).toBe(true); // heartbeat
  });

  it("resends the journaled batch verbatim after a crash before the ack", async () => {
    appendSpoolLines(
      spoolDir(home),
      Array.from({ length: 5 }, (_, i) => line(i)),
    );
    const a = fakeFetch(() => "hang");
    const d1 = (await startDaemon({ home, config: cfg, fetch: a.f, ...fast }))!;
    await waitFor(() => a.sent.length >= 1);
    await d1.kill();
    const journal = JSON.parse(readFileSync(join(home, "daemon", "state.json"), "utf8")) as {
      next_seq: number;
      pending: { envelopes: Envelope[] };
    };
    expect(journal.next_seq).toBe(0); // nothing committed before the ack
    expect(journal.pending.envelopes.length).toBe(a.sent[0]!.envs.length);

    // More lines arrive while the daemon is down; they must queue behind the journal.
    appendSpoolLines(spoolDir(home), [line(5), line(6)]);
    const b = fakeFetch(() => 200);
    const d2 = (await startDaemon({ home, config: cfg, fetch: b.f, ...fast }))!;
    open.push(d2);
    await waitFor(() => d2.pending() === 0 && b.sent.length >= 2);
    expect(JSON.stringify(b.sent[0]!.envs)).toBe(JSON.stringify(a.sent[0]!.envs));
    const all = b.sent.flatMap((s) => s.envs);
    expect(all.map((e) => e.seq)).toEqual([...all.keys()]);
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hooks = all.filter((e) => e.kind === "hook").map((e) => (e.payload as { n: number }).n);
    expect(hooks).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("retries 5xx with backoff within the cap and never drops", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const delays: number[] = [];
    const fx = fakeFetch((n) => (n < 3 ? 503 : 200));
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      sleep: async (ms) => {
        if (ms !== fast.pollMs) delays.push(ms);
        await sleep(1);
      },
      rng: () => 0.999,
    }))!;
    open.push(d);
    await waitFor(() => d.pending() === 0 && fx.sent.length >= 4);
    expect(delays.length).toBe(3);
    for (const x of delays) expect(x).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(fx.sent[3]!.status).toBe(200);
    expect(JSON.stringify(fx.sent[3]!.envs)).toBe(JSON.stringify(fx.sent[0]!.envs));
  });

  it("moves a non-retryable 4xx batch to the rejected dir and reuses its seq", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const fx = fakeFetch((n) => (n === 0 ? 400 : 200));
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast }))!;
    open.push(d);
    await waitFor(() => fx.sent.length >= 1);
    appendSpoolLines(spoolDir(home), [line(1)]);
    await waitFor(() => fx.sent.length >= 2 && d.pending() === 0);
    const rej = readdirSync(join(home, "daemon", "rejected"));
    expect(rej).toHaveLength(1);
    expect(readFileSync(join(home, "daemon", "rejected", rej[0]!), "utf8")).toContain('"n":0');
    expect(fx.sent[1]!.envs[0]!.seq).toBe(0); // the hub never saw seq 0, so no gap
  });

  it("keeps retrying on 401 instead of dropping", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    let ok = false;
    const fx = fakeFetch(() => (ok ? 200 : 401));
    const d = (await startDaemon({
      home,
      config: cfg,
      fetch: fx.f,
      ...fast,
      sleep: (ms) => sleep(Math.min(ms, 5)),
    }))!;
    open.push(d);
    await waitFor(() => fx.sent.length >= 2);
    expect(readdirSync(join(home, "daemon", "rejected"))).toEqual([]);
    ok = true;
    await waitFor(() => d.pending() === 0);
  });

  it("holds batches while hubUrl or token is missing, then delivers", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    let c: typeof cfg | { host: string } = { host: "h" };
    const fx = fakeFetch(() => 200);
    const d = (await startDaemon({
      home,
      config: () => c,
      fetch: fx.f,
      ...fast,
      sleep: (ms) => sleep(Math.min(ms, 5)),
    }))!;
    open.push(d);
    await sleep(100);
    expect(fx.sent).toHaveLength(0);
    c = cfg;
    await waitFor(() => d.pending() === 0 && fx.sent.length >= 1);
  });

  it("caps a batch at 200 envelopes", async () => {
    appendSpoolLines(
      spoolDir(home),
      Array.from({ length: 450 }, (_, i) => line(i)),
    );
    const fx = fakeFetch(() => 200);
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, batchMs: 300 }))!;
    open.push(d);
    await waitFor(
      () => fx.sent.flatMap((s) => s.envs).filter((e) => e.kind === "hook").length === 450,
    );
    for (const s of fx.sent) expect(s.envs.length).toBeLessThanOrEqual(200);
  });
});

describe("R1.4 single instance and heartbeat", () => {
  it("a second daemon on the same home does not start", async () => {
    const fx = fakeFetch(() => 200);
    const d1 = await startDaemon({ home, config: cfg, fetch: fx.f, ...fast });
    open.push(d1!);
    expect(await startDaemon({ home, config: cfg, fetch: fx.f, ...fast })).toBeUndefined();
    await d1!.stop();
    open.pop();
    const d3 = await startDaemon({ home, config: cfg, fetch: fx.f, ...fast });
    expect(d3).toBeDefined();
    open.push(d3!);
  });

  it("takes over a stale lock left by a dead process", async () => {
    mkdirSync(join(home, "daemon"), { recursive: true });
    writeFileSync(join(home, "daemon", "daemon.lock"), "2147483000");
    const fx = fakeFetch(() => 200);
    const d = await startDaemon({ home, config: cfg, fetch: fx.f, ...fast });
    expect(d).toBeDefined();
    open.push(d!);
  });

  it("emits a probe heartbeat envelope on an interval", async () => {
    const fx = fakeFetch(() => 200);
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast, heartbeatMs: 30 }))!;
    open.push(d);
    await waitFor(
      () =>
        fx.sent
          .flatMap((s) => s.envs)
          .filter((e) => (e.payload as { type?: string }).type === "heartbeat").length >= 3,
    );
    const hb = fx.sent.flatMap((s) => s.envs).find((e) => e.kind === "probe")!;
    expect(hb.session_id).toBeNull();
    expect(hb.host).toBe("h");
  });

  it("keeps every file under the probe home", async () => {
    appendSpoolLines(spoolDir(home), [line(0)]);
    const fx = fakeFetch(() => 200);
    const d = (await startDaemon({ home, config: cfg, fetch: fx.f, ...fast }))!;
    await waitFor(() => d.pending() === 0 && d.nextSeq() > 0);
    await d.stop();
    const names = readdirSync(join(home, "daemon")).sort();
    expect(names).toContain("state.json");
    expect(names).toContain("daemon.log");
    expect(
      names.every(
        (n) =>
          ["state.json", "daemon.log", "outbox", "rejected"].includes(n) ||
          /^daemon\.lock\.\d+$/.test(n),
      ),
    ).toBe(true);
  });
});
