// Shared envelope synthesizer for scripts/bench-replay.ts (R2.9) and scripts/load-ingest.mjs
// (R2.4). Mix per session: 80% hook (the golden session's non-lifecycle hooks cycled in order),
// 12% statusline (the captured statusLine fixtures cycled), 3% liveness, 5% transcript (5 lines
// of 400-800 bytes each); every session has a SessionStart and a SessionEnd. Deterministic for a
// given seed. See bench-replay.ts for the volume rationale.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Envelope } from "@sessiondeck/contract";

export type Rec = Record<string, unknown>;

export const HOSTS = ["laptop-win", "dev-box-linux"];
const FIX = path.resolve(import.meta.dirname, "../../contract/fixtures");

// Deterministic PRNG (mulberry32) so runs are comparable.
export function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(n: number): string {
  let s = "";
  let v = n;
  for (let i = 0; i < 25; i++) {
    s = B32[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return `0${s}`;
}

let cache: { start: Rec; end: Rec; middle: Rec[]; statuses: Rec[] } | undefined;
function fixtures(): NonNullable<typeof cache> {
  if (cache !== undefined) return cache;
  const golden = readFileSync(path.join(FIX, "sessions/golden-session.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Rec);
  cache = {
    start: golden.find((p) => p["hook_event_name"] === "SessionStart") as Rec,
    end: golden.find((p) => p["hook_event_name"] === "SessionEnd") as Rec,
    middle: golden.filter(
      (p) => !["SessionStart", "SessionEnd"].includes(String(p["hook_event_name"])),
    ),
    statuses: readdirSync(path.join(FIX, "statusLine"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(FIX, "statusLine", f), "utf8")) as Rec),
  };
  return cache;
}

export interface SynthOptions {
  sessions: number;
  totalEvents: number;
  /** Session start times are spread evenly over [t0, t0 + spanMs). */
  t0: number;
  spanMs: number;
  seed?: number;
  hosts?: string[];
  /** First ULID counter and first per-host seq (offsets keep repeated runs from deduplicating). */
  idStart?: number;
  seqStart?: number;
  sidPrefix?: string;
}

/** One session's envelopes in generation order (ts non-decreasing within the session). */
export function* synthSessions(
  o: SynthOptions,
): Generator<{ host: string; session_id: string; envelopes: Envelope[] }> {
  const { start, end, middle, statuses } = fixtures();
  const hosts = o.hosts ?? HOSTS;
  const rand = rng(o.seed ?? 42);
  const perSession = Math.round(o.totalEvents / o.sessions);
  const seqOf = new Map<string, number>();
  let id = o.idStart ?? 1;
  for (let s = 0; s < o.sessions; s++) {
    const host = hosts[s % hosts.length] as string;
    const sid = `${o.sidPrefix ?? "bench"}-${String(s).padStart(4, "0")}-${ulid(s + 1)
      .slice(-8)
      .toLowerCase()}`;
    let ts = o.t0 + Math.floor((s / o.sessions) * o.spanMs);
    const out: Envelope[] = [];
    const push = (kind: Envelope["kind"], payload: Rec, hook?: string): void => {
      const seq = (seqOf.get(host) ?? o.seqStart ?? 0) + 1;
      seqOf.set(host, seq);
      out.push({
        v: 1,
        id: ulid(id++),
        kind,
        host,
        os: host.includes("win") ? "win32" : "linux",
        session_id: sid,
        ...(hook !== undefined ? { hook_event_name: hook } : {}),
        ts,
        seq,
        payload,
      } as Envelope);
    };
    const step = (): void => {
      // Bursts of 5-20 envelopes/s, then an idle gap.
      ts += Math.floor(1000 / (5 + rand() * 15));
      if (rand() < 0.02) ts += 5000 + Math.floor(rand() * 55_000);
    };
    push("hook", { ...start, session_id: sid }, "SessionStart");
    let hookIdx = 0;
    let statusIdx = 0;
    while (out.length < perSession - 1) {
      step();
      const r = rand();
      if (r < 0.12) {
        push("statusline", {
          ...(statuses[statusIdx++ % statuses.length] as Rec),
          session_id: sid,
        });
      } else if (r < 0.15) {
        push("liveness", { pid: 10_000 + s, alive: true });
        ts += 6000; // keeps repeats of the identical liveness payload outside the 5 s signature window
      } else if (r < 0.2) {
        const lineNo = out.length * 5;
        const lines = Array.from({ length: 5 }, (_, k) =>
          JSON.stringify({ n: lineNo + k, text: "x".repeat(400 + Math.floor(rand() * 400)) }),
        );
        push("transcript", { start_line: lineNo, lines });
      } else {
        const p = middle[hookIdx++ % middle.length] as Rec;
        push("hook", { ...p, session_id: sid }, String(p["hook_event_name"]));
      }
    }
    step();
    push("hook", { ...end, session_id: sid }, "SessionEnd");
    yield { host, session_id: sid, envelopes: out };
  }
}
