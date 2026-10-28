import { describe, expect, it } from "vitest";
import {
  HANDLED_ROW_KINDS,
  capRaw,
  ROW_KIND_REGISTRY,
  countRowKinds,
  normalizeTranscript,
  parseJsonl,
  rowKind,
} from "../src/normalize";
import type { MessageSegment, ToolCall, UnifiedMessage } from "../src/transcript";
import { fixtureNames, loadTranscript, optionsOf } from "./normalize-helpers";
import type { TranscriptFixture } from "./normalize-helpers";

// ---- synthetic row builders ------------------------------------------------------------------------------
let n = 0;
const ts = () => `2026-01-01T00:00:${String(n++ % 60).padStart(2, "0")}.000Z`;
function user(uuid: string, parent: string | null, content: unknown, extra: object = {}) {
  return {
    type: "user",
    uuid,
    parentUuid: parent,
    isSidechain: false,
    timestamp: ts(),
    message: { role: "user", content },
    ...extra,
  };
}
function asst(
  uuid: string,
  parent: string | null,
  mid: string,
  blocks: unknown[],
  extra: object = {},
) {
  return {
    type: "assistant",
    uuid,
    parentUuid: parent,
    isSidechain: false,
    timestamp: ts(),
    requestId: "req_1",
    message: {
      id: mid,
      role: "assistant",
      model: "m",
      content: blocks,
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    ...extra,
  };
}
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name = "Bash", input: unknown = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (id: string, content: unknown, extra: object = {}) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...extra,
});

const textsOf = (m: UnifiedMessage) =>
  m.segments.flatMap((s) => (s.type === "text" ? [s.content] : []));
const allTexts = (ms: UnifiedMessage[]) => ms.flatMap(textsOf);
const calls = (ms: UnifiedMessage[]): ToolCall[] =>
  ms.flatMap((m) =>
    m.segments.flatMap((s: MessageSegment) => (s.type === "tool_call" ? [s.tool] : [])),
  );
/** Calls of the main list and, recursively, of every nested subagent thread. */
const deepCalls = (ms: UnifiedMessage[]): ToolCall[] =>
  calls(ms).flatMap((c) => [c, ...(c.subagent ? deepCalls(c.subagent.messages) : [])]);

// ---- R4.1 ------------------------------------------------------------------------------------------------
describe("R4.1 row coverage", () => {
  const fixtures = fixtureNames().map((name) => loadTranscript(name));

  it("has unique kinds in the registry and a disposition for each", () => {
    expect(new Set(HANDLED_ROW_KINDS).size).toBe(HANDLED_ROW_KINDS.length);
    for (const r of ROW_KIND_REGISTRY) {
      expect(["conversation", "system", "internal"]).toContain(r.disposition);
      expect(r.doc.length).toBeGreaterThan(0);
    }
  });

  it.each(fixtures.map((f) => [f.name, f] as const))("%s: no unknown kinds", (_name, fx) => {
    const counts = countRowKinds(fx.main, fx.subagents);
    expect(counts.unknown).toEqual({});
    expect(counts.unknownCount).toBe(0);
    expect(counts.total).toBeGreaterThan(0);
  });

  it("every registry kind is exercised by some fixture, and the fixtures use nothing else", () => {
    const seen = new Set<string>();
    for (const fx of fixtures) {
      for (const k of Object.keys(countRowKinds(fx.main, fx.subagents).handled)) seen.add(k);
    }
    expect([...seen].sort()).toEqual([...HANDLED_ROW_KINDS].sort());
  });

  it("raw messages never appear for fixture rows", () => {
    for (const fx of fixtures) {
      const raws = JSON.stringify(normalizeTranscript(fx.main, optionsOf(fx))).match(
        /"type":"raw"/g,
      );
      expect(raws, fx.name).toBeNull();
    }
  });

  it("renders an unknown row type as a raw message with a visible label", () => {
    const row = {
      type: "future-kind",
      uuid: "u1",
      parentUuid: null,
      timestamp: "t",
      payload: { a: 1 },
    };
    const [m] = normalizeTranscript([row]);
    expect(m?.role).toBe("system");
    expect(m?.metadata?.rawType).toBe("future-kind");
    expect(m?.segments[0]).toEqual({
      type: "raw",
      label: "unknown row type: future-kind",
      data: row,
    });
  });

  it("renders unknown subtypes, attachment types and content blocks as raw", () => {
    const rows = [
      { type: "system", subtype: "new_thing", uuid: "a", parentUuid: null, timestamp: "t" },
      {
        type: "attachment",
        uuid: "b",
        parentUuid: "a",
        timestamp: "t",
        attachment: { type: "new_att" },
      },
      asst("c", "b", "m1", [{ type: "image_gen", x: 1 }, text("hi")]),
      user("d", "c", [{ type: "image", source: {} }]),
    ];
    const ms = normalizeTranscript(rows);
    expect(ms.map((m) => m.metadata?.rawType)).toEqual([
      "system:new_thing",
      "attachment:new_att",
      undefined,
      undefined,
    ]);
    const labels = ms.flatMap((m) =>
      m.segments.flatMap((s) => (s.type === "raw" ? [s.label] : [])),
    );
    expect(labels).toEqual([
      "unknown row type: system:new_thing",
      "unknown row type: attachment:new_att",
      "content block: image_gen",
      "content block: image",
    ]);
    expect(countRowKinds(rows).unknown).toEqual({ "system:new_thing": 1, "attachment:new_att": 1 });
  });

  it("does not throw on malformed input", () => {
    const input: unknown[] = [
      "{not json",
      "42",
      "",
      42,
      null,
      [1, 2],
      { type: "assistant", uuid: "x" },
      { type: "user", uuid: "y", message: 5 },
      { type: "attachment", uuid: "z", attachment: "nope" },
      { no: "type" },
      { type: "assistant", uuid: "w", message: { content: [null, 3, { type: "tool_use" }] } },
    ];
    let ms: UnifiedMessage[] = [];
    expect(() => {
      ms = normalizeTranscript(input);
    }).not.toThrow();
    expect(ms.length).toBeGreaterThan(0);
    const bad = ms.find((m) => m.metadata?.rawType === "unparseable");
    expect(bad?.segments[0]).toMatchObject({ type: "raw", label: "unparseable line" });
    expect(() => countRowKinds(input)).not.toThrow();
    expect(rowKind(null)).toBe("non-object");
  });

  it("parses JSONL text, keeping unparseable lines as strings", () => {
    expect(parseJsonl('{"a":1}\r\n\nbroken\n[1]')).toEqual([{ a: 1 }, "broken", [1]]);
  });

  it("shows a truncation note only for large tool results stored on the laptop", () => {
    const rows = [
      asst("a", null, "m1", [toolUse("t1")]),
      user("b", "a", [
        toolResult(
          "t1",
          "<persisted-output>\nOutput too large (69.5KB). Full output saved to: /x/tool-results/abc.txt\n\nPreview:\nSECRET-BODY",
        ),
      ]),
    ];
    const [call] = calls(normalizeTranscript(rows));
    expect(call?.result?.truncation).toEqual({
      sizeLabel: "69.5KB",
      path: "/x/tool-results/abc.txt",
    });
    expect(call?.result?.content).toBe(
      "Large output (69.5KB) stored on the laptop: /x/tool-results/abc.txt",
    );
    expect(call?.result?.content).not.toContain("SECRET-BODY");
  });

  it("finds persisted-output notes in the fixtures", () => {
    let found = 0;
    for (const fx of fixtureNames().map(loadTranscript)) {
      found += deepCalls(normalizeTranscript(fx.main, optionsOf(fx))).filter(
        (c) => c.result?.truncation,
      ).length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it("pairs results with calls, keeps errors, and surfaces unpaired results", () => {
    const rows = [
      asst("a", null, "m1", [toolUse("t1"), toolUse("t2")]),
      user(
        "b",
        "a",
        [
          toolResult(
            "t1",
            [
              { type: "text", text: "one" },
              { type: "tool_reference", tool_name: "X" },
            ],
            { is_error: true },
          ),
        ],
        { toolDenialKind: "user-rejected" },
      ),
      user("c", "b", [toolResult("t9", "stray")]),
    ];
    const ms = normalizeTranscript(rows);
    const [c1, c2] = calls(ms);
    expect(c1?.result).toMatchObject({
      content: "one\n[tool: X]",
      is_error: true,
      denial: "user-rejected",
    });
    expect(c2?.result).toBeUndefined();
    const stray = ms.flatMap((m) => m.segments).find((s) => s.type === "tool_result");
    expect(stray).toMatchObject({
      type: "tool_result",
      result: { toolCallId: "t9", content: "stray" },
    });
    // The paired carrier row produces no message; only the stray one does.
    expect(ms.filter((m) => m.role === "user").map((m) => m.id)).toEqual(["c"]);
  });

  it("classifies injected user rows as system messages", () => {
    const rows = [
      user("a", null, "<local-command-stdout>ok</local-command-stdout>"),
      user("b", "a", "<task-notification>x</task-notification>", {
        origin: { kind: "task-notification" },
      }),
      user("c", "b", "This session is being continued", { isCompactSummary: true }),
      user("d", "c", [text("[Request interrupted by user]")]),
      user("e", "d", "do the thing", { origin: { kind: "human" } }),
    ];
    expect(normalizeTranscript(rows).map((m) => [m.role, m.metadata?.systemSubtype])).toEqual([
      ["system", "local_command"],
      ["system", "origin_task_notification"],
      ["system", "compact_summary"],
      ["system", "interrupted"],
      ["user", undefined],
    ]);
  });
});

// ---- streaming -------------------------------------------------------------------------------------------
describe("streaming rows with a repeated message.id replace, not append", () => {
  it("replaces a block repeated at the same apiBlockIndex", () => {
    const rows = [
      asst("a1", null, "m1", [text("he")], { apiBlockIndex: 0 }),
      asst("a2", "a1", "m1", [text("hello")], { apiBlockIndex: 0 }),
    ];
    const ms = normalizeTranscript(rows);
    expect(ms).toHaveLength(1);
    expect(allTexts(ms)).toEqual(["hello"]);
  });

  it("replaces cumulative rows that carry no block index", () => {
    const rows = [
      asst("a1", null, "m1", [text("a")]),
      asst("a2", "a1", "m1", [text("a b"), toolUse("t1")]),
    ];
    const ms = normalizeTranscript(rows);
    expect(ms).toHaveLength(1);
    expect(ms[0]?.segments.map((s) => s.type)).toEqual(["text", "tool_call"]);
    expect(allTexts(ms)).toEqual(["a b"]);
  });

  it("merges one-block-per-row messages in block order and counts usage once", () => {
    const rows = [
      asst("a1", null, "m1", [{ type: "thinking", thinking: "t" }], { apiBlockIndex: 0 }),
      asst("a2", "a1", "m1", [text("x")], { apiBlockIndex: 1 }),
      asst("a3", "a2", "m1", [toolUse("t1")], { apiBlockIndex: 2 }),
    ];
    const ms = normalizeTranscript(rows);
    expect(ms).toHaveLength(1);
    expect(ms[0]?.id).toBe("m1");
    expect(ms[0]?.segments.map((s) => s.type)).toEqual(["thinking", "text", "tool_call"]);
    expect(ms[0]?.metadata?.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("keeps messages with different message ids apart and a re-sent uuid once", () => {
    const rows = [
      asst("a1", null, "m1", [text("x")]),
      asst("a2", "a1", "m2", [text("y")]),
      asst("a2", "a1", "m2", [text("y")]),
    ];
    expect(allTexts(normalizeTranscript(rows))).toEqual(["x", "y"]);
  });

  it.each(fixtureNames())("%s: one message per message.id in the main list", (name) => {
    const fx = loadTranscript(name);
    const ids = normalizeTranscript(fx.main, optionsOf(fx))
      .filter((m) => m.role === "assistant")
      .map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rowIds = new Set(
      fx.main.flatMap((r) => {
        const row = r as { type?: string; message?: { id?: string } };
        return row.type === "assistant" && row.message?.id ? [row.message.id] : [];
      }),
    );
    expect(ids.length).toBeLessThanOrEqual(rowIds.size);
  });
});

// ---- R4.2 ------------------------------------------------------------------------------------------------
describe("R4.2 branch pruning", () => {
  it("keeps only the latest branch of an edited prompt", () => {
    const rows = [
      user("u0", null, "first"),
      asst("a1", "u0", "m1", [text("ok")]),
      user("u2", "a1", "old wording"),
      asst("a2", "u2", "m2", [text("answer to old")]),
      user("u3", "a1", "edited wording"),
      asst("a3", "u3", "m3", [text("answer to edited")]),
    ];
    expect(allTexts(normalizeTranscript(rows))).toEqual([
      "first",
      "ok",
      "edited wording",
      "answer to edited",
    ]);
  });

  it("follows the branch holding the latest leaf, not the later sibling in the file", () => {
    const rows = [
      user("u0", null, "first"),
      user("u1", "u0", "A"),
      user("u2", "u0", "B"),
      asst("a1", "u1", "m1", [text("on A")]),
    ];
    expect(allTexts(normalizeTranscript(rows))).toEqual(["first", "A", "on A"]);
  });

  it("does not treat parallel tool calls as branches", () => {
    const rows = [
      user("u0", null, "go"),
      asst("a1", "u0", "m1", [toolUse("t1")], { apiBlockIndex: 0 }),
      asst("a2", "a1", "m1", [toolUse("t2")], { apiBlockIndex: 1 }),
      user("r1", "a1", [toolResult("t1", "one")]),
      user("r2", "a2", [toolResult("t2", "two")]),
    ];
    const cs = calls(normalizeTranscript(rows));
    expect(cs.map((c) => c.result?.content)).toEqual(["one", "two"]);
  });

  it("walks through logicalParentUuid across a compaction", () => {
    const rows = [
      user("u0", null, "before"),
      asst("a1", "u0", "m1", [text("early")]),
      user("u2", "a1", "dup A"),
      user("u3", "a1", "dup B"),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "u3",
        timestamp: "t",
        content: "Conversation compacted",
      },
      user("s", "cb", "summary", { isCompactSummary: true }),
      user("u4", "s", "after"),
    ];
    const ms = normalizeTranscript(rows);
    expect(allTexts(ms)).toEqual(["before", "early", "dup B", "summary", "after"]);
    expect(ms.map((m) => m.metadata?.divider === true)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("fixture 04-compaction holds a real re-sent prompt; the earlier branch is dropped", () => {
    const fx = loadTranscript("04-compaction");
    const ids = new Set(normalizeTranscript(fx.main).map((m) => m.id));
    const prompts = fx.main.filter((r) => {
      const row = r as { type?: string; message?: { content?: unknown } };
      return row.type === "user" && row.message?.content === "continue, resume.";
    }) as { uuid: string }[];
    expect(prompts.map((p) => p.uuid)).toEqual([
      "352b7e42-8df4-4954-a701-b9d7caaa4e12",
      "37047799-036d-4af9-ac33-062e68fd9227",
    ]);
    expect(ids.has("352b7e42-8df4-4954-a701-b9d7caaa4e12")).toBe(false);
    expect(ids.has("37047799-036d-4af9-ac33-062e68fd9227")).toBe(true);
  });

  it.each(["01-subagents", "02-subagents-compaction", "03-compaction", "05-subagents"])(
    "%s has no prompt branch: every typed prompt is shown",
    (name) => {
      const fx = loadTranscript(name);
      const ids = new Set(normalizeTranscript(fx.main, optionsOf(fx)).map((m) => m.id));
      const prompts = fx.main.filter((r) => {
        const row = r as {
          type?: string;
          isMeta?: boolean;
          isCompactSummary?: boolean;
          origin?: { kind?: string };
          message?: { content?: string };
        };
        const kind = row.origin?.kind;
        const human = kind === undefined || kind === "human";
        const body = row.message?.content;
        return (
          row.type === "user" &&
          row.isMeta !== true &&
          !row.isCompactSummary &&
          human &&
          typeof body === "string" &&
          !body.startsWith("<")
        );
      }) as { uuid: string }[];
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) expect(ids.has(p.uuid), p.uuid).toBe(true);
    },
  );

  it("keeps every tool result of every fixture (none lost to pruning)", () => {
    for (const name of fixtureNames()) {
      const fx = loadTranscript(name);
      const ms = normalizeTranscript(fx.main, optionsOf(fx));
      const paired = calls(ms).filter((c) => c.result).length;
      const stray = ms.flatMap((m) => m.segments).filter((s) => s.type === "tool_result").length;
      let blocks = 0;
      for (const r of fx.main) {
        const row = r as { type?: string; message?: { content?: unknown } };
        if (row.type === "user" && Array.isArray(row.message?.content)) {
          blocks += row.message.content.filter(
            (b: { type?: string }) => b.type === "tool_result",
          ).length;
        }
      }
      // 04 drops one superseded prompt branch (no tool results in it); the others lose nothing.
      expect(paired + stray, name).toBe(blocks);
    }
  });
});

// ---- R4.3 ------------------------------------------------------------------------------------------------
describe("R4.3 subagent threads", () => {
  function agentCalls(fx: TranscriptFixture) {
    return calls(normalizeTranscript(fx.main, optionsOf(fx))).filter(
      (c) => c.name === "Agent" || c.name === "Task",
    );
  }

  it.each(["01-subagents", "05-subagents", "02-subagents-compaction"])(
    "%s: threads nest under their spawning call",
    (name) => {
      const fx = loadTranscript(name);
      const ms = normalizeTranscript(fx.main, optionsOf(fx));
      const nested = agentCalls(fx).filter((c) => c.subagent);
      expect(nested.length).toBeGreaterThan(0);
      const wanted = Object.keys(fx.subagents).sort();
      expect(nested.map((c) => c.subagent?.agentId).sort()).toEqual(wanted);
      expect(ms.some((m) => m.metadata?.systemSubtype === "orphan_subagent")).toBe(false);
      for (const c of nested) {
        const t = c.subagent;
        expect(t?.messages.length).toBeGreaterThan(0);
        expect(t?.assistantMessageCount).toBeGreaterThan(0);
        expect(t?.usage.output_tokens).toBeGreaterThan(0);
        expect(t?.contextTokens).toBeGreaterThan(0);
        // The spawning call's own result is paired and names the same agent.
        expect(c.result).toBeDefined();
      }
    },
  );

  it.each(["01-subagents", "05-subagents"])(
    "%s: the subagent's own figures match its rows",
    (name) => {
      const fx = loadTranscript(name);
      for (const c of agentCalls(fx)) {
        const t = c.subagent;
        if (!t) continue;
        const rows = (fx.subagents[t.agentId] ?? []) as {
          type?: string;
          isApiErrorMessage?: boolean;
          message?: { id?: string; usage?: Record<string, number> };
        }[];
        const byId = new Map<string, Record<string, number>>();
        for (const r of rows) {
          if (r.type === "assistant" && !r.isApiErrorMessage && r.message?.id && r.message.usage)
            byId.set(r.message.id, r.message.usage);
        }
        let out = 0;
        for (const u of byId.values()) out += u.output_tokens ?? 0;
        expect(t.usage.output_tokens, t.agentId).toBe(out);
        expect(t.assistantMessageCount).toBe(byId.size);
        const last = [...byId.values()].pop() ?? {};
        expect(t.contextTokens).toBe(
          (last.input_tokens ?? 0) +
            (last.cache_read_input_tokens ?? 0) +
            (last.cache_creation_input_tokens ?? 0),
        );
      }
    },
  );

  it.each(["01-subagents", "05-subagents"])(
    "%s: context size plus last output equals what the parent's result reported",
    (name) => {
      const fx = loadTranscript(name);
      let checked = 0;
      for (const c of agentCalls(fx)) {
        const t = c.subagent;
        if (t?.reported?.totalTokens === undefined) continue;
        const last = t.messages.filter((m) => m.role === "assistant" && m.metadata?.usage).at(-1);
        expect(t.contextTokens + (last?.metadata?.usage?.output_tokens ?? 0), t.agentId).toBe(
          t.reported.totalTokens,
        );
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    },
  );

  it.each(["01-subagents", "05-subagents"])(
    "%s: sidechain rows stay out of the main list",
    (name) => {
      const fx = loadTranscript(name);
      const ms = normalizeTranscript(fx.main, optionsOf(fx));
      const subUuids = new Set(
        Object.values(fx.subagents).flatMap((rows) =>
          rows.flatMap((r) =>
            (r as { uuid?: string }).uuid ? [(r as { uuid: string }).uuid] : [],
          ),
        ),
      );
      expect(subUuids.size).toBeGreaterThan(0);
      for (const m of ms) expect(subUuids.has(m.id), m.id).toBe(false);
      // subagent messages are tagged with their agent id
      const t = agentCalls(fx).find((c) => c.subagent)?.subagent;
      expect(t?.messages.every((m) => m.metadata?.agent === t.agentId)).toBe(true);
    },
  );

  it("separates isSidechain rows found in the main input and groups them by agent id", () => {
    const rows = [
      user("u0", null, "go"),
      asst("a1", "u0", "m1", [toolUse("t1", "Agent", { description: "d", subagent_type: "x" })]),
      user("r1", "a1", [toolResult("t1", "done")], {
        toolUseResult: { agentId: "ag1", status: "completed", totalTokens: 7 },
      }),
      { ...user("s0", null, "sub prompt"), isSidechain: true, agentId: "ag1" },
      { ...asst("s1", "s0", "sm1", [text("sub answer")]), isSidechain: true, agentId: "ag1" },
    ];
    const ms = normalizeTranscript(rows);
    expect(allTexts(ms)).toEqual(["go"]);
    const call = calls(ms)[0];
    expect(call?.subagent?.agentId).toBe("ag1");
    expect(call?.subagent?.agentType).toBe("x");
    expect(call?.subagent?.description).toBe("d");
    expect(call?.subagent?.reported).toEqual({ status: "completed", totalTokens: 7 });
    expect(allTexts(call?.subagent?.messages ?? [])).toEqual(["sub prompt", "sub answer"]);
  });

  it("links a thread through agent meta when the call has no result yet, and shows orphan threads", () => {
    const rows = [user("u0", null, "go"), asst("a1", "u0", "m1", [toolUse("t1", "Agent")])];
    const sub = {
      ag1: [{ ...user("s0", null, "p"), isSidechain: true }],
      ag2: [{ ...user("q0", null, "q"), isSidechain: true }],
    };
    const ms = normalizeTranscript(rows, {
      subagents: sub,
      subagentMeta: { ag1: { toolUseId: "t1", agentType: "T" } },
    });
    expect(calls(ms)[0]?.subagent).toMatchObject({ agentId: "ag1", agentType: "T" });
    const orphan = ms.at(-1);
    expect(orphan?.metadata?.systemSubtype).toBe("orphan_subagent");
    expect(calls([orphan as UnifiedMessage])[0]?.subagent?.agentId).toBe("ag2");
  });

  it("survives a cyclic spawn graph", () => {
    const agentCall = (id: string, other: string) => [
      { ...asst(`${id}a`, null, `m${id}`, [toolUse(`t${id}`, "Agent")]), isSidechain: true },
      {
        ...user(`${id}r`, `${id}a`, [toolResult(`t${id}`, "x")], {
          toolUseResult: { agentId: other },
        }),
        isSidechain: true,
      },
    ];
    const rows = [
      asst("a1", null, "m1", [toolUse("t0", "Agent")]),
      user("r1", "a1", [toolResult("t0", "x")], { toolUseResult: { agentId: "A" } }),
    ];
    expect(() =>
      normalizeTranscript(rows, { subagents: { A: agentCall("A", "B"), B: agentCall("B", "A") } }),
    ).not.toThrow();
  });
});

// ---- compaction ------------------------------------------------------------------------------------------
describe("compaction boundaries", () => {
  it.each([
    ["02-subagents-compaction", 1],
    ["03-compaction", 1],
    ["04-compaction", 2],
  ])("%s renders %i divider(s) with earlier history before each", (name, count) => {
    const fx = loadTranscript(name);
    const ms = normalizeTranscript(fx.main, optionsOf(fx));
    const dividers = ms.filter((m) => m.metadata?.divider === true);
    expect(dividers).toHaveLength(count);
    for (const d of dividers) {
      expect(d.role).toBe("system");
      expect(d.metadata?.systemSubtype).toBe("compact_boundary");
      expect(d.segments[0]).toMatchObject({
        type: "system_info",
        info: { subtype: "compact_boundary", message: "Conversation compacted" },
      });
      expect(d.metadata?.compact).toMatchObject({ trigger: "auto" });
      const at = ms.indexOf(d);
      expect(ms.slice(0, at).filter((m) => m.role === "assistant").length).toBeGreaterThan(10);
      expect(ms[at + 1]?.metadata?.systemSubtype).toBe("compact_summary");
    }
  });

  it("fixtures without a compaction have no divider", () => {
    for (const name of ["01-subagents", "05-subagents"]) {
      const fx = loadTranscript(name);
      expect(normalizeTranscript(fx.main, optionsOf(fx)).some((m) => m.metadata?.divider)).toBe(
        false,
      );
    }
  });
});

// ---- review fixes (iteration 1) --------------------------------------------------------------------------
const lastPrompt = (leafUuid: string) => ({ type: "last-prompt", lastPrompt: "x", leafUuid });
const queued = (uuid: string, parent: string | null, prompt: string) => ({
  type: "attachment",
  uuid,
  parentUuid: parent,
  isSidechain: false,
  timestamp: ts(),
  attachment: { type: "queued_command", prompt },
});
const compactBoundary = (uuid: string, logicalParent: string) => ({
  type: "system",
  subtype: "compact_boundary",
  uuid,
  parentUuid: null,
  logicalParentUuid: logicalParent,
  isSidechain: false,
  timestamp: ts(),
  content: "Conversation compacted",
  compactMetadata: { trigger: "auto" },
});

describe("review fixes: branch choice", () => {
  it("last-prompt leafUuid wins over the file-order leaf (background agent append)", () => {
    const rows = [
      user("u0", null, "root"),
      user("p1", "u0", "original prompt"),
      asst("a1", "p1", "m1", [text("answer one")]),
      user("p2", "u0", "edited prompt"),
      asst("a2", "p2", "m2", [text("answer two")]),
      // a background agent finished later and appended under the abandoned branch
      user("bg", "a1", "<task-notification>done", { isMeta: true }),
      lastPrompt("a2"),
    ];
    const t = allTexts(normalizeTranscript(rows));
    expect(t).toContain("edited prompt");
    expect(t).toContain("answer two");
    expect(t).not.toContain("original prompt");
    expect(t).not.toContain("answer one");
    // without the pointer the old heuristic applies
    const guessed = allTexts(normalizeTranscript(rows.slice(0, -1)));
    expect(guessed).toContain("original prompt");
  });

  it("ignores a last-prompt whose leaf is not in the file", () => {
    const rows = [
      user("u0", null, "root"),
      user("p1", "u0", "first"),
      user("p2", "u0", "second"),
      lastPrompt("missing"),
    ];
    const t = allTexts(normalizeTranscript(rows));
    expect(t).toContain("second");
    expect(t).not.toContain("first");
  });

  it("a fork across a compaction drops the compacted tail of the losing branch", () => {
    const rows = [
      user("u0", null, "root"),
      user("p1", "u0", "old prompt"),
      asst("a1", "p1", "m1", [text("old answer")]),
      compactBoundary("cb", "a1"),
      user("sum", "cb", "summary of old", { isCompactSummary: true }),
      asst("a2", "sum", "m2", [text("old after compaction")]),
      user("p2", "u0", "new prompt"),
      asst("a3", "p2", "m3", [text("new answer")]),
      lastPrompt("a3"),
    ];
    const ms = normalizeTranscript(rows);
    const t = allTexts(ms);
    expect(t).toEqual(expect.arrayContaining(["root", "new prompt", "new answer"]));
    for (const gone of ["old prompt", "old answer", "summary of old", "old after compaction"])
      expect(t).not.toContain(gone);
    expect(ms.some((m) => m.metadata?.divider === true)).toBe(false);
  });

  it("a queued_command prompt counts as a prompt in fork detection", () => {
    const rows = [
      user("u0", null, "root"),
      queued("q1", "u0", "queued first"),
      asst("a1", "q1", "m1", [text("first answer")]),
      queued("q2", "u0", "queued second"),
      asst("a2", "q2", "m2", [text("second answer")]),
    ];
    const t = allTexts(normalizeTranscript(rows));
    expect(t).toContain("queued second");
    expect(t).toContain("second answer");
    expect(t).not.toContain("queued first");
    expect(t).not.toContain("first answer");
  });
});

describe("review fixes: subagents and sidechains", () => {
  const agentRows = (aid: string, extra: object[] = []) => [
    { ...user(`${aid}-u`, null, "sub task"), isSidechain: true, agentId: aid },
    ...extra,
  ];

  it("a subagent spawned on a losing branch is not rendered as an orphan", () => {
    const rows = [
      user("u0", null, "root"),
      user("p1", "u0", "original"),
      asst("a1", "p1", "m1", [toolUse("tA", "Agent", { description: "d" })]),
      user("r1", "a1", [toolResult("tA", "done")], { toolUseResult: { agentId: "ag1" } }),
      user("p2", "u0", "edited"),
      asst("a2", "p2", "m2", [text("fine")]),
      lastPrompt("a2"),
    ];
    const ms = normalizeTranscript(rows, { subagents: { ag1: agentRows("ag1") } });
    expect(ms.some((m) => m.metadata?.systemSubtype === "orphan_subagent")).toBe(false);
    // by tool_use id through the meta file
    const ms2 = normalizeTranscript(rows, {
      subagents: { ag9: agentRows("ag9") },
      subagentMeta: { ag9: { toolUseId: "tA" } },
    });
    expect(ms2.some((m) => m.metadata?.systemSubtype === "orphan_subagent")).toBe(false);
    // a genuinely unreferenced thread is still shown
    const ms3 = normalizeTranscript(rows, { subagents: { lonely: agentRows("lonely") } });
    expect(ms3.some((m) => m.metadata?.systemSubtype === "orphan_subagent")).toBe(true);
  });

  it("sidechain rows without an agentId render as raw messages", () => {
    const rows = [user("u0", null, "root"), { ...user("s1", "u0", "mystery"), isSidechain: true }];
    const ms = normalizeTranscript(rows);
    const raws = ms.flatMap((m) => m.segments.filter((s) => s.type === "raw"));
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ label: "sidechain row without agentId" });
  });
});

describe("review fixes: hostile input bounds", () => {
  it("fan-out of repeated agent references completes fast with bounded output", () => {
    const levels = 10;
    const reps = 4;
    const subagents: Record<string, unknown[]> = {};
    const callsTo = (prefix: string, target: string) => {
      const rows: unknown[] = [];
      let parent: string | null = null;
      for (let k = 0; k < reps; k++) {
        rows.push(
          asst(`${prefix}a${k}`, parent, `${prefix}m${k}`, [toolUse(`${prefix}t${k}`, "Agent")]),
        );
        rows.push(
          user(`${prefix}r${k}`, `${prefix}a${k}`, [toolResult(`${prefix}t${k}`, "ok")], {
            toolUseResult: { agentId: target },
          }),
        );
        parent = `${prefix}r${k}`;
      }
      return rows;
    };
    for (let i = 0; i < levels; i++) {
      subagents[`ag${i}`] = callsTo(`s${i}`, `ag${i + 1}`).map((r) => ({
        ...(r as object),
        isSidechain: true,
        agentId: `ag${i}`,
      }));
    }
    const main = callsTo("main", "ag0");
    const t0 = Date.now();
    const ms = normalizeTranscript(main, { subagents });
    expect(Date.now() - t0).toBeLessThan(1000);
    const json = JSON.stringify(ms);
    expect(json.length).toBeLessThan(500_000);
    const all = deepCalls(ms);
    expect(all.some((c) => c.subagentRef !== undefined)).toBe(true);
    expect(all.filter((c) => c.subagent?.agentId === "ag0")).toHaveLength(1);
    expect(json).toContain("truncated: subagent nesting deeper than");
  });

  it("deeply nested tool_result content does not throw", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const rows = [
      user("u0", null, "root"),
      asst("a1", "u0", "m1", [toolUse("t1")]),
      user("r1", "a1", [toolResult("t1", [deep])]),
      user("r2", "r1", [toolResult("unpaired", [deep])]),
      { type: "future-kind", uuid: "f1", parentUuid: "r2", deep },
    ];
    let ms: UnifiedMessage[] = [];
    expect(() => {
      ms = normalizeTranscript(rows);
    }).not.toThrow();
    expect(ms.length).toBeGreaterThan(0);
    expect(JSON.stringify(ms).length).toBeLessThan(200_000);
  });

  it("caps an oversized unknown row", () => {
    const big = "x".repeat(5_000_000);
    const rows = [
      { type: "future-kind", uuid: "f1", parentUuid: null, blob: big, more: [big, big] },
    ];
    const ms = normalizeTranscript(rows);
    const size = JSON.stringify(ms).length;
    expect(size).toBeLessThan(20_000);
    expect(ms[0]?.segments[0]).toMatchObject({ type: "raw" });
  });

  it("unknown attachment and system kinds fail closed (key names only)", () => {
    const rows = [
      {
        type: "attachment",
        uuid: "x1",
        parentUuid: null,
        attachment: { type: "new_att", apiKey: "SECRET-TOKEN-1" },
      },
      { type: "attachment", uuid: "x2", parentUuid: "x1", attachment: "SECRET-TOKEN-2" },
      {
        type: "system",
        subtype: "new_sub",
        uuid: "x3",
        parentUuid: "x2",
        password: "SECRET-TOKEN-3",
      },
    ];
    const ms = normalizeTranscript(rows);
    expect(ms).toHaveLength(3);
    const json = JSON.stringify(ms);
    expect(json).not.toContain("SECRET-TOKEN");
    expect(json).toContain("unknown row type: attachment:new_att");
    expect(json).toContain("apiKey");
  });

  it("bounds the persisted-output path", () => {
    const long = "p".repeat(5000);
    const rows = [
      user("u0", null, [
        toolResult(
          "t",
          `<persisted-output>\nOutput too large (1KB). Full output saved to: ${long}\n`,
        ),
      ]),
    ];
    const seg = normalizeTranscript(rows)[0]?.segments[0];
    expect(
      seg?.type === "tool_result" && (seg.result.truncation?.path?.length ?? 0),
    ).toBeLessThanOrEqual(512);
  });
});

describe("security review iteration 2", () => {
  it("1000 tool_use blocks sharing one id do not amplify one result", () => {
    const big = "r".repeat(100_000);
    const blocks = Array.from({ length: 1000 }, () => toolUse("dup"));
    const rows = [
      user("u0", null, "go"),
      asst("a1", "u0", "m1", blocks),
      user("r1", "a1", [toolResult("dup", big)]),
    ];
    const inputSize = JSON.stringify(rows).length;
    const ms = normalizeTranscript(rows);
    expect(JSON.stringify(ms).length).toBeLessThan(inputSize * 2);
    const withResult = calls(ms).filter((c) => c.result !== undefined);
    expect(withResult).toHaveLength(1);
    expect(calls(ms)[0]?.result).toBeDefined();
  });

  it("streaming replacement of the same tool_use still pairs once", () => {
    const rows = [
      user("u0", null, "go"),
      asst("a1", "u0", "m1", [toolUse("t1", "Bash", { command: "partial" })]),
      asst("a1b", "a1", "m1", [toolUse("t1", "Bash", { command: "full" })]),
      user("r1", "a1b", [toolResult("t1", "ok")]),
    ];
    const cs = calls(normalizeTranscript(rows));
    expect(cs).toHaveLength(1);
    expect(cs[0]?.result).toBeDefined();
  });

  it("limits tool_use.input depth so JSON.stringify of the output does not throw", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200_000; i++) deep = { k: deep };
    const rows = [user("u0", null, "go"), asst("a1", "u0", "m1", [toolUse("t1", "Edit", deep)])];
    const ms = normalizeTranscript(rows);
    expect(() => JSON.stringify(ms)).not.toThrow();
    expect(JSON.stringify(ms).length).toBeLessThan(10_000);
  });

  it("keeps a normal tool_use.input intact and bounds an oversized one", () => {
    const small = { file_path: "/a", old_string: "x".repeat(5000), new_string: "y" };
    const huge = { content: "z".repeat(5_000_000) };
    const rows = [
      user("u0", null, "go"),
      asst("a1", "u0", "m1", [toolUse("t1", "Edit", small), toolUse("t2", "Write", huge)]),
    ];
    const cs = calls(normalizeTranscript(rows));
    expect(cs[0]?.input).toEqual(small);
    expect(JSON.stringify(cs[1]?.input).length).toBeLessThan(70_000);
  });

  it("capRaw cuts oversized keys and stops adding keys once the budget is spent", () => {
    const o: Record<string, unknown> = { type: "brand_new", ["k".repeat(5_000_000)]: 1 };
    for (let i = 0; i < 40; i++) o[`${i}`.repeat(3000)] = 1;
    const out = capRaw(o);
    expect(JSON.stringify(out).length).toBeLessThan(40_000);
    expect(Object.keys(out as object).every((k) => k.length <= 210)).toBe(true);
  });

  it("a second call to the same agent gets subagentRef, the first gets the thread", () => {
    const rows = [
      user("u0", null, "go"),
      asst("a1", "u0", "m1", [toolUse("tA", "Agent", { description: "d" })]),
      user("r1", "a1", [toolResult("tA", "done")], { toolUseResult: { agentId: "ag1" } }),
      asst("a2", "r1", "m2", [toolUse("tB", "SendMessage", { to: "ag1" })]),
      user("r2", "a2", [toolResult("tB", "sent")], { toolUseResult: { agentId: "ag1" } }),
    ];
    const subagents = {
      ag1: [{ ...user("ag1-u", null, "sub task"), isSidechain: true, agentId: "ag1" }],
    };
    const cs = calls(normalizeTranscript(rows, { subagents }));
    expect(cs[0]?.subagent?.agentId).toBe("ag1");
    expect(cs[0]?.subagentRef).toBeUndefined();
    expect(cs[1]?.subagentRef).toBe("ag1");
    expect(cs[1]?.subagent).toBeUndefined();
  });
});
