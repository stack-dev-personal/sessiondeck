// CORS for browser REST calls from the web app (R6.3: GET/PUT/DELETE /layouts with a bearer header).
//
// Default-deny: active only when HUB_ALLOWED_ORIGINS is non-empty. With an empty list this hook is
// not registered at all, so no CORS header is ever sent and OPTIONS behaves as it always did
// (cross-origin browser calls stay blocked; same-origin and non-browser clients are unaffected).
//
// Only an exact Origin match is echoed (never "*"), with Vary: Origin. No credentials header: auth is
// the bearer header, there are no cookies. Scope is the REST read routes and /layouts; /ingest
// (probe-only) and /stream (WS upgrades are not subject to CORS) are never CORS-enabled.
//
// Registered before the bearer hook: preflights carry no Authorization header, so they are answered
// here and skip auth and the rate limiters. A refused preflight gets 403 with an empty body and no
// ACAO (the browser then blocks the real call); 403 rather than 404 because the route may exist and
// the refusal is a policy decision.
import type { FastifyInstance } from "fastify";

const READ_PREFIXES = ["/sessions", "/projects", "/hosts", "/history"];
const PREFLIGHT_HEADERS = new Set(["authorization", "content-type"]);

/** Decoded path without the query, or null when it is malformed. Fastify routes on the decoded form. */
function pathOf(url: string): string | null {
  try {
    return decodeURIComponent(url.split("?")[0] ?? "");
  } catch {
    return null;
  }
}
const isLayouts = (p: string) => p === "/layouts" || p.startsWith("/layouts/");
const isRead = (p: string) => READ_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`));

/** True when `method` may be called cross-origin on `path`. */
function methodAllowed(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return isLayouts(path) || isRead(path);
  if (method === "PUT" || method === "DELETE") return isLayouts(path);
  return false;
}

export function registerCors(app: FastifyInstance, allowedOrigins: string[]): void {
  if (allowedOrigins.length === 0) return;
  const allowed = new Set(allowedOrigins);

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    const path = pathOf(req.url);
    const inScope = path !== null && (isLayouts(path) || isRead(path));
    const originOk = typeof origin === "string" && allowed.has(origin);

    const acrm = req.headers["access-control-request-method"];
    if (req.method === "OPTIONS" && typeof origin === "string" && typeof acrm === "string") {
      const acrh = req.headers["access-control-request-headers"];
      const wanted =
        typeof acrh === "string"
          ? acrh
              .split(",")
              .map((h) => h.trim().toLowerCase())
              .filter((h) => h !== "")
          : [];
      const ok =
        originOk &&
        path !== null &&
        methodAllowed(acrm, path) &&
        wanted.every((h) => PREFLIGHT_HEADERS.has(h));
      if (!ok) return reply.code(403).header("content-length", "0").send();
      return reply
        .code(204)
        .header("access-control-allow-origin", origin)
        .header("vary", "Origin")
        .header("access-control-allow-methods", "GET, HEAD, PUT, DELETE")
        .header("access-control-allow-headers", "Authorization, Content-Type")
        .header("access-control-max-age", "600")
        .send();
    }

    if (originOk && inScope) {
      reply.header("access-control-allow-origin", origin).header("vary", "Origin");
    }
  });
}
