import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.ts";
import { LIVE_GRACE_MS, MAX_LIMIT, readSnapshot } from "../snapshots.ts";

const uint = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const limitOf = (dflt: number) =>
  uint.pipe(z.number().int().min(1).max(MAX_LIMIT)).default(String(dflt));

// D-S3-12: the live set uses the same default (and maximum) as the WS initial message.
const ListQuery = z.object({
  limit: uint.pipe(z.number().int().min(1).max(MAX_LIMIT)).optional(),
  live: z.enum(["0", "1"]).optional(),
});
const DEFAULT_LIST_LIMIT = 200;
const EventsQuery = z.object({ after: uint.optional(), limit: limitOf(MAX_LIMIT) });
const TranscriptQuery = z.object({
  after: uint.optional(),
  agent_id: z.string().max(256).optional(),
  limit: limitOf(MAX_LIMIT),
});

function badQuery(reply: FastifyReply, err: z.ZodError) {
  return reply
    .code(400)
    .send({ error: "invalid_query", reason: err.issues.map((i) => i.path.join(".")).join(",") });
}

/** The live set shared by GET /sessions?live=1 and the WS initial message. */
export function liveSnapshots(
  store: Store,
  nowMs: number,
  limit = MAX_LIMIT,
  log?: { warn: (obj: object, msg: string) => void },
) {
  const out = store
    .listLiveSessions(nowMs - LIVE_GRACE_MS, limit)
    .map((r) => readSnapshot(r, nowMs));
  if (out.length >= limit) log?.warn({ count: out.length, limit }, "live session set truncated");
  return out;
}

export function registerRead(app: FastifyInstance, store: Store, now: () => number): void {
  // Auth is the global onRequest hook; every handler here is read-only with bound parameters.
  app.get("/sessions", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    const t = now();
    return q.data.live === "1"
      ? liveSnapshots(store, t, q.data.limit ?? MAX_LIMIT, app.log)
      : store.listSessions(q.data.limit ?? DEFAULT_LIST_LIMIT).map((r) => readSnapshot(r, t));
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const row = store.getSession(req.params.id);
    if (row === undefined) return reply.code(404).header("content-length", "0").send();
    return readSnapshot(row, now());
  });

  // D-S3-11: an authenticated audit view of the raw stored envelopes. The R2.7 staleness rule
  // applies to rendered snapshots (REST snapshot reads and WS), not to raw event payloads, so a
  // statusLine payload here may carry an out-of-range or expired used_percentage as received.
  app.get<{ Params: { id: string } }>("/sessions/:id/events", async (req, reply) => {
    const q = EventsQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    if (store.getSession(req.params.id) === undefined) {
      return reply.code(404).header("content-length", "0").send();
    }
    const rows = store.listSessionEvents(req.params.id, q.data.after ?? -1, q.data.limit);
    return {
      events: rows.map((e) => ({
        id: e.id,
        host: e.host,
        seq: e.seq,
        kind: e.kind,
        session_id: e.session_id,
        agent_id: e.agent_id,
        hook_event_name: e.hook_event_name,
        ts: e.ts,
        payload: JSON.parse(e.payload) as unknown,
      })),
    };
  });

  // Raw stored lines, no normalization (the normalizer is S7). `after` is a line_no in one agent's
  // numbering, so it requires agent_id (D-S3-13); agent_id '' (`agent_id=`) is the main session.
  // Without either, all agents' lines are returned up to limit, ordered (agent_id, line_no).
  app.get<{ Params: { id: string } }>("/sessions/:id/transcript", async (req, reply) => {
    const q = TranscriptQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    if (q.data.after !== undefined && q.data.agent_id === undefined) {
      return reply.code(400).send({ error: "invalid_query", reason: "after requires agent_id" });
    }
    if (store.getSession(req.params.id) === undefined) {
      return reply.code(404).header("content-length", "0").send();
    }
    const rows = store.listTranscriptLines(
      req.params.id,
      q.data.agent_id ?? null,
      q.data.after ?? -1,
      q.data.limit,
    );
    return {
      lines: rows.map((l) => ({ agent_id: l.agent_id, line_no: l.line_no, ts: l.ts, raw: l.raw })),
    };
  });

  app.get("/projects", async () => ({ projects: store.listProjects(MAX_LIMIT) }));

  // hosts rows hold no secrets (host, os, last_seen, last_seq).
  app.get("/hosts", async () => ({ hosts: store.listHosts(MAX_LIMIT) }));
}
