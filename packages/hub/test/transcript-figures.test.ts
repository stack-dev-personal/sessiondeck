import { afterEach, describe, expect, it } from "vitest";
import type { SessionSnapshot, StreamMessage } from "@sessiondeck/contract";
import { WebSocket } from "ws";
import { replay } from "../src/replay.ts";
import { AUTH, batch, makeHub, type TestHub } from "./support/hub.ts";
import {
  EnvSeq,
  HEADLESS_BRANCH,
  HEADLESS_CONTEXT_TOKENS,
  HEADLESS_HOST,
  HEADLESS_MODEL,
  HEADLESS_SESSION,
  headlessSession,
  mainLines,
} from "./support/headless.ts";

const NOW = 1_800_000_000_000;
let hub: TestHub | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const w of sockets.splice(0)) w.terminate();
  await hub?.cleanup();
  hub = undefined;
});

const quiet = { info: () => undefined, warn: () => undefined };

async function boot(): Promise<TestHub> {
  hub = await makeHub({}, () => NOW);
  return hub;
}

async function snapshot(h: TestHub, id = HEADLESS_SESSION): Promise<SessionSnapshot> {
  const r = await h.app.inject({ method: "GET", url: `/sessions/${id}`, headers: AUTH });
  expect(r.statusCode).toBe(200);
  return r.json<SessionSnapshot>();
}

async function sendAll(h: TestHub, seq: EnvSeq): Promise<void> {
  for (let i = 0; i < seq.envelopes.length; i += 5) {
    const r = await h.post(batch(seq.envelopes.slice(i, i + 5), seq.host));
    expect(r.statusCode).toBe(200);
  }
  await h.app.hub.costFillIdle();
}

describe("R2.12 headless session, no statusline", () => {
  it("fills model, context tokens, cost, branch and last message from the transcript", async () => {
    const h = await boot();
    await sendAll(h, headlessSession());
    const s = await snapshot(h);

    expect(s.model).toEqual({ id: HEADLESS_MODEL, display_name: HEADLESS_MODEL });
    expect(s.context).toEqual({
      used_pct: null,
      window: null,
      input: HEADLESS_CONTEXT_TOKENS,
      output: null,
    });
    expect(s.git.branch).toBe(HEADLESS_BRANCH);
    expect(s.last_assistant_message).toBeTypeOf("string");
    expect(s.last_assistant_message).not.toBe("<TEXT 1792>"); // the Stop hook did not displace it
    expect(s.last_assistant_message?.length).toBeLessThanOrEqual(2000);

    const cost = await h.app.inject({
      method: "GET",
      url: `/sessions/${HEADLESS_SESSION}/cost`,
      headers: AUTH,
    });
    const usd = cost.json<{ cost_usd: number }>().cost_usd;
    expect(usd).toBeGreaterThan(0);
    expect(s.cost.usd).toBe(usd);

    expect(s.sources).toEqual({
      model: "transcript",
      context: "transcript",
      cost: "transcript",
      git_branch: "transcript",
      last_assistant_message: "transcript",
    });
    expect(s.effort).toBeNull(); // measured figures only
  });

  it("ignores malformed lines without failing the batch", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.transcript(['{"type":"assistant", broken', ...mainLines().slice(0, 30)], 50);
    await sendAll(h, seq);
    expect((await snapshot(h)).git.branch).toBe(HEADLESS_BRANCH);
    expect(h.app.hub.reducerExceptionCount()).toBe(0);
    expect(
      h.logLines().some((l) => l["msg"] === "transcript lines with unparseable JSON ignored"),
    ).toBe(true);
  });

  it("derives once the session exists when transcript lines arrive before SessionStart", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.transcript(mainLines(), 100);
    seq.hook("SessionStart/01-startup.json");
    await sendAll(h, seq);
    const s = await snapshot(h);
    expect(s.model?.id).toBe(HEADLESS_MODEL);
    expect(s.git.branch).toBe(HEADLESS_BRANCH);
    expect(s.sources?.model).toBe("transcript");
  });

  it("derives from lines delivered out of order", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    const all = mainLines();
    const tail = all.slice(100);
    seq.transcript(tail, 200, undefined, 100);
    seq.transcript(all.slice(0, 100), 200, undefined, 0);
    await sendAll(h, seq);
    expect((await snapshot(h)).context.input).toBe(HEADLESS_CONTEXT_TOKENS);
  });
});

describe("R2.12 statusline wins", () => {
  it("never overwrites statusline values, and keeps their sources", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.statusline("statusLine/03-first-tick.json", {
      worktree: { branch: "feat/live", name: "w" },
    });
    await sendAll(h, seq);
    const before = await snapshot(h);
    expect(before.sources?.model).toBe("statusline");
    expect(before.sources?.context).toBe("statusline");
    expect(before.sources?.git_branch).toBe("statusline");

    const more = new EnvSeq(HEADLESS_HOST, HEADLESS_SESSION, 6_000_000);
    more.transcript(mainLines(), 100);
    await sendAll(h, more);
    const after = await snapshot(h);
    expect(after.model).toEqual(before.model);
    expect(after.context).toEqual(before.context);
    expect(after.cost).toEqual(before.cost);
    expect(after.git.branch).toBe("feat/live");
    expect(after.sources?.model).toBe("statusline");
    expect(after.sources?.context).toBe("statusline");
    expect(after.sources?.cost).toBe(before.sources?.cost);
    expect(after.sources?.git_branch).toBe("statusline");
    // Fields the statusline never carries are still filled.
    expect(after.sources?.last_assistant_message).toBe("transcript");
  });

  it("a later statusline replaces transcript-filled figures and flips the source", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.transcript(mainLines(), 100);
    await sendAll(h, seq);
    const first = await snapshot(h);
    expect(first.sources?.model).toBe("transcript");
    expect(first.cost.usd).toBeGreaterThan(0);

    const later = new EnvSeq(HEADLESS_HOST, HEADLESS_SESSION, 6_000_000);
    later.statusline("statusLine/03-first-tick.json", {
      worktree: { branch: "feat/live", name: "w" },
    });
    await sendAll(h, later);
    const s = await snapshot(h);
    expect(s.sources?.model).toBe("statusline");
    expect(s.sources?.context).toBe("statusline");
    expect(s.sources?.git_branch).toBe("statusline");
    expect(s.model?.id).not.toBe(HEADLESS_MODEL);
    expect(s.git.branch).toBe("feat/live");
    // The statusline context object replaces the transcript tokens wholesale.
    expect(s.context.input).not.toBe(HEADLESS_CONTEXT_TOKENS);
  });
});

describe("R2.12 live delta", () => {
  it("a connected client receives the transcript-filled figures, cost included", async () => {
    const h = await boot();
    const urls = await h.listen();
    const seq = headlessSession();
    // The session exists (hooks) before the client connects; transcript arrives afterwards.
    const hooks = seq.envelopes.slice(0, 2);
    await h.post(batch(hooks, seq.host));

    const ws = new WebSocket(`${urls.ws}/stream`, [], { headers: AUTH });
    sockets.push(ws);
    const msgs: StreamMessage[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as StreamMessage));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    while (msgs.length === 0) await new Promise((r) => setTimeout(r, 10));

    for (let i = 2; i < seq.envelopes.length; i += 5) {
      await h.post(batch(seq.envelopes.slice(i, i + 5), seq.host));
    }
    await h.app.hub.costFillIdle();
    await new Promise((r) => setTimeout(r, 50));

    const deltas = msgs.flatMap((m) => (m.type === "session" ? [m.data] : []));
    const withFigures = deltas.filter((d) => d.model?.id === HEADLESS_MODEL);
    expect(withFigures.length).toBeGreaterThan(0);
    const last = deltas.at(-1) as SessionSnapshot;
    expect(last.context.input).toBe(HEADLESS_CONTEXT_TOKENS);
    expect(last.git.branch).toBe(HEADLESS_BRANCH);
    expect(last.cost.usd).toBeGreaterThan(0);
    expect(last.sources?.cost).toBe("transcript");
  });
});

describe("R2.9 replay equality", () => {
  it("replay yields the snapshot ingest produced", async () => {
    const h = await boot();
    await sendAll(h, headlessSession());
    const live = await h.store.getSession(HEADLESS_SESSION);
    expect(live).toBeDefined();
    const before = JSON.parse((live as { snapshot: string }).snapshot) as SessionSnapshot;
    expect(before.cost.usd).toBeGreaterThan(0);

    const r = replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(r.exceptions).toBe(0);
    const after = JSON.parse(
      (h.store.getSession(HEADLESS_SESSION) as { snapshot: string }).snapshot,
    ) as SessionSnapshot;
    expect(after).toEqual(before);
  });

  it("replay keeps statusline sources and values", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.transcript(mainLines(), 100);
    seq.statusline("statusLine/03-first-tick.json");
    await sendAll(h, seq);
    const before = JSON.parse(
      (h.store.getSession(HEADLESS_SESSION) as { snapshot: string }).snapshot,
    ) as SessionSnapshot;
    replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    const after = JSON.parse(
      (h.store.getSession(HEADLESS_SESSION) as { snapshot: string }).snapshot,
    ) as SessionSnapshot;
    expect(after).toEqual(before);
  });
});
