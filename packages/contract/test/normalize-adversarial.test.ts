import { describe, expect, it } from "vitest";
import { limitInput, limitInputChecked, normalizeTranscript } from "../src/normalize";
import type { NormalizeOptions } from "../src/normalize";
import { TRUNCATION_MARKER } from "../src/limits";
import type { ToolCall, UnifiedMessage } from "../src/transcript";

const MB = 1024 * 1024;

function deep(n: number): unknown {
  let v: unknown = "x";
  for (let i = 0; i < n; i++) v = [v];
  return v;
}
function deepObj(n: number): unknown {
  let v: unknown = "x";
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
}
/** Deep value built without recursion in JSON.stringify (iterative size estimate). */
function inputBytes(rows: unknown[], opts: NormalizeOptions): number {
  // Deep values are small per level; measure with a depth-safe walker.
  let bytes = 0;
  const stack: unknown[] = [rows, opts];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") bytes += v.length + 2;
    else if (Array.isArray(v)) {
      bytes += 2 + v.length;
      for (const x of v) stack.push(x);
    } else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        bytes += k.length + 4;
        stack.push(x);
      }
    } else bytes += 8;
  }
  return bytes;
}

function user(uuid: string, parent: string | null, content: unknown, extra: object = {}) {
  return { type: "user", uuid, parentUuid: parent, timestamp: "t", message: { content }, ...extra };
}
function asst(uuid: string, parent: string | null, blocks: unknown[], extra: object = {}) {
  return {
    type: "assistant",
    uuid,
    parentUuid: parent,
    timestamp: "t",
    message: { id: `m-${uuid}`, content: blocks },
    ...extra,
  };
}
function calls(msgs: UnifiedMessage[]): ToolCall[] {
  const out: ToolCall[] = [];
  const walk = (list: UnifiedMessage[]) => {
    for (const m of list)
      for (const s of m.segments)
        if (s.type === "tool_call") {
          out.push(s.tool);
          if (s.tool.subagent) walk(s.tool.subagent.messages);
        }
  };
  walk(msgs);
  return out;
}

interface Shape {
  name: string;
  rows: () => unknown[];
  opts?: () => NormalizeOptions;
}

const SHAPES: Shape[] = [
  {
    name: "shared tool_use id x2000, 1 MB result",
    rows: () => [
      asst(
        "a1",
        null,
        Array.from({ length: 2000 }, () => ({
          type: "tool_use",
          id: "T",
          name: "Bash",
          input: {},
        })),
      ),
      user("u1", "a1", [{ type: "tool_result", tool_use_id: "T", content: "r".repeat(MB) }]),
    ],
  },
  {
    name: "200k-deep tool_use.input",
    rows: () => [
      asst("a1", null, [{ type: "tool_use", id: "T", name: "Bash", input: deep(200_000) }]),
    ],
  },
  {
    name: "200k-deep values in every system/attachment field",
    rows: () => {
      const d = deepObj(200_000);
      const da = deep(200_000);
      return [
        {
          type: "system",
          subtype: "scheduled_task_fire",
          uuid: "s1",
          parentUuid: null,
          taskId: d,
          cron: da,
          content: da,
        },
        {
          type: "system",
          subtype: "stop_hook_summary",
          uuid: "s2",
          parentUuid: "s1",
          preventedContinuation: d,
          stopReason: da,
          hookCount: da,
          hookErrors: da,
          level: d,
        },
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "s3",
          parentUuid: null,
          content: da,
          compactMetadata: { trigger: da, preTokens: d, postTokens: da, durationMs: d },
        },
        {
          type: "system",
          subtype: "api_error",
          uuid: "s4",
          parentUuid: "s3",
          error: { message: da, formatted: d },
          retryAttempt: da,
          maxRetries: d,
          retryInMs: da,
        },
        {
          type: "attachment",
          uuid: "t1",
          parentUuid: "s4",
          attachment: {
            type: "hook_success",
            hookName: da,
            hookEvent: d,
            command: da,
            durationMs: d,
          },
        },
        {
          type: "attachment",
          uuid: "t2",
          parentUuid: "t1",
          attachment: {
            type: "hook_cancelled",
            hookEvent: d,
            command: da,
            timedOut: true,
            timeoutMs: da,
          },
        },
        {
          type: "attachment",
          uuid: "t3",
          parentUuid: "t2",
          attachment: { type: "hook_non_blocking_error", hookEvent: d, stderr: da, exitCode: da },
        },
        {
          type: "attachment",
          uuid: "t4",
          parentUuid: "t3",
          attachment: { type: "plan_mode_exit", planExists: d },
        },
        {
          type: "attachment",
          uuid: "t5",
          parentUuid: "t4",
          attachment: { type: "hook_additional_context", hookEvent: d, content: da },
        },
        {
          type: "attachment",
          uuid: "t6",
          parentUuid: "t5",
          attachment: { type: "invoked_skills", skills: [{ name: da }, da] },
        },
        {
          type: "attachment",
          uuid: "t7",
          parentUuid: "t6",
          attachment: { type: "queued_command", prompt: da, origin: { kind: d } },
        },
      ];
    },
  },
  {
    name: "5 MB key in an unknown row",
    rows: () => [
      { type: "mystery", uuid: "x1", [`k${"k".repeat(5 * MB)}`]: 1 },
      {
        type: "attachment",
        uuid: "x2",
        parentUuid: null,
        attachment: { type: "future", [`k${"k".repeat(5 * MB)}`]: 1 },
        [`z${"z".repeat(5 * MB)}`]: 1,
      },
    ],
  },
  {
    name: "5 MB compact trigger",
    rows: () => [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c1",
        parentUuid: null,
        compactMetadata: { trigger: "t".repeat(5 * MB), preTokens: 1 },
      },
    ],
  },
  {
    name: "1 MB meta description/agentType, 300 depth-9 placeholder refs",
    rows: () => [
      asst("a0", null, [
        { type: "tool_use", id: "T0", name: "Agent", input: { description: "d".repeat(MB) } },
      ]),
    ],
    opts: () => chainOpts(),
  },
  {
    name: "1 MB agentId on an orphan sidechain row",
    rows: () => [
      {
        type: "user",
        uuid: "o1",
        parentUuid: null,
        isSidechain: true,
        agentId: "a".repeat(MB),
        timestamp: "t",
        message: { content: "hi" },
      },
    ],
  },
  {
    name: "subagentRef x2000",
    rows: () => [
      asst(
        "a1",
        null,
        Array.from({ length: 2000 }, (_, i) => ({
          type: "tool_use",
          id: `T${i}`,
          name: "Agent",
          input: {},
        })),
      ),
    ],
    opts: () => ({
      subagents: { AG: [user("s1", null, "hello")] },
      subagentMeta: Object.fromEntries([["AG", { toolUseId: "T0" }]]),
    }),
  },
  {
    name: "streamed rows x5000 with one id",
    rows: () =>
      Array.from({ length: 5000 }, (_, i) =>
        asst(`a${i}`, i === 0 ? null : `a${i - 1}`, [
          { type: "text", text: `partial ${i} ${"p".repeat(200)}` },
        ]),
      ).map((r) => ({ ...r, message: { ...r.message, id: "SAME" }, requestId: "R" })),
  },
  {
    name: "1M empty arrays in tool_use.input",
    rows: () => [
      asst("a1", null, [
        {
          type: "tool_use",
          id: "T",
          name: "Bash",
          input: { list: Array.from({ length: 1_000_000 }, () => []) },
        },
      ]),
    ],
  },
];

/**
 * Agent chain A0 -> A1 -> ... -> A7; A7 (depth 8) holds 300 calls that all report agent A8 (depth 9, so a
 * placeholder). A8 has 1 MB agentType and description.
 */
function chainOpts(directToolUseId?: string): NormalizeOptions {
  const subagents: Record<string, unknown[]> = {};
  const subagentMeta: Record<
    string,
    { toolUseId?: string; agentType?: string; description?: string }
  > = {};
  for (let i = 0; i < 8; i++) {
    const rows: unknown[] = [];
    if (i < 7)
      rows.push(
        asst(`s${i}`, null, [{ type: "tool_use", id: `spawn${i + 1}`, name: "Agent", input: {} }]),
      );
    else {
      const blocks = Array.from({ length: 300 }, (_, j) => ({
        type: "tool_use",
        id: `deep${j}`,
        name: "Agent",
        input: {},
      }));
      rows.push(asst("s7", null, blocks));
      for (let j = 0; j < 300; j++)
        rows.push(
          user(`r${j}`, "s7", [{ type: "tool_result", tool_use_id: `deep${j}`, content: "ok" }], {
            toolUseResult: { agentId: "A8" },
          }),
        );
    }
    subagents[`A${i}`] = rows;
    subagentMeta[`A${i}`] = {
      toolUseId: i === 0 ? "T0" : `spawn${i}`,
      agentType: "y".repeat(MB / 10),
      description: "z".repeat(MB / 10),
    };
  }
  subagents.A8 = [user("e0", null, "leaf")];
  subagentMeta.A8 = {
    ...(directToolUseId ? { toolUseId: directToolUseId } : {}),
    agentType: "y".repeat(MB / 2),
    description: "z".repeat(MB / 2),
  };
  return { subagents, subagentMeta };
}

describe("normalizer adversarial shapes", () => {
  for (const shape of SHAPES) {
    it(shape.name, () => {
      const rows = shape.rows();
      const opts = shape.opts ? shape.opts() : {};
      const inBytes = inputBytes(rows, opts);
      const t0 = performance.now();
      let out: UnifiedMessage[] = [];
      expect(() => {
        out = normalizeTranscript(rows, opts);
      }).not.toThrow();
      const ms = performance.now() - t0;
      let json = "";
      expect(() => {
        json = JSON.stringify(out);
      }).not.toThrow();
      console.log(`ADV | ${shape.name} | in ${inBytes} | out ${json.length} | ${ms.toFixed(0)} ms`);
      expect(json.length).toBeLessThanOrEqual(3 * inBytes + 64 * 1024);
      expect(ms).toBeLessThan(2000);
    });
  }
});

describe("review iteration 3 findings", () => {
  const mainCall = (...ids: string[]) => [
    asst(
      "a1",
      null,
      ids.map((id) => ({ type: "tool_use", id, name: "Agent", input: {} })),
    ),
  ];

  it("places at most one placeholder per deep agent; later references link", () => {
    const all = calls(normalizeTranscript(mainCall("T0"), chainOpts()));
    const deepCalls = all.filter((c) => c.id.startsWith("deep"));
    expect(deepCalls.length).toBe(300);
    const placeholders = deepCalls.filter((c) => c.subagent !== undefined);
    expect(placeholders.length).toBe(1);
    expect(placeholders[0]?.subagent?.messages[0]?.metadata?.rawType).toBe("truncated");
    expect(deepCalls.filter((c) => c.subagentRef === "A8").length).toBe(299);
  });

  it("caps meta.description and agentType near 200 chars", () => {
    const all = calls(normalizeTranscript(mainCall("T0"), chainOpts()));
    expect(all.filter((c) => c.subagent).length).toBeGreaterThan(8);
    for (const c of all) {
      expect((c.subagent?.description ?? "").length).toBeLessThanOrEqual(200);
      expect((c.subagent?.agentType ?? "").length).toBeLessThanOrEqual(200);
    }
  });

  it("expands a shallow call even when a deep reference appears first", () => {
    const out = normalizeTranscript(mainCall("T0", "direct"), chainOpts("direct"));
    const all = calls(out);
    const direct = all.find((c) => c.id === "direct");
    expect(direct?.subagent?.agentId).toBe("A8");
    expect(direct?.subagent?.messages[0]?.metadata?.rawType).not.toBe("truncated");
    expect(all.filter((c) => c.id.startsWith("deep") && c.subagentRef === "A8").length).toBe(300);
    expect(
      all.filter((c) => c.subagent?.messages[0]?.metadata?.rawType === "truncated").length,
    ).toBe(0);
  });

  it("system/attachment data holds only scalars and compact is not shared", () => {
    const out = normalizeTranscript([
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c",
        parentUuid: null,
        compactMetadata: { trigger: "auto", preTokens: 5, durationMs: { x: 1 } },
      },
      {
        type: "system",
        subtype: "scheduled_task_fire",
        uuid: "d",
        parentUuid: "c",
        taskId: { x: 1 },
        cron: "* * * * *",
      },
    ]);
    const m = out[0] as UnifiedMessage;
    const seg = m.segments[0];
    const infoData = seg?.type === "system_info" ? seg.info.data : undefined;
    expect(infoData).toEqual({ trigger: "auto", preTokens: 5 });
    expect(m.metadata?.compact).toEqual(infoData);
    expect(m.metadata?.compact).not.toBe(infoData);
    const d = out[1]?.segments[0];
    expect(d?.type === "system_info" ? d.info.data : null).toEqual({
      taskId: undefined,
      cron: "* * * * *",
    });
  });

  it("caps the agentId of an orphan sidechain row", () => {
    const out = normalizeTranscript([
      {
        type: "user",
        uuid: "o1",
        parentUuid: null,
        isSidechain: true,
        agentId: "a".repeat(5000),
        timestamp: "t",
        message: { content: "hi" },
      },
    ]);
    const orphan = out.find((m) => m.metadata?.systemSubtype === "orphan_subagent");
    expect((orphan?.metadata?.agent as string).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(out).length).toBeLessThan(5000);
  });

  it("counts empty containers against the input budget", () => {
    const r = limitInputChecked({ list: Array.from({ length: 1_000_000 }, () => []) });
    expect(JSON.stringify(r.value).length).toBeLessThan(200_000);
    expect(r.truncated).toBe(true);
  });

  it("flags inputTruncated, keeps arrays of objects pure and uses the shared marker", () => {
    const big = "x".repeat(40_000);
    const out = normalizeTranscript([
      asst("a1", null, [
        { type: "tool_use", id: "E", name: "Edit", input: { old_string: big, new_string: big } },
        {
          type: "tool_use",
          id: "M",
          name: "MultiEdit",
          input: {
            edits: Array.from({ length: 5000 }, () => ({
              old_string: "a".repeat(40),
              new_string: "b".repeat(40),
            })),
          },
        },
        { type: "tool_use", id: "S", name: "Bash", input: { command: "ls" } },
      ]),
    ]);
    const [e, m, s] = calls(out) as [ToolCall, ToolCall, ToolCall];
    expect(e.inputTruncated).toBe(true);
    expect((e.input as { new_string: string }).new_string.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(m.inputTruncated).toBe(true);
    const edits = (m.input as { edits: unknown[] }).edits;
    expect(edits.every((x) => typeof x === "object" && x !== null)).toBe(true);
    expect(s.inputTruncated).toBeUndefined();
  });

  it("does not split a surrogate pair when cutting", () => {
    const text = "😀".repeat(40_000);
    const v = limitInput({ s: text }) as { s: string };
    const body = v.s.slice(0, v.s.length - TRUNCATION_MARKER.length);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("an unindexed streamed row replaces every earlier block, indexed ones included", () => {
    const mk = (uuid: string, extra: object, text: string) => ({
      ...asst(uuid, null, [{ type: "text", text }], extra),
      message: { id: "SAME", content: [{ type: "text", text }] },
    });
    const out = normalizeTranscript([
      mk("a1", { apiBlockIndex: 0 }, "old0"),
      mk("a2", { apiBlockIndex: 1 }, "old1"),
      mk("a3", {}, "final"),
    ]);
    const texts = out.flatMap((x) =>
      x.segments.map((sg) => (sg.type === "text" ? sg.content : "")),
    );
    expect(texts).toEqual(["final"]);
  });
});
