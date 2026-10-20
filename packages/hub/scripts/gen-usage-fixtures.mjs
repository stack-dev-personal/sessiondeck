// Generates the synthetic transcripts and the small pricing table used by the R2.10 test and the
// ccusage comparison harness. No real content: ids, text and cwd are made up. Deterministic.
//   node scripts/gen-usage-fixtures.mjs
// Layout (CLAUDE_CONFIG_DIR style): projects/<project>/<session>.jsonl and
// projects/<project>/<session>/subagents/agent-<id>.jsonl
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../test/fixtures/transcripts");
rmSync(path.join(out, "projects"), { recursive: true, force: true });

const S1 = "11111111-aaaa-4bbb-8ccc-000000000001";
const S2 = "22222222-aaaa-4bbb-8ccc-000000000002";
// A `claude --resume` of S1: its own session id (sorts before S1) in another project dir, with the
// earlier assistant rows replayed under their original message ids and timestamps.
const S3 = "00000000-aaaa-4bbb-8ccc-000000000003";
const SONNET = "claude-sonnet-4-5-20250929";
const TIERED = "claude-sonnet-4-5-20250929-v1:0"; // has *_above_200k_tokens rates
const OPUS = "claude-opus-5"; // provider_specific_entry.fast = 2
const HAIKU = "claude-haiku-4-5-20251001";

let n = 0;
const user = (sessionId, ts, extra = {}) => ({
  type: "user",
  sessionId,
  timestamp: ts,
  cwd: "/synthetic/project",
  message: { role: "user", content: `synthetic prompt ${++n}` },
  ...extra,
});
function asst(sessionId, ts, o) {
  const usage = { input_tokens: o.in, output_tokens: o.out };
  if (o.cc !== undefined) usage.cache_creation_input_tokens = o.cc;
  if (o.cr !== undefined) usage.cache_read_input_tokens = o.cr;
  if (o.speed) usage.speed = o.speed;
  const message = { id: o.id, type: "message", role: "assistant", model: o.model, usage };
  if (o.id === undefined) delete message.id;
  const row = {
    type: "assistant",
    sessionId,
    timestamp: ts,
    version: "2.1.0",
    cwd: "/synthetic/project",
    message,
  };
  if (o.req) row.requestId = o.req;
  if (o.cost !== undefined) row.costUSD = o.cost;
  if (o.side) row.isSidechain = true;
  return row;
}

const s1 = [
  user(S1, "2026-01-01T10:00:00.000Z"),
  // streaming duplicates: same message.id + requestId, usage grows; the largest total must win
  asst(S1, "2026-01-01T10:00:01.000Z", {
    id: "msg_s1_a",
    req: "req_s1_a",
    model: SONNET,
    in: 3,
    out: 12,
    cc: 4000,
    cr: 0,
  }),
  asst(S1, "2026-01-01T10:00:02.000Z", {
    id: "msg_s1_a",
    req: "req_s1_a",
    model: SONNET,
    in: 3,
    out: 80,
    cc: 4000,
    cr: 0,
  }),
  asst(S1, "2026-01-01T10:00:03.000Z", {
    id: "msg_s1_a",
    req: "req_s1_a",
    model: SONNET,
    in: 3,
    out: 410,
    cc: 4000,
    cr: 0,
  }),
  // a late, smaller repeat must not replace the larger one
  asst(S1, "2026-01-01T10:00:04.000Z", {
    id: "msg_s1_a",
    req: "req_s1_a",
    model: SONNET,
    in: 3,
    out: 20,
    cc: 4000,
    cr: 0,
  }),
  user(S1, "2026-01-01T10:05:00.000Z"),
  // no requestId: hash is the message id alone
  asst(S1, "2026-01-01T10:05:01.000Z", {
    id: "msg_s1_b",
    model: SONNET,
    in: 12,
    out: 300,
    cc: 0,
    cr: 4000,
  }),
  // costUSD present: mode auto uses it instead of pricing the tokens
  asst(S1, "2026-01-01T10:06:00.000Z", {
    id: "msg_s1_c",
    req: "req_s1_c",
    model: SONNET,
    in: 50,
    out: 900,
    cc: 1200,
    cr: 5200,
    cost: 0.0421,
  }),
  // all-zero synthetic row, no id: counted in totals (zeros), excluded from models
  asst(S1, "2026-01-01T10:07:00.000Z", { model: "<synthetic>", in: 0, out: 0, cc: 0, cr: 0 }),
  // no message id at all: never deduplicated, so both identical rows count
  asst(S1, "2026-01-01T10:08:00.000Z", { model: HAIKU, in: 100, out: 200 }),
  asst(S1, "2026-01-01T10:08:00.000Z", { model: HAIKU, in: 100, out: 200 }),
  // above the 200k tier on a model that has tier rates
  asst(S1, "2026-01-01T10:09:00.000Z", {
    id: "msg_s1_big",
    req: "req_s1_big",
    model: TIERED,
    in: 250000,
    out: 3000,
    cc: 210000,
    cr: 230000,
  }),
  // fast speed on a model with a fast multiplier (model name gets a -fast suffix in ccusage)
  asst(S1, "2026-01-01T10:10:00.000Z", {
    id: "msg_s1_fast",
    req: "req_s1_fast",
    model: OPUS,
    in: 20,
    out: 700,
    cc: 800,
    cr: 9000,
    speed: "fast",
  }),
  // a model no price table knows: cost 0
  asst(S1, "2026-01-01T10:11:00.000Z", {
    id: "msg_s1_unk",
    req: "req_s1_unk",
    model: "acme-unpriced-1",
    in: 77,
    out: 88,
  }),
  // a sidechain row stored in the main file: ccusage has no sidechain filter, so it counts
  asst(S1, "2026-01-01T10:12:00.000Z", {
    id: "msg_s1_side",
    req: "req_s1_side",
    model: HAIKU,
    in: 10,
    out: 30,
    side: true,
  }),
  // spans a UTC day boundary
  asst(S1, "2026-01-01T23:59:30.000Z", {
    id: "msg_s1_d1",
    req: "req_s1_d1",
    model: OPUS,
    in: 9,
    out: 120,
    cc: 500,
    cr: 1000,
  }),
  asst(S1, "2026-01-02T00:00:30.000Z", {
    id: "msg_s1_d2",
    req: "req_s1_d2",
    model: OPUS,
    in: 9,
    out: 140,
    cc: 0,
    cr: 1500,
  }),
  "{ this line is not json",
  JSON.stringify({ type: "summary", summary: "no usage here", leafUuid: "x" }),
];

// subagent file: sidechain rows with the parent sessionId; it repeats msg_s1_c from the main file
// (the larger copy wins globally) and adds its own streaming pair.
const sub = [
  asst(S1, "2026-01-01T10:20:00.000Z", {
    id: "msg_sub_a",
    req: "req_sub_a",
    model: HAIKU,
    in: 5,
    out: 10,
    cc: 900,
    side: true,
  }),
  asst(S1, "2026-01-01T10:20:05.000Z", {
    id: "msg_sub_a",
    req: "req_sub_a",
    model: HAIKU,
    in: 5,
    out: 340,
    cc: 900,
    side: true,
  }),
  asst(S1, "2026-01-01T10:21:00.000Z", {
    id: "msg_s1_c",
    req: "req_s1_c",
    model: SONNET,
    in: 50,
    out: 1500,
    cc: 1200,
    cr: 5200,
    cost: 0.0421,
    side: true,
  }),
  asst(S1, "2026-01-02T00:30:00.000Z", {
    id: "msg_sub_b",
    req: "req_sub_b",
    model: SONNET,
    in: 400,
    out: 600,
    cc: 100,
    cr: 20000,
    side: true,
  }),
];

const s2 = [
  user(S2, "2026-01-02T08:00:00.000Z"),
  asst(S2, "2026-01-02T08:00:01.000Z", {
    id: "msg_s2_a",
    req: "req_s2_a",
    model: HAIKU,
    in: 1,
    out: 15,
    cc: 3000,
    cr: 0,
  }),
  asst(S2, "2026-01-02T08:00:09.000Z", {
    id: "msg_s2_a",
    req: "req_s2_a",
    model: HAIKU,
    in: 1,
    out: 640,
    cc: 3000,
    cr: 0,
  }),
  asst(S2, "2026-01-02T08:03:00.000Z", {
    id: "msg_s2_b",
    req: "req_s2_b",
    model: SONNET,
    in: 220,
    out: 4100,
    cc: 0,
    cr: 3000,
  }),
  asst(S2, "2026-01-03T22:30:00.000Z", {
    id: "msg_s2_c",
    req: "req_s2_c",
    model: OPUS,
    in: 15,
    out: 55,
    cc: 20,
    cr: 900,
  }),
];

const s3 = [
  user(S3, "2026-01-03T09:00:00.000Z"),
  // replay of msg_s1_a (streaming copy, smaller than the winner in S1): must not count again
  asst(S3, "2026-01-01T10:00:02.000Z", {
    id: "msg_s1_a",
    req: "req_s1_a",
    model: SONNET,
    in: 3,
    out: 80,
    cc: 4000,
    cr: 0,
  }),
  // replay of msg_s1_b with an identical total: a tie, ccusage keeps the copy in the file that
  // sorts first by path (-synthetic-proj-a/<S1> before -synthetic-proj-b/<S3>) although S3 sorts
  // first by session id
  asst(S3, "2026-01-01T10:05:01.000Z", {
    id: "msg_s1_b",
    model: SONNET,
    in: 12,
    out: 300,
    cc: 0,
    cr: 4000,
  }),
  // replay of msg_s2_a with the same total as the winner in S2: tie again, S3's path sorts first
  asst(S3, "2026-01-02T08:00:09.000Z", {
    id: "msg_s2_a",
    req: "req_s2_a",
    model: HAIKU,
    in: 1,
    out: 640,
    cc: 3000,
    cr: 0,
  }),
  // replay of msg_s2_b where this copy is larger: it wins and the cost moves to S3
  asst(S3, "2026-01-02T08:03:00.000Z", {
    id: "msg_s2_b",
    req: "req_s2_b",
    model: SONNET,
    in: 220,
    out: 4300,
    cc: 0,
    cr: 3000,
  }),
  // new work after the resume
  asst(S3, "2026-01-03T09:00:05.000Z", {
    id: "msg_s3_a",
    req: "req_s3_a",
    model: SONNET,
    in: 30,
    out: 500,
    cc: 600,
    cr: 8000,
  }),
];

function write(rel, rows) {
  const file = path.join(out, "projects", rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n",
  );
}
write(`-synthetic-proj-a/${S1}.jsonl`, s1);
write(`-synthetic-proj-a/${S1}/subagents/agent-a1b2c3.jsonl`, sub);
write(`-synthetic-proj-b/${S2}.jsonl`, s2);
write(`-synthetic-proj-b/${S3}.jsonl`, s3);

// Pricing subset (same shape as LiteLLM, source key order) taken from the bundled snapshot.
const snap = JSON.parse(
  readFileSync(path.join(here, "../src/pricing/litellm-claude.json"), "utf8"),
);
const keep = [SONNET, TIERED, OPUS, HAIKU, "claude-sonnet-4-5"];
const pricing = {};
for (const k of Object.keys(snap)) if (keep.includes(k)) pricing[k] = snap[k];
writeFileSync(path.join(out, "pricing.json"), JSON.stringify(pricing, null, 1) + "\n");
console.log("wrote", out, Object.keys(pricing).length, "prices");
