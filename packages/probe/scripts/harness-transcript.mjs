// Transcript tailer harness (R1.6). Drives the real TranscriptTailer against real files in a temp
// home, writing into the real daemon outbox, through restarts, a partial line, compaction rewrites,
// an atomic replace, and a subagent transcript. Prints evidence lines; exit 1 on any loss.
//   node scripts/harness-transcript.mjs        (Node 22.18+ runs the .ts sources directly)
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox } from "../src/daemon/outbox.ts";
import { TranscriptTailer } from "../src/daemon/transcript.ts";

const home = mkdtempSync(join(tmpdir(), "sd-harness-transcript-"));
const outbox = join(home, "daemon", "outbox");
const proj = join(home, "projects", "p");
const S = "11111111-2222-3333-4444-555555555555";
const main = join(proj, `${S}.jsonl`);
const subDir = join(proj, S, "subagents");
mkdirSync(subDir, { recursive: true });
const sub = join(subDir, "agent-abc123.jsonl");

const expected = { "": [], abc123: [] };
let counter = 0;
const mkLines = (n, agent) =>
  Array.from({ length: n }, () => {
    const l = JSON.stringify({ n: counter++, agent, pad: "x".repeat(40) });
    expected[agent].push(l);
    return l;
  });
const append = (f, lines) => appendFileSync(f, lines.map((l) => `${l}\n`).join(""));
const rewrite = (f, lines, how) => {
  if (how === "replace") {
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, lines.map((l) => `${l}\n`).join(""));
    renameSync(tmp, f);
  } else writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
};
const newTailer = () =>
  new TranscriptTailer({
    statePath: join(home, "daemon", "transcript-offsets.json"),
    enqueue: createOutbox(outbox),
    host: "harness",
    pollMs: 0,
  });

let t = newTailer();
let restarts = 0;
const restart = () => {
  t = newTailer();
  restarts += 1;
};

await t.onSessionStart(S, main);
writeFileSync(main, "");
append(main, mkLines(40, ""));
await t.poll();
restart();
append(main, mkLines(30, ""));
// partial trailing line: half a line now, the rest later
const partial = JSON.stringify({ n: counter++, agent: "", pad: "partial" });
expected[""].push(partial);
appendFileSync(main, partial.slice(0, 10));
await t.poll();
appendFileSync(main, `${partial.slice(10)}\n`);
await t.poll();
// subagent announced, then it writes
await t.onSubagentStart(S, "abc123", main);
writeFileSync(sub, "");
append(sub, mkLines(25, "abc123"));
await t.poll();
restart();
// compaction 1: file rewritten smaller (history replaced by a short summary)
rewrite(main, mkLines(3, ""), "truncate");
await t.poll();
append(main, mkLines(20, ""));
append(sub, mkLines(10, "abc123"));
await t.poll();
restart();
// compaction 2: atomic replace by a LARGER file
rewrite(main, mkLines(60, ""), "replace");
await t.poll();
append(sub, mkLines(15, "abc123"));
append(main, mkLines(5, ""));
await t.onSessionEnd(S);
append(main, mkLines(5, "")); // after SessionEnd: must not be delivered
expected[""].length -= 5;
await t.poll();

const got = { "": new Map(), abc123: new Map() };
let dupes = 0;
for (const f of readdirSync(outbox)) {
  for (const raw of readFileSync(join(outbox, f), "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(raw);
    if (e.kind !== "transcript") continue;
    const m = got[e.agent_id ?? ""];
    e.payload.lines.forEach((l, i) => {
      const k = e.payload.start_line + i;
      if (m.has(k)) dupes += 1;
      m.set(k, l);
    });
  }
}
const seq = (m) => [...m.keys()].sort((a, b) => a - b).map((k) => m.get(k));
const mainOk = JSON.stringify(seq(got[""])) === JSON.stringify(expected[""]);
const subOk = JSON.stringify(seq(got.abc123)) === JSON.stringify(expected.abc123);
const contiguous = (m) => [...m.keys()].every((k, i) => k === i);
const written = expected[""].length + expected.abc123.length;
const delivered = got[""].size + got.abc123.size;
const resets = t.entries().reduce((a, e) => a + e.resets, 0);
console.log(
  `R1.6 lines_written=${written} delivered=${delivered} duplicates=${dupes} resets=${resets} subagent_lines=${got.abc123.size} restarts=${restarts}`,
);
console.log(
  `R1.6 order_main=${mainOk ? "ok" : "BAD"} order_subagent=${subOk ? "ok" : "BAD"} start_line_contiguous=${contiguous(got[""]) && contiguous(got.abc123)} stopped_after_session_end=${got[""].size === expected[""].length}`,
);
rmSync(home, { recursive: true, force: true });
const pass = mainOk && subOk && dupes === 0 && delivered === written && resets === 2;
console.log(pass ? "RESULT pass" : "RESULT FAIL");
process.exit(pass ? 0 : 1);
