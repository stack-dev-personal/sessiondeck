import { afterEach, describe, expect, it } from "vitest";
import type { SessionSnapshot, StreamMessage } from "@sessiondeck/contract";
import { WebSocket } from "ws";
import { replay } from "../src/replay.ts";
import { AUTH, batch, makeHub, type TestHub } from "./support/hub.ts";
import {
  EnvSeq,
  HEADLESS_HOST,
  HEADLESS_SESSION,
  SUBAGENTS,
  SUBAGENT_ID,
  headlessWithSubagents,
  mainLines,
  subagentFileLines,
} from "./support/headless.ts";

// R2.13: subagent model and tokens from the subagent's own transcript lines (agent_id link).

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

async function sendAll(h: TestHub, seq: EnvSeq, size = 5): Promise<void> {
  for (let i = 0; i < seq.envelopes.length; i += size) {
    const r = await h.post(batch(seq.envelopes.slice(i, i + size), seq.host));
    expect(r.statusCode).toBe(200);
  }
  await h.app.hub.costFillIdle();
}

const stored = (h: TestHub): SessionSnapshot =>
  JSON.parse((h.store.getSession(HEADLESS_SESSION) as { snapshot: string }).snapshot);

describe("R2.13 headless subagents", () => {
  for (const hooksFirst of [true, false]) {
    it(`fills every row from its transcript (hooks first: ${hooksFirst})`, async () => {
      const h = await boot();
      await sendAll(h, headlessWithSubagents(hooksFirst));
      const s = stored(h);
      expect(s.subagents).toHaveLength(SUBAGENTS.length);
      for (const a of SUBAGENTS) {
        const row = s.subagents.find((r) => r.agent_id === a.id);
        expect(row, a.id).toBeDefined();
        expect(row?.model).toBe(a.model);
        expect(row?.tokens).toBe(a.tokens);
        expect(row?.figures_source).toBe("transcript");
        // No public max_input_tokens, no hard-coded windows: stays null.
        expect(row?.context_window).toBeNull();
        // Every row of the fixture transcripts states "effort":"medium" (decision 28: measured).
        expect(row?.effort).toBe("medium");
        expect(row?.ended_at).not.toBeNull();
      }
      expect(h.app.hub.reducerExceptionCount()).toBe(0);
    });
  }

  it("effort stays absent when the subagent's own rows state none (hook effort is not used)", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.hook("SubagentStart/01-subagent.json", { agent_id: SUBAGENT_ID });
    seq.transcript(
      subagentFileLines(SUBAGENT_ID).map((l) => l.replaceAll('"effort":"medium"', '"x":1')),
      60,
      SUBAGENT_ID,
    );
    seq.hook("SubagentStop/01-subagent.json", { agent_id: SUBAGENT_ID });
    await sendAll(h, seq);
    const row = stored(h).subagents[0];
    expect(row?.figures_source).toBe("transcript");
    expect(row?.effort ?? null).toBeNull();
    replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(stored(h).subagents[0]?.effort ?? null).toBeNull();
  });

  it("caps a huge subagent model, session model and effort at 120 characters", async () => {
    const h = await boot();
    const huge = "m".repeat(50_000);
    const row = (extra: object, sidechain: boolean): string =>
      JSON.stringify({
        type: "assistant",
        isSidechain: sidechain,
        gitBranch: "b",
        effort: "e".repeat(5000),
        message: {
          model: huge,
          content: [{ type: "text", text: "t" }],
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        ...extra,
      });
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.hook("SubagentStart/01-subagent.json", { agent_id: SUBAGENT_ID });
    seq.transcript([row({}, false)], 5);
    seq.transcript([row({}, true)], 5, SUBAGENT_ID);
    await sendAll(h, seq);
    const s = stored(h);
    expect(s.model?.id).toHaveLength(120);
    expect(s.model?.display_name).toHaveLength(120);
    expect(s.subagents[0]?.model).toHaveLength(120);
    expect(s.subagents[0]?.effort).toHaveLength(120);
    const live = s;
    replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(stored(h)).toEqual(live);
  });

  it("never creates a row for a transcript with no SubagentStart", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.transcript(subagentFileLines(SUBAGENT_ID), 60, SUBAGENT_ID);
    await sendAll(h, seq);
    expect(stored(h).subagents).toEqual([]);
  });

  it("incremental: a later chunk replaces the figures with the newer assistant row", async () => {
    const h = await boot();
    const all = subagentFileLines(SUBAGENT_ID);
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.hook("SubagentStart/01-subagent.json", { agent_id: SUBAGENT_ID });
    seq.transcript(all.slice(0, 50), 100, SUBAGENT_ID, 0);
    await sendAll(h, seq);
    expect(stored(h).subagents[0]?.figures_source).toBe("transcript");
    const rest = new EnvSeq(HEADLESS_HOST, HEADLESS_SESSION, 6_000_000);
    rest.transcript(all.slice(50), 100, SUBAGENT_ID, 50);
    await sendAll(h, rest);
    expect(stored(h).subagents[0]?.tokens).toBe(31_959);
  });
});

describe("R2.13 subagentStatusLine wins", () => {
  const task = {
    id: SUBAGENT_ID,
    model: "claude-opus-5-5",
    contextWindowSize: 1_000_000,
    tokenCount: 777,
  };

  function check(s: SessionSnapshot): void {
    const row = s.subagents.find((r) => r.agent_id === SUBAGENT_ID);
    expect(row).toMatchObject({
      model: "claude-opus-5-5",
      tokens: 777,
      context_window: 1_000_000,
      figures_source: "subagent_statusline",
    });
    // The other subagents are still transcript-filled.
    const other = s.subagents.find((r) => r.agent_id === SUBAGENTS[1]?.id);
    expect(other?.figures_source).toBe("transcript");
  }

  function hooks(seq: EnvSeq): void {
    seq.hook("SessionStart/01-startup.json");
    for (const a of SUBAGENTS) seq.hook("SubagentStart/01-subagent.json", { agent_id: a.id });
  }
  function lines(seq: EnvSeq): void {
    for (const a of SUBAGENTS) seq.transcript(subagentFileLines(a.id), 60, a.id);
  }

  it("statusline first, transcript later: transcript never overwrites", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    hooks(seq);
    seq.subagents("subagentStatusLine/05-rows-1.json", [task]);
    lines(seq);
    await sendAll(h, seq);
    check(stored(h));
  });

  it("transcript first, statusline later: statusline replaces and flips the source", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    hooks(seq);
    lines(seq);
    await sendAll(h, seq);
    expect(stored(h).subagents.find((r) => r.agent_id === SUBAGENT_ID)?.figures_source).toBe(
      "transcript",
    );
    const later = new EnvSeq(HEADLESS_HOST, HEADLESS_SESSION, 6_000_000);
    later.subagents("subagentStatusLine/05-rows-1.json", [task]);
    await sendAll(h, later);
    check(stored(h));
  });

  it("a statusline task that states nothing does not erase transcript figures", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    hooks(seq);
    lines(seq);
    seq.subagents("subagentStatusLine/05-rows-1.json", [{ id: SUBAGENT_ID }]);
    await sendAll(h, seq);
    const row = stored(h).subagents.find((r) => r.agent_id === SUBAGENT_ID);
    expect(row).toMatchObject({
      model: "claude-sonnet-5-5",
      tokens: 31_959,
      figures_source: "transcript",
    });
  });

  it("a partial task over transcript figures nulls the rest, live equals replay", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    hooks(seq);
    lines(seq);
    seq.subagents("subagentStatusLine/05-rows-1.json", [
      { id: SUBAGENT_ID, contextWindowSize: 200_000 },
    ]);
    await sendAll(h, seq);
    const live = stored(h);
    const row = live.subagents.find((r) => r.agent_id === SUBAGENT_ID);
    expect(row).toMatchObject({
      model: null,
      tokens: null,
      context_window: 200_000,
      figures_source: "subagent_statusline",
    });
    expect(row?.effort ?? null).toBeNull();
    replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(stored(h)).toEqual(live);
  });

  it("replay equals live with the statusline in the middle of the transcripts", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    hooks(seq);
    seq.subagents("subagentStatusLine/05-rows-1.json", [task]);
    lines(seq);
    seq.subagents("subagentStatusLine/05-rows-1.json", [
      { id: SUBAGENTS[2]?.id, tokenCount: 5, model: "claude-opus-5-5" },
    ]);
    await sendAll(h, seq);
    const live = stored(h);
    replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(stored(h)).toEqual(live);
  });
});

describe("R2.13 live delta and replay", () => {
  it("a connected client receives the subagent figures", async () => {
    const h = await boot();
    const urls = await h.listen();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.hook("SubagentStart/01-subagent.json", { agent_id: SUBAGENT_ID });
    await h.post(batch(seq.envelopes, seq.host));

    const ws = new WebSocket(`${urls.ws}/stream`, [], { headers: AUTH });
    sockets.push(ws);
    const msgs: StreamMessage[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as StreamMessage));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    while (msgs.length === 0) await new Promise((r) => setTimeout(r, 10));

    const more = new EnvSeq(HEADLESS_HOST, HEADLESS_SESSION, 6_000_000);
    more.transcript(subagentFileLines(SUBAGENT_ID), 60, SUBAGENT_ID);
    await h.post(batch(more.envelopes, more.host));
    await new Promise((r) => setTimeout(r, 50));

    const deltas = msgs.flatMap((m) => (m.type === "session" ? [m.data] : []));
    const last = deltas.at(-1) as SessionSnapshot;
    expect(last.subagents[0]).toMatchObject({
      agent_id: SUBAGENT_ID,
      model: "claude-sonnet-5-5",
      tokens: 31_959,
      figures_source: "transcript",
    });
  });

  it("replay yields the snapshot ingest produced, subagents included", async () => {
    const h = await boot();
    await sendAll(h, headlessWithSubagents(false));
    const live = stored(h);
    expect(live.subagents.every((r) => r.figures_source === "transcript")).toBe(true);
    const r = replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(r.exceptions).toBe(0);
    expect(stored(h)).toEqual(live);
  });
});

describe("R2.12 live equals replay beyond the ingest rebuild cap", () => {
  it("a text reply followed by more than 2000 text-free lines", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json", { model: "claude-fable-5-1" });
    const assistantText = JSON.stringify({
      type: "assistant",
      gitBranch: "feat/x",
      message: {
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "the early reply" }],
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    const filler = JSON.stringify({ type: "progress", data: "tool" });
    const lines = [assistantText, ...Array.from({ length: 2300 }, () => filler)];
    seq.transcript(lines, 200);
    seq.hook("Stop/01-after-ask.json");
    await sendAll(h, seq, 4);
    const live = stored(h);
    expect(live.last_assistant_message).toBe("the early reply");
    expect(live.sources?.last_assistant_message).toBe("transcript");
    replay(h.store, quiet, { maxOpenSessionsPerHost: 1000 });
    expect(stored(h)).toEqual(live);
  });
});

describe("R2.12 percent rule", () => {
  it("headless: tokens are set while window and used_pct stay null (no percent when unknown)", async () => {
    const h = await boot();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    seq.transcript(mainLines(), 100);
    await sendAll(h, seq);
    const c = stored(h).context;
    // R2.12: "if unknown, show tokens without a percent". The pricing API exposes no window.
    expect(c.input).not.toBeNull();
    expect(c.window).toBeNull();
    expect(c.used_pct).toBeNull();
  });
});
