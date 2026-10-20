import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpoolLine } from "../src/spool-format.ts";
import {
  type FileSig,
  type ReplaceStrategy,
  type StatLike,
  TranscriptTailer,
  type TranscriptTailerOptions,
  shouldReset,
  splitLines,
  subagentTranscriptPath,
} from "../src/daemon/transcript.ts";
import { fixturesDir } from "./helpers.ts";

let dir: string;
let out: SpoolLine[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sd-transcript-"));
  out = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const S = "sess-1";
const statePath = (): string => join(dir, "offsets.json");
const mk = (extra: Partial<TranscriptTailerOptions> = {}): TranscriptTailer =>
  new TranscriptTailer({
    statePath: statePath(),
    enqueue: (l) => out.push(l),
    host: "h",
    pollMs: 0,
    ...extra,
  });
const nl = (xs: string[]): string => xs.map((x) => `${x}\n`).join("");
const gen = (a: number, b: number, tag = "L"): string[] =>
  Array.from({ length: b - a }, (_, i) => `{"n":"${tag}${a + i}"}`);

/** (agent, line_no) -> every delivery of that line, from the enqueued envelopes. */
function deliveries(agent?: string): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const l of out) {
    if (l.kind !== "transcript" || l.agent_id !== agent) continue;
    const p = l.payload as { start_line: number; lines: string[] };
    p.lines.forEach((s, i) => m.set(p.start_line + i, [...(m.get(p.start_line + i) ?? []), s]));
  }
  return m;
}
const flat = (agent?: string): string[] => [...deliveries(agent).values()].map((v) => v[0] ?? "");

describe("transcript tailer", () => {
  it("delivers each line once, with envelope shape, and only complete lines", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 3)) + '{"n":"par');
    const t = mk();
    await t.onSessionStart(S, f);
    expect(await t.poll()).toBe(3);
    expect(flat()).toEqual(gen(0, 3));
    expect(await t.poll()).toBe(0);
    appendFileSync(f, 'tial"}\n');
    expect(await t.poll()).toBe(1);
    expect(flat().at(-1)).toBe('{"n":"partial"}');
    const env = out[0]!;
    expect(env).toMatchObject({ v: 1, kind: "transcript", host: "h", session_id: S });
    expect(env.agent_id).toBeUndefined();
    expect(env.payload).toEqual({ start_line: 0, lines: gen(0, 3) });
    for (const v of deliveries().values()) expect(v).toHaveLength(1);
  });

  it("handles CRLF and drops blank lines", async () => {
    expect(splitLines(Buffer.from("a\r\n\r\nb\n"))).toEqual(["a", "b"]);
  });

  it("each line once across restarts (graceful and mid-file)", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 5)));
    let t = mk();
    await t.onSessionStart(S, f);
    await t.poll();
    t = mk(); // restart: state comes from disk
    appendFileSync(f, nl(gen(5, 9)));
    await t.start();
    await t.poll();
    t = mk();
    await t.poll();
    appendFileSync(f, nl(gen(9, 12)));
    await t.poll();
    expect(flat()).toEqual(gen(0, 12));
    for (const v of deliveries().values()) expect(v).toHaveLength(1);
  });

  it("a failed outbox write commits nothing; the retry reuses the same start_line", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 4)));
    let fail = true;
    const t = mk({
      enqueue: (l) => {
        if (fail) throw new Error("disk full");
        out.push(l);
      },
    });
    await t.onSessionStart(S, f);
    await expect(t.poll()).rejects.toThrow("disk full");
    expect(t.entries()[0]!.offset).toBe(0);
    fail = false;
    await t.poll();
    expect(flat()).toEqual(gen(0, 4));
  });

  it("a crash after the outbox write replays with identical start_line (hub dedups)", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 4)));
    const t1 = mk();
    await t1.onSessionStart(S, f);
    // state persisted at track time? No: simulate crash by never persisting the poll result
    const saved = readFileSyncOrEmpty(statePath());
    await t1.poll();
    writeFileSync(statePath(), saved); // roll the offsets back as if the process died before commit
    const t2 = mk();
    await t2.poll();
    const d = deliveries();
    expect([...d.keys()]).toEqual([0, 1, 2, 3]);
    for (const v of d.values()) expect(v[0]).toBe(v[1]);
  });

  it("compaction rewrite (file shrinks) resets the offset and keeps counting", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 10)));
    const t = mk();
    await t.onSessionStart(S, f);
    await t.poll();
    writeFileSync(f, nl(gen(0, 2, "C"))); // rewritten, smaller
    await t.poll();
    appendFileSync(f, nl(gen(2, 3, "C")));
    await t.poll();
    expect(t.entries()[0]!.resets).toBe(1);
    const d = deliveries();
    expect([...d.keys()]).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(d.get(10)).toEqual(['{"n":"C0"}']);
    expect(d.get(12)).toEqual(['{"n":"C2"}']);
  });

  it("truncate to zero then regrow resets", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 3)));
    const t = mk();
    await t.onSessionStart(S, f);
    await t.poll();
    truncateSync(f, 0);
    await t.poll();
    appendFileSync(f, nl(gen(0, 1, "N")));
    await t.poll();
    expect(flat()).toEqual([...gen(0, 3), '{"n":"N0"}']);
    expect(t.entries()[0]!.resets).toBe(1);
  });

  for (const strategy of ["posix", "win32"] as ReplaceStrategy[]) {
    it(`atomic replace by a LARGER file is a reset (${strategy} strategy)`, async () => {
      const f = join(dir, "t.jsonl");
      writeFileSync(f, nl(gen(0, 3)));
      const t = mk({ strategy });
      await t.onSessionStart(S, f);
      await t.poll();
      const tmp = join(dir, "t.tmp");
      writeFileSync(tmp, nl(gen(0, 8, "R"))); // longer than the old offset
      renameSync(tmp, f);
      await t.poll();
      expect(t.entries()[0]!.resets).toBe(1);
      expect(flat()).toEqual([...gen(0, 3), ...gen(0, 8, "R")]);
    });

    it(`in-place rewrite to the same length is caught by the head fingerprint (${strategy})`, async () => {
      const f = join(dir, "t.jsonl");
      writeFileSync(f, nl(gen(0, 3)));
      const t = mk({ strategy });
      await t.onSessionStart(S, f);
      await t.poll();
      writeFileSync(f, nl(gen(0, 3, "Z")) + nl(gen(3, 5, "Z")));
      await t.poll();
      expect(t.entries()[0]!.resets).toBe(1);
      expect(flat().slice(3)).toEqual([...gen(0, 3, "Z"), ...gen(3, 5, "Z")]);
    });
  }

  it("windows heuristic with an injected stat: birthtime change resets, ctime alone does not", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 3)));
    const fake = { birth: 1000, ctime: 1000, ino: 0 };
    const t = mk({
      strategy: "win32",
      stat: async (p) => {
        const real = (await import("node:fs/promises")).stat;
        const s = await real(p);
        return {
          size: s.size,
          ino: fake.ino,
          birthtimeMs: fake.birth,
          ctimeMs: fake.ctime,
          mtimeMs: s.mtimeMs,
        };
      },
    });
    await t.onSessionStart(S, f);
    await t.poll();
    fake.ctime = 2000; // ctime moves on every append on NTFS; not a replace
    appendFileSync(f, nl(gen(3, 4)));
    await t.poll();
    expect(t.entries()[0]!.resets).toBe(0);
    fake.birth = 3000; // new file identity, same content prefix, grown size
    appendFileSync(f, nl(gen(4, 5)));
    await t.poll();
    expect(t.entries()[0]!.resets).toBe(1);
  });

  it("tails subagent transcripts after SubagentStart, not before", async () => {
    const main = join(dir, "proj", `${S}.jsonl`);
    mkdirSync(join(dir, "proj", S, "subagents"), { recursive: true });
    const sub = join(dir, "proj", S, "subagents", "agent-ab12.jsonl");
    writeFileSync(main, nl(gen(0, 2)));
    writeFileSync(sub, nl(gen(0, 2, "S")));
    const t = mk();
    await t.onSessionStart(S, main);
    await t.poll();
    expect(flat("ab12")).toEqual([]); // not announced yet
    await t.onSubagentStart(S, "ab12", main);
    await t.poll();
    appendFileSync(sub, nl(gen(2, 4, "S")));
    await t.poll();
    expect(flat("ab12")).toEqual(gen(0, 4, "S"));
    expect(flat()).toEqual(gen(0, 2));
    const e = out.find((l) => l.agent_id === "ab12")!;
    expect(e.session_id).toBe(S);
  });

  it("a subagent file that does not exist yet is picked up when it appears", async () => {
    const main = join(dir, "proj", `${S}.jsonl`);
    mkdirSync(join(dir, "proj"), { recursive: true });
    writeFileSync(main, "");
    const t = mk();
    await t.onSessionStart(S, main);
    await t.onSubagentStart(S, "late", main);
    await t.poll();
    mkdirSync(join(dir, "proj", S, "subagents"), { recursive: true });
    writeFileSync(join(dir, "proj", S, "subagents", "agent-late.jsonl"), nl(gen(0, 2, "S")));
    await t.poll();
    expect(flat("late")).toEqual(gen(0, 2, "S"));
  });

  it("SessionEnd does a final drain of session and subagents, then stops tailing", async () => {
    const main = join(dir, "proj", `${S}.jsonl`);
    mkdirSync(join(dir, "proj", S, "subagents"), { recursive: true });
    const sub = join(dir, "proj", S, "subagents", "agent-x.jsonl");
    writeFileSync(main, nl(gen(0, 2)));
    writeFileSync(sub, nl(gen(0, 1, "S")));
    const t = mk();
    await t.onSessionStart(S, main);
    await t.onSubagentStart(S, "x", main);
    appendFileSync(main, nl(gen(2, 4)));
    await t.onSessionEnd(S);
    expect(flat()).toEqual(gen(0, 4));
    expect(flat("x")).toEqual(gen(0, 1, "S"));
    appendFileSync(main, nl(gen(4, 5)));
    await t.poll();
    expect(flat()).toEqual(gen(0, 4));
    // resumed session continues where it stopped, from persisted state
    const t2 = mk();
    await t2.onSessionStart(S, main);
    await t2.poll();
    expect(flat()).toEqual(gen(0, 5));
    for (const v of deliveries().values()) expect(v).toHaveLength(1);
  });

  it("replaces a line too large to fit with a marker so numbering stays continuous", async () => {
    const f = join(dir, "t.jsonl");
    const big = JSON.stringify({ blob: "x".repeat(2000) });
    writeFileSync(f, nl(["a", big, "c"]));
    const t = mk({ maxLineJsonBytes: 1000 });
    await t.onSessionStart(S, f);
    await t.poll();
    const d = deliveries();
    expect([...d.keys()]).toEqual([0, 1, 2]);
    expect(JSON.parse(d.get(1)![0]!)).toMatchObject({
      type: "sessiondeck_marker",
      reason: "line_too_large",
      bytes: big.length,
    });
    expect(d.get(2)).toEqual(["c"]);
    expect(t.stats.markers).toBe(1);
  });

  it("splits into envelopes under the byte cap with contiguous start_line", async () => {
    const f = join(dir, "t.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: "y".repeat(100) }));
    writeFileSync(f, nl(lines));
    const t = mk({ maxEnvelopeBytes: 1000 });
    await t.onSessionStart(S, f);
    await t.poll();
    expect(out.length).toBeGreaterThan(5);
    let next = 0;
    for (const l of out) {
      const p = l.payload as { start_line: number; lines: string[] };
      expect(p.start_line).toBe(next);
      next += p.lines.length;
      expect(JSON.stringify(l).length).toBeLessThan(1400);
    }
    expect(flat()).toEqual(lines);
  });

  it("dispatches contract fixtures through onSpoolLine", async () => {
    const start = JSON.parse(
      readFileSync(join(fixturesDir, "SessionStart", "01-startup.json"), "utf8"),
    );
    const sub = JSON.parse(
      readFileSync(join(fixturesDir, "SubagentStart", "01-subagent.json"), "utf8"),
    );
    const t = mk();
    const env = (p: Record<string, unknown>, name: string, agent?: string): Envelope =>
      ({
        v: 1,
        id: "x",
        kind: "hook",
        host: "h",
        os: "linux",
        session_id: p["session_id"] as string,
        ...(agent ? { agent_id: agent } : {}),
        hook_event_name: name,
        ts: 1,
        seq: 0,
        payload: p,
      }) as Envelope;
    t.onSpoolLine(env(start, "SessionStart"));
    t.onSpoolLine(env(start, "SessionStart")); // at-least-once: idempotent
    t.onSpoolLine(env(sub, "SubagentStart", sub.agent_id));
    await t.poll();
    const es = t.entries();
    expect(es).toHaveLength(2);
    expect(es[0]!.path).toBe(start.transcript_path);
    expect(es[1]!.agent_id).toBe(sub.agent_id);
    expect(es[1]!.path).toBe(
      `${sub.transcript_path.replace(/\/[^/]+$/, "")}/${sub.session_id}/subagents/agent-${sub.agent_id}.jsonl`,
    );
    t.onSpoolLine(env({ session_id: start.session_id }, "SessionEnd"));
    await t.poll();
    expect(
      t.entries().every((e) => e.ended_at !== undefined || e.session_id !== start.session_id),
    ).toBe(true);
  });

  it("derives subagent paths in the style of the transcript path", () => {
    expect(subagentTranscriptPath("C:\\Users\\a\\.claude\\projects\\p\\s1.jsonl", "s1", "z")).toBe(
      "C:\\Users\\a\\.claude\\projects\\p\\s1\\subagents\\agent-z.jsonl",
    );
    expect(subagentTranscriptPath("/h/.claude/projects/p/s1.jsonl", "s1", "z")).toBe(
      "/h/.claude/projects/p/s1/subagents/agent-z.jsonl",
    );
  });

  it("moves a corrupt offsets file aside and starts fresh", async () => {
    writeFileSync(statePath(), "{nope");
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 1)));
    const t = mk();
    await t.onSessionStart(S, f);
    await t.poll();
    expect(flat()).toEqual(gen(0, 1));
  });
});

describe("shouldReset", () => {
  const sig: FileSig = { ino: 5, birthtimeMs: 10, ctimeMs: 20, mtimeMs: 20, head: "" };
  const st = (o: Partial<StatLike>): StatLike => ({
    size: 100,
    ino: 5,
    birthtimeMs: 10,
    ctimeMs: 30,
    mtimeMs: 30,
    ...o,
  });
  it("table", () => {
    expect(shouldReset("posix", sig, st({}), 50, true)).toBe(false);
    expect(shouldReset("posix", sig, st({ size: 10 }), 50, true)).toBe(true);
    expect(shouldReset("posix", sig, st({ ino: 6 }), 50, true)).toBe(true);
    expect(shouldReset("posix", sig, st({ birthtimeMs: 99 }), 50, true)).toBe(false);
    expect(shouldReset("win32", sig, st({ ino: 6 }), 50, true)).toBe(false);
    expect(shouldReset("win32", sig, st({ birthtimeMs: 99 }), 50, true)).toBe(true);
    expect(shouldReset("win32", sig, st({ size: 10 }), 50, true)).toBe(true);
    expect(shouldReset("win32", sig, st({}), 50, false)).toBe(true);
    expect(shouldReset("win32", sig, st({ size: 10 }), 0, undefined)).toBe(false);
  });
});

// Real-filesystem check on the platform the Windows heuristic exists for (windows-latest CI).
describe.skipIf(process.platform !== "win32")("windows real filesystem", () => {
  it("replace-by-rename with a larger file resets under the default strategy", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 3)));
    const t = mk();
    await t.onSessionStart(S, f);
    await t.poll();
    const tmp = join(dir, "t.tmp");
    writeFileSync(tmp, nl(gen(0, 9, "W")));
    renameSync(tmp, f);
    await t.poll();
    expect(t.entries()[0]!.resets).toBe(1);
    expect(flat()).toEqual([...gen(0, 3), ...gen(0, 9, "W")]);
  });
});

function readFileSyncOrEmpty(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
