import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { deleteLayout, listLayouts, putLayout, type LayoutRow } from "../db/layouts.ts";
import type { Store } from "../db/store.ts";

const MAX_SPEC_BYTES = 32 * 1024;
const MAX_DEPTH = 16;
const PUT_BODY_LIMIT = 64 * 1024;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

function depthOf(v: unknown, d = 1): number {
  if (typeof v !== "object" || v === null) return d;
  let max = d;
  for (const c of Array.isArray(v) ? v : Object.values(v)) {
    const x = depthOf(c, d + 1);
    if (x > max) max = x;
    if (max > MAX_DEPTH) return max;
  }
  return max;
}

const Spec = z.record(z.string(), z.unknown()).superRefine((s, ctx) => {
  if (s["version"] !== 1) ctx.addIssue({ code: "custom", message: "version" });
  const root = s["root"];
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    ctx.addIssue({ code: "custom", message: "root" });
  }
  if (depthOf(s) > MAX_DEPTH) ctx.addIssue({ code: "custom", message: "depth" });
  else if (Buffer.byteLength(JSON.stringify(s), "utf8") > MAX_SPEC_BYTES) {
    ctx.addIssue({ code: "custom", message: "size" });
  }
});

// strict: a `builtin` (or any unknown) key is rejected; builtin rows are not writable here.
const PutBody = z
  .object({
    name: z.string().min(1).max(80),
    hotkey: z.number().int().min(1).max(9).nullable(),
    host: z.string().min(1).max(128).nullable(),
    spec: Spec,
  })
  .strict();

const ListQuery = z.object({ host: z.string().min(1).max(128).optional() });

const wire = (r: LayoutRow) => ({ ...r, spec: JSON.parse(r.spec) as unknown });
const bad = (reply: FastifyReply, reason: string) =>
  reply.code(400).send({ error: "invalid_body", reason });

export function registerLayouts(app: FastifyInstance, store: Store, now: () => number): void {
  // Auth: the global onRequest bearer hook covers every route here (reads and writes alike).
  app.get("/layouts", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: "invalid_query", reason: "host" });
    }
    return { layouts: listLayouts(store, q.data.host).map(wire) };
  });

  app.put<{ Params: { id: string } }>(
    "/layouts/:id",
    { bodyLimit: PUT_BODY_LIMIT },
    async (req, reply) => {
      const id = Id.safeParse(req.params.id);
      if (!id.success) return bad(reply, "id");
      const b = PutBody.safeParse(req.body);
      if (!b.success) {
        return bad(reply, b.error.issues.map((i) => [...i.path, i.message].join(".")).join(","));
      }
      const r = putLayout(
        store,
        { id: id.data, ...b.data, spec: JSON.stringify(b.data.spec) },
        now(),
      );
      if (!r.ok) {
        return reply
          .code(r.reason === "builtin" ? 403 : 409)
          .send({ error: r.reason === "builtin" ? "builtin_readonly" : "layout_limit" });
      }
      return wire(r.row);
    },
  );

  app.delete<{ Params: { id: string } }>("/layouts/:id", async (req, reply) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return reply.code(404).header("content-length", "0").send();
    const r = deleteLayout(store, id.data);
    if (r === "missing") return reply.code(404).header("content-length", "0").send();
    if (r === "builtin") return reply.code(403).send({ error: "builtin_readonly" });
    return reply.code(204).send();
  });
}
