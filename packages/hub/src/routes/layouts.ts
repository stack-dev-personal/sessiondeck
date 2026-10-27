// Hotkey rule: a slot (1-9) is held per host scope (unpinned = all hosts, or one pinned host). On
// a host both scopes may hold the same slot; the PINNED layout wins for that host. GET /layouts
// reports this as `active_hotkey`: with ?host=<h>, true for the row the key opens on h (a pinned
// row for h, or an unpinned row whose slot no pinned row for h shadows), false for a shadowed or
// slotless row. Without ?host it reflects unpinned rows only (pinned rows are false).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { deleteLayout, listLayouts, putLayout, type LayoutRow } from "../db/layouts.ts";
import type { Store } from "../db/store.ts";

const MAX_SPEC_BYTES = 32 * 1024;
const MAX_DEPTH = 16;
const PUT_BODY_LIMIT = 64 * 1024;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

function depthOf(v: unknown, d = 1): number {
  if (d > MAX_DEPTH) return d;
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

const wire = (r: LayoutRow, active = false) => ({
  ...r,
  spec: JSON.parse(r.spec) as unknown,
  active_hotkey: active,
});

function withActive(rows: LayoutRow[], host: string | undefined) {
  const pinned = new Set(
    host === undefined
      ? []
      : rows.filter((r) => r.host === host && r.hotkey !== null).map((r) => r.hotkey),
  );
  return rows.map((r) => {
    if (r.hotkey === null) return wire(r);
    if (r.host === null) return wire(r, !pinned.has(r.hotkey));
    return wire(r, host !== undefined && r.host === host);
  });
}
const bad = (reply: FastifyReply, reason: string) =>
  reply.code(400).send({ error: "invalid_body", reason });

export function registerLayouts(
  app: FastifyInstance,
  store: Store,
  now: () => number,
  /** Takes one write token for the authenticated principal (header -> bucket); false = limited. */
  allowWrite: (authorization: string | string[] | undefined) => boolean,
): void {
  // Route-level, so it follows the matched route (not the raw URL: /%6Cayouts/x routes here too)
  // and runs after the global bearer hook.
  const writeGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowWrite(req.headers.authorization)) {
      return reply.code(429).header("content-length", "0").send();
    }
  };
  // Auth: the global onRequest bearer hook covers every route here (reads and writes alike).
  app.get("/layouts", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: "invalid_query", reason: "host" });
    }
    return { layouts: withActive(listLayouts(store, q.data.host), q.data.host) };
  });

  app.put<{ Params: { id: string } }>(
    "/layouts/:id",
    { bodyLimit: PUT_BODY_LIMIT, onRequest: writeGuard },
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
        return reply.code(r.reason === "builtin" ? 403 : 409).send({
          error:
            r.reason === "builtin"
              ? "builtin_readonly"
              : r.reason === "slot_reserved"
                ? "slot_reserved"
                : "layout_limit",
        });
      }
      const row = r.row;
      const scope = row.host ?? undefined;
      const mine = withActive(listLayouts(store, scope), scope).find((x) => x.id === row.id);
      return mine ?? wire(row, false);
    },
  );

  app.delete<{ Params: { id: string } }>("/layouts/:id", { onRequest: writeGuard }, async (req, reply) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return reply.code(404).header("content-length", "0").send();
    const r = deleteLayout(store, id.data);
    if (r === "missing") return reply.code(404).header("content-length", "0").send();
    if (r === "builtin") return reply.code(403).send({ error: "builtin_readonly" });
    return reply.code(204).send();
  });
}
