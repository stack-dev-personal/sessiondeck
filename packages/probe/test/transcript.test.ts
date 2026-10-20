import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  linkSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { vi } from "vitest";

const fsyncCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:fs", async (orig) => {
  const a = await orig<typeof import("node:fs")>();
  return {
    ...a,
    fsyncSync: (fd: number): void => {
      fsyncCalls.n += 1;
      a.fsyncSync(fd);
    },
  };
});
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
  PRUNED_KEEP_MS,
  highMark,
  isUnder,
  shouldReset,
  splitLines,
  subagentTranscriptPath,
} from "../src/daemon/transcript.ts";
import { createOutbox } from "../src/daemon/outbox.ts";
import { fixturesDir } from "./helpers.ts";

let dir: string;
let out: SpoolLine[];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sd-transcript-")));
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
    projectsDir: dir,
    ...extra,
  });
/** A tailer with no projects dir configured: it must refuse everything. */
const noProjects = (extra: Partial<TranscriptTailerOptions> = {}): TranscriptTailer =>
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
    await t.poll(); // logged per file, not thrown
    expect(t.entries()[0]!.offset).toBe(0);
    fail = false;
    await t.poll();
    expect(flat()).toEqual(gen(0, 4));
    expect([...deliveries().keys()]).toEqual([0, 1, 2, 3]);
    expect((out[0]!.payload as { start_line: number }).start_line).toBe(0);
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
    // The fixtures carry "<HOME>" placeholders; point them into the temp dir (the trusted root).
    const fx = (d: string, n: string): Record<string, string> =>
      JSON.parse(
        readFileSync(join(fixturesDir, d, n), "utf8").replaceAll(
          "<HOME>",
          dir.replaceAll("\\", "/"),
        ),
      );
    const start = fx("SessionStart", "01-startup.json");
    const sub = fx("SubagentStart", "01-subagent.json");
    const t = mk({ projectsDir: join(dir, ".claude", "projects") });
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
      `${sub.transcript_path!.replace(/\/[^/]+$/, "")}/${sub.session_id}/subagents/agent-${sub.agent_id}.jsonl`,
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

describe("transcript tailer review fixes", () => {
  const hook = (name: string, sid: string, p: Record<string, unknown>, agent?: string): Envelope =>
    ({
      v: 1,
      id: "x",
      kind: "hook",
      host: "h",
      os: "linux",
      session_id: sid,
      ...(agent ? { agent_id: agent } : {}),
      hook_event_name: name,
      ts: 1,
      seq: 0,
      payload: p,
    }) as Envelope;

  it("a handler failure in onSpoolLine is logged, not an unhandled rejection", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 1)));
    const logs: string[] = [];
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const t = mk({
        log: (lv, m) => logs.push(`${lv} ${m}`),
        enqueue: () => {
          throw new Error("disk full");
        },
      });
      await t.onSessionStart(S, f);
      t.onSpoolLine(hook("SessionEnd", S, {}));
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
      expect(logs.some((l) => l.startsWith("error ") && l.includes("SessionEnd"))).toBe(true);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("SubagentStop without a tracked SubagentStart delivers via agent_transcript_path", async () => {
    const stop = JSON.parse(
      readFileSync(join(fixturesDir, "SubagentStop", "01-subagent.json"), "utf8"),
    );
    const proj = join(dir, "proj");
    const sub = join(proj, stop.session_id, "subagents", `agent-${stop.agent_id}.jsonl`);
    mkdirSync(join(proj, stop.session_id, "subagents"), { recursive: true });
    writeFileSync(sub, nl(gen(0, 3, "S")));
    const t = mk({ projectsDir: proj });
    t.onSpoolLine(
      hook(
        "SubagentStop",
        stop.session_id,
        {
          ...stop,
          transcript_path: join(proj, `${stop.session_id}.jsonl`),
          agent_transcript_path: sub,
        },
        stop.agent_id,
      ),
    );
    await t.poll();
    expect(flat(stop.agent_id)).toEqual(gen(0, 3, "S"));
    expect(t.entries()[0]!.ended_at).toBeDefined();
  });

  it("rejects bad agent ids and agent paths outside the projects dir", async () => {
    const proj = join(dir, "proj");
    mkdirSync(proj, { recursive: true });
    const secret = join(dir, "secret.jsonl");
    writeFileSync(secret, nl(gen(0, 2, "X")));
    const logs: string[] = [];
    const t = mk({ projectsDir: proj, log: (lv, m) => logs.push(`${lv} ${m}`) });
    await t.onSessionStart(S, join(proj, `${S}.jsonl`));
    await t.onSubagentStart(S, "../../secret", join(proj, `${S}.jsonl`));
    await t.onSubagentStop(S, "ok1", secret);
    await t.onSubagentStop(S, "../x", join(proj, "x.jsonl"));
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("warn")).length).toBeGreaterThanOrEqual(3);
  });

  it("a lost offsets file restarts numbering at a high mark that fits 32 bits", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 13)));
    const t1 = mk();
    await t1.onSessionStart(S, f);
    await t1.poll();
    writeFileSync(statePath(), "{nope");
    const logs: string[] = [];
    out.length = 0;
    const clock = Date.now();
    const t2 = mk({ now: () => clock, log: (lv, m) => logs.push(`${lv} ${m}`) });
    await t2.onSessionStart(S, f);
    await t2.poll();
    const first = (out[0]!.payload as { start_line: number }).start_line;
    expect(first).toBe(highMark(clock));
    expect(first).toBeGreaterThan(13);
    expect(first + 1e6).toBeLessThan(2 ** 31);
    expect(logs.some((l) => l.startsWith("warn") && l.includes("numbering restarts"))).toBe(true);
  });

  it("a pruned ended entry that returns restarts at a high mark", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    let clock = Date.now();
    const t1 = mk({ now: () => clock });
    await t1.onSessionStart(S, f);
    await t1.poll();
    await t1.onSessionEnd(S);
    clock += 8 * 24 * 3600 * 1000;
    await t1.poll(); // prunes
    expect(t1.entries()).toHaveLength(0);
    const t2 = mk({ now: () => clock });
    await t2.onSessionStart(S, f);
    expect(t2.entries()[0]!.next_line).toBe(highMark(clock));
  });

  it("SubagentStop for an untracked main session needs projectsDir (payload path is no anchor)", async () => {
    const proj = join(dir, "proj");
    const sub = join(proj, S, "subagents", "agent-a1.jsonl");
    mkdirSync(join(proj, S, "subagents"), { recursive: true });
    writeFileSync(sub, nl(gen(0, 2, "S")));
    const logs: string[] = [];
    const t = noProjects({ log: (lv, m) => logs.push(`${lv} ${m}`) });
    await t.onSubagentStop(S, "a1", sub);
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("warn") && l.includes("outside projects dir"))).toBe(true);
    const t2 = mk({ projectsDir: proj });
    await t2.onSubagentStop(S, "a1", sub);
    expect(flat("a1")).toEqual(gen(0, 2, "S"));
  });

  it("SubagentStop path that reaches outside projectsDir through a symlink is refused", async () => {
    {
      const proj = join(dir, "proj");
      const outside = join(dir, "outside");
      mkdirSync(join(outside, "subagents"), { recursive: true });
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(outside, "subagents", "agent-a1.jsonl"), nl(gen(0, 2, "X")));
      symlinkSync(outside, join(proj, S), process.platform === "win32" ? "junction" : undefined);
      const sub = join(proj, S, "subagents", "agent-a1.jsonl");
      const logs: string[] = [];
      const t = mk({ projectsDir: proj, log: (lv, m) => logs.push(`${lv} ${m}`) });
      await t.onSubagentStop(S, "a1", sub);
      await t.poll();
      expect(out).toHaveLength(0);
      expect(t.entries()).toHaveLength(0);
      expect(logs.some((l) => l.includes("outside projects dir"))).toBe(true);
    }
  });

  it("re-tracking after a prune never reuses numbers, even if the clock steps back", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 3)));
    const day = 24 * 3600 * 1000;
    let clock = Date.now();
    const t = mk({ now: () => clock });
    await t.onSessionStart(S, f);
    await t.poll();
    await t.onSessionEnd(S);
    clock += 8 * day;
    await t.poll(); // pruned
    await t.onSessionStart(S, f);
    await t.poll();
    const h1 = t.entries()[0]!.next_line;
    expect(h1).toBe(highMark(clock) + 3);
    await t.onSessionEnd(S);
    clock += 8 * day;
    await t.poll(); // pruned again
    clock -= 20 * day; // NTP step back: highMark(clock) < h1
    expect(highMark(clock)).toBeLessThan(h1);
    await t.onSessionStart(S, f);
    expect(t.entries()[0]!.next_line).toBeGreaterThanOrEqual(h1);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).max_issued).toBeGreaterThanOrEqual(h1);
  });

  it("a brand-new key starts at 0; only pruned or post-loss keys restart high", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const clock = Date.now();
    const t = mk({ now: () => clock });
    await t.onSessionStart("fresh", f);
    expect(t.entries()[0]!.next_line).toBe(0);
  });

  it("the post-loss high-mark window ends after PRUNED_KEEP_MS", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    writeFileSync(statePath(), "{nope");
    let clock = Date.now();
    const t = mk({ now: () => clock });
    await t.onSessionStart("a", f);
    expect(t.entries()[0]!.next_line).toBeGreaterThanOrEqual(highMark(clock));
    expect(JSON.parse(readFileSync(statePath(), "utf8")).lost_until).toBe(clock + PRUNED_KEEP_MS);
    clock += PRUNED_KEEP_MS + 1000;
    await t.poll(); // clears the window
    await t.onSessionStart("b", f);
    expect(t.entries().find((e) => e.session_id === "b")!.next_line).toBe(0);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).lost_until).toBeUndefined();
  });

  it("the offsets file stays bounded across many prune cycles", async () => {
    const day = 24 * 3600 * 1000;
    let clock = Date.now();
    const t = mk({ now: () => clock });
    const size = (): number => readFileSync(statePath(), "utf8").length;
    const sizes: number[] = [];
    for (let i = 0; i < 160; i++) {
      await t.onSessionStart(`sess-${i}-${"x".repeat(30)}`, join(dir, "none.jsonl"));
      await t.onSessionEnd(`sess-${i}-${"x".repeat(30)}`);
      clock += 8 * day;
      await t.poll();
      if (i === 59 || i === 159) sizes.push(size());
    }
    expect(sizes[1]!).toBeLessThanOrEqual(sizes[0]! * 1.2);
    expect(Object.keys(JSON.parse(readFileSync(statePath(), "utf8")).pruned).length).toBeLessThan(
      6,
    );
    expect(t.entries().length).toBeLessThan(3);
  }, 30_000);

  it("fsyncs through the real outbox (enqueue.sync) before persisting offsets", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const box = createOutbox(join(dir, "outbox"));
    const t = mk({ enqueue: box });
    await t.onSessionStart(S, f);
    const before = fsyncCalls.n;
    await t.poll();
    expect(fsyncCalls.n).toBeGreaterThan(before);
  });

  it("outbox sync fsyncs every day file written since the last sync", () => {
    const day = 24 * 3600 * 1000;
    let clock = Date.UTC(2026, 5, 1, 23, 59, 59);
    const box = createOutbox(join(dir, "ob"), () => clock);
    const line = (id: string): SpoolLine =>
      ({ v: 1, id, kind: "probe", host: "h", os: "linux", ts: 1, payload: {} }) as SpoolLine;
    box(line("a"));
    clock += 2000; // next UTC day
    box(line("b"));
    expect(clock % day).toBeLessThan(5000);
    const before = fsyncCalls.n;
    box.sync();
    expect(fsyncCalls.n - before).toBe(2);
    box.sync();
    expect(fsyncCalls.n - before).toBe(2); // nothing pending
  });

  it("syncs the outbox before persisting offsets", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const order: string[] = [];
    const t = mk({
      enqueue: (l) => {
        order.push("enqueue");
        out.push(l);
      },
      syncOutbox: () => order.push("sync"),
    });
    await t.onSessionStart(S, f);
    await t.poll();
    expect(order.slice(-2)).toEqual(["enqueue", "sync"]);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).files[`${S}|`].offset).toBeGreaterThan(0);
  });

  it("one unreadable file does not stop the others from draining", async () => {
    const bad = join(dir, "bad.jsonl");
    mkdirSync(bad); // EISDIR on read
    const good = join(dir, "good.jsonl");
    writeFileSync(good, nl(gen(0, 2)));
    const logs: string[] = [];
    const t = mk({ log: (lv, m) => logs.push(`${lv} ${m}`) });
    await t.onSessionStart("bad", bad);
    await t.onSessionStart("good", good);
    await t.poll();
    expect(out.some((l) => l.session_id === "good")).toBe(true);
    expect(logs.some((l) => l.startsWith("warn") && l.includes("bad.jsonl"))).toBe(true);
  });

  it("a transient read error on load does not let persist overwrite the offsets", async () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const t1 = mk();
    await t1.onSessionStart(S, f);
    await t1.poll();
    const good = readFileSync(statePath(), "utf8");
    // a directory at the path makes readFile fail with EISDIR (not ENOENT)
    renameSync(statePath(), `${statePath()}.bak`);
    mkdirSync(statePath());
    const t2 = mk();
    await expect(t2.start()).rejects.toThrow();
    await expect(t2.poll()).rejects.toThrow();
    rmSync(statePath(), { recursive: true });
    renameSync(`${statePath()}.bak`, statePath());
    await t2.poll();
    expect(readFileSync(statePath(), "utf8")).toBe(good);
    expect(t2.entries()[0]!.offset).toBeGreaterThan(0);
  });
});

describe("isUnder", () => {
  it("table", () => {
    expect(isUnder("/a/b/c.jsonl", "/a/b")).toBe(true);
    expect(isUnder("/a/b/s/subagents/x.jsonl", "/a/b/")).toBe(true);
    expect(isUnder("/a/bc/x.jsonl", "/a/b")).toBe(false); // sibling prefix
    expect(isUnder("/a/b", "/a/b")).toBe(false);
    expect(isUnder("/a/b/../c/x.jsonl", "/a/b")).toBe(false);
    expect(isUnder("/a/b/..x/y.jsonl", "/a/b")).toBe(true); // a name starting with two dots
    expect(isUnder("C:\\Users\\X\\p\\a.jsonl", "c:/users/x/p")).toBe(true); // win32 case
    expect(isUnder("C:\\Users\\X\\p2\\a.jsonl", "C:\\Users\\X\\p")).toBe(false);
    expect(isUnder("C:\\p\\..\\q\\a.jsonl", "C:\\p")).toBe(false);
    expect(isUnder("D:\\p\\a.jsonl", "C:\\p")).toBe(false);
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

// D-S2-10: the daemon only tails files under its own <config>/projects; the spool is untrusted.
describe("transcript containment (D-S2-10)", () => {
  const junction = process.platform === "win32" ? ("junction" as const) : undefined;
  const logs: string[] = [];
  let proj: string;
  let outside: string;
  beforeEach(() => {
    logs.length = 0;
    proj = join(dir, "proj");
    outside = join(dir, "outside");
    mkdirSync(proj, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  const tail = (extra: Partial<TranscriptTailerOptions> = {}): TranscriptTailer =>
    mk({ projectsDir: proj, log: (lv, m) => logs.push(`${lv} ${m}`), ...extra });
  const hookEnv = (name: string, sid: string, p: Record<string, unknown>): Envelope =>
    ({
      v: 1,
      id: "x",
      kind: "hook",
      host: "h",
      os: "linux",
      session_id: sid,
      hook_event_name: name,
      ts: 1,
      seq: 0,
      payload: p,
    }) as Envelope;

  it("S1: a SessionStart transcript_path outside projects is refused and logged once", async () => {
    const secret = join(outside, "id_ed25519");
    writeFileSync(secret, nl(gen(0, 3, "SECRET")));
    const t = tail();
    for (let i = 0; i < 3; i++)
      t.onSpoolLine(hookEnv("SessionStart", S, { transcript_path: secret }));
    await t.poll();
    await t.onSessionStart(S, secret);
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
    expect(logs.filter((l) => l.includes("outside the projects dir"))).toHaveLength(1);
  });

  it("S1: with no projects dir configured everything is refused", async () => {
    const f = join(proj, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const t = noProjects({ log: (lv, m) => logs.push(`${lv} ${m}`) });
    await t.onSessionStart(S, f);
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("warn"))).toBe(true);
  });

  it("S1: a path inside projects is still tailed", async () => {
    const f = join(proj, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const t = tail();
    await t.onSessionStart(S, f);
    await t.poll();
    expect(flat()).toEqual(gen(0, 2));
  });

  it("S2: a bogus main path does not become a trust root for SubagentStop", async () => {
    const sub = join(outside, "subagents", "agent-a1.jsonl");
    mkdirSync(join(outside, "subagents"), { recursive: true });
    writeFileSync(sub, nl(gen(0, 2, "X")));
    const t = tail();
    await t.onSessionStart(S, join(outside, "main.jsonl")); // refused
    await t.onSubagentStop(S, "a1", sub);
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
  });

  it("S3: a traversing session id or an outside base path never derives an agent file", async () => {
    mkdirSync(join(outside, "x", "subagents"), { recursive: true });
    writeFileSync(join(outside, "x", "subagents", "agent-a1.jsonl"), nl(gen(0, 2, "X")));
    const t = tail();
    await t.onSubagentStart("../outside/x", "a1", join(proj, "m.jsonl"));
    await t.onSubagentStart("x", "a1", join(outside, "m.jsonl")); // derived path is outside
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith("warn")).length).toBeGreaterThanOrEqual(2);
  });

  it("S4: a file swapped for a link to an outside file after tracking is not followed", async () => {
    const f = join(proj, "t.jsonl");
    writeFileSync(f, nl(gen(0, 2)));
    const secret = join(outside, "secret.jsonl");
    writeFileSync(secret, nl(gen(0, 10, "SECRET")));
    const t = tail();
    await t.onSessionStart(S, f);
    await t.poll();
    expect(flat()).toEqual(gen(0, 2));
    rmSync(f);
    symlinkSync(secret, f, process.platform === "win32" ? "file" : undefined);
    await t.poll();
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(logs.some((l) => l.includes("now resolves outside"))).toBe(true);
  });

  it("S4: a parent directory swapped for a junction/symlink is not followed", async () => {
    const d = join(proj, "d");
    mkdirSync(d);
    const f = join(d, "t.jsonl");
    writeFileSync(f, nl(gen(0, 1)));
    writeFileSync(join(outside, "t.jsonl"), nl(gen(0, 9, "SECRET")));
    const t = tail();
    await t.onSessionStart(S, f);
    await t.poll();
    rmSync(d, { recursive: true });
    symlinkSync(outside, d, junction);
    await t.poll();
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("S4: saved entries that point outside projects are dropped on load", async () => {
    const secret = join(outside, "secret.jsonl");
    writeFileSync(secret, nl(gen(0, 3, "SECRET")));
    const good = join(proj, "g.jsonl");
    writeFileSync(good, nl(gen(0, 1)));
    const sig = { ino: 0, birthtimeMs: 0, ctimeMs: 0, mtimeMs: 0, head: "" };
    const ent = (sid: string, p: string): object => ({
      session_id: sid,
      path: p,
      offset: 0,
      next_line: 0,
      resets: 0,
      sig,
    });
    writeFileSync(
      statePath(),
      JSON.stringify({ v: 1, files: { "bad|": ent("bad", secret), "good|": ent("good", good) } }),
    );
    const t = tail();
    await t.start();
    await t.poll();
    expect(t.entries().map((e) => e.session_id)).toEqual(["good"]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    await t.stop();
  });

  it("S5: a hard link inside projects to an outside file is refused", async () => {
    const secret = join(outside, "secret.jsonl");
    writeFileSync(secret, nl(gen(0, 3, "SECRET")));
    const l = join(proj, "linked.jsonl");
    linkSync(secret, l);
    const t = tail();
    await t.onSessionStart(S, l);
    await t.poll();
    expect(out).toHaveLength(0);
    expect(t.entries()).toHaveLength(0);
  });
});
