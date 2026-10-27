// R5.1, R5.5, R5.6. Projects, phases and the project view. Auth is the global onRequest bearer hook
// (every route but /health), so the PATCH routes need the same token as ingest and reads.
import type { SessionSnapshot } from "@sessiondeck/contract";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { inferPhase } from "../atlas/infer.ts";
import type { Store } from "../db/store.ts";
import type { PricingProvider } from "../pricing/loader.ts";
import { LIVE_GRACE_MS, MAX_LIMIT, readSnapshot } from "../snapshots.ts";
import type { UsageService } from "../usage/service.ts";

export const ARCHIVED_LIMIT = 20;

export type AnnotatedSnapshot = SessionSnapshot & {
  project_id: string | null;
  project_name: string | null;
  project_color: string | null;
  phase: string | null;
  phase_source: "manual" | "inferred" | null;
};

/** Effective phase: the manual label wins over the inferred default. */
export function effectivePhase(
  manual: string | null,
  snap: Pick<SessionSnapshot, "session_name" | "git">,
): { phase: string | null; source: "manual" | "inferred" | null } {
  if (manual !== null && manual !== "") return { phase: manual, source: "manual" };
  const inf = inferPhase(snap.session_name, snap.git?.branch);
  return inf === null ? { phase: null, source: null } : { phase: inf, source: "inferred" };
}

/** Additive REST fields; the contract snapshot type (and the WS payload) is unchanged. */
export function annotateSessions(store: Store, snaps: SessionSnapshot[]): AnnotatedSnapshot[] {
  const atlas = store.getSessionAtlas(snaps.map((s) => s.session_id));
  const projects = new Map(store.listProjectSummaries(100_000).map((p) => [p.id, p]));
  return snaps.map((s) => {
    const a = atlas.get(s.session_id);
    const p = a?.project_id != null ? projects.get(a.project_id) : undefined;
    const ph = effectivePhase(a?.phase_label ?? null, s);
    return {
      ...s,
      project_id: a?.project_id ?? null,
      project_name: p?.name ?? null,
      project_color: p?.color ?? null,
      phase: ph.phase,
      phase_source: ph.source,
    };
  });
}

const color = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
  z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), // design token name
]);
const PatchProject = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    color: color.optional(),
    vault_collection: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, "empty patch");
const PatchSessionProject = z.object({ project_id: z.string().min(1).max(64).nullable() }).strict();
const PatchPhase = z.object({ phase: z.string().trim().min(1).max(60).nullable() }).strict();

function bad(reply: FastifyReply, err: z.ZodError) {
  return reply
    .code(400)
    .send({ error: "invalid_body", reason: err.issues.map((i) => i.path.join(".")).join(",") });
}
const notFound = (reply: FastifyReply) => reply.code(404).header("content-length", "0").send();

export function registerAtlas(
  app: FastifyInstance,
  store: Store,
  now: () => number,
  usage: UsageService,
  pricing: PricingProvider,
  defaultTz: string | undefined,
): void {
  // Superset of the legacy shape (project_dir, name, color, vault_collection) plus id and counts.
  app.get("/projects", async () => ({ projects: store.listProjectSummaries(MAX_LIMIT) }));

  app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (project === undefined) return notFound(reply);
    const t = now();
    const live = store
      .listProjectLive(project.id, t - LIVE_GRACE_MS, MAX_LIMIT)
      .map((r) => readSnapshot(r, t));
    const archived = store
      .listProjectArchived(project.id, ARCHIVED_LIMIT)
      .map((r) => readSnapshot(r, t));
    const totals = store.projectTotals(project.id);

    await usage.refresh();
    const table = pricing.current();
    let cost = 0;
    for (const id of totals.ids) {
      cost += usage.index.sessions(table, defaultTz, id)[0]?.cost_usd ?? 0;
    }

    // Active branches: distinct git branches of sessions that have not ended, exited or been archived.
    const counts = new Map<string, number>();
    for (const r of store.listProjectSessionSnapshots(project.id, MAX_LIMIT * 10)) {
      if (r.state === "ended" || r.state === "exited" || r.state === "archived") continue;
      const b = (JSON.parse(r.snapshot) as SessionSnapshot).git?.branch;
      if (typeof b === "string" && b !== "") counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return {
      project,
      live: annotateSessions(store, live),
      archived: annotateSessions(store, archived),
      totals: { sessions: totals.sessions, hours: totals.hours, cost_usd: cost },
      branches: [...counts]
        .map(([branch, sessions]) => ({ branch, sessions }))
        .sort((a, b) => b.sessions - a.sessions || a.branch.localeCompare(b.branch)),
    };
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    const body = PatchProject.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    // exactOptionalPropertyTypes: pass only the keys that are present.
    const patch: { name?: string; color?: string; vault_collection?: string | null } = {};
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.color !== undefined) patch.color = body.data.color;
    if (body.data.vault_collection !== undefined)
      patch.vault_collection = body.data.vault_collection;
    if (!store.patchProject(req.params.id, patch)) return notFound(reply);
    return { project: store.getProject(req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/projects/:id/phases", async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (project === undefined) return notFound(reply);
    const counts = new Map<string, number>();
    for (const r of store.listProjectSessionSnapshots(project.id, MAX_LIMIT * 10)) {
      const snap = JSON.parse(r.snapshot) as SessionSnapshot;
      const { phase } = effectivePhase(r.phase_label, snap);
      if (phase !== null) counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
    const collator = new Intl.Collator("en", { numeric: true });
    return {
      phases: [...counts]
        .map(([phase, sessions]) => ({ phase, sessions }))
        .sort((a, b) => collator.compare(a.phase, b.phase)),
    };
  });

  const view = (id: string) => {
    const row = store.getSession(id);
    return row === undefined ? undefined : annotateSessions(store, [readSnapshot(row, now())])[0];
  };

  app.patch<{ Params: { id: string } }>("/sessions/:id/project", async (req, reply) => {
    const body = PatchSessionProject.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.setSessionProject(req.params.id, body.data.project_id)) return notFound(reply);
    return view(req.params.id);
  });

  app.patch<{ Params: { id: string } }>("/sessions/:id/phase", async (req, reply) => {
    const body = PatchPhase.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.setSessionPhase(req.params.id, body.data.phase)) return notFound(reply);
    return view(req.params.id);
  });
}
