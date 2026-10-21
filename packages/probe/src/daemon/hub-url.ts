/**
 * Where the daemon may send the bearer token and the envelopes. Checked on every send, because
 * probe.json can be edited after install.
 *
 * https: anywhere. http: loopback only (localhost, 127.0.0.0/8, ::1), or any host when probe.json
 * sets `allowInsecureHub: true` (a LAN hub without TLS; the user opted in). Userinfo in the URL is
 * never accepted. Messages never contain the URL or the token.
 */
export type HubUrlCheck =
  | { ok: true; url: URL; insecure: boolean }
  | { ok: false; reason: "invalid" | "userinfo" | "scheme" | "cleartext" };

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && [m[1], m[2], m[3]].every((o) => Number(o) <= 255);
}

export function checkHubUrl(raw: string, allowInsecureHub = false): HubUrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "userinfo" };
  if (u.protocol === "https:") return { ok: true, url: u, insecure: false };
  if (u.protocol !== "http:") return { ok: false, reason: "scheme" };
  if (isLoopbackHost(u.hostname)) return { ok: true, url: u, insecure: false };
  if (allowInsecureHub) return { ok: true, url: u, insecure: true };
  return { ok: false, reason: "cleartext" };
}

export const HUB_URL_REFUSED =
  "hubUrl refused by policy (need https, http to loopback, or allowInsecureHub in probe.json, and no user:password in the URL); nothing is sent";
export const INSECURE_HUB_WARNING =
  "allowInsecureHub is set: the bearer token and envelopes are sent over cleartext http to a non-loopback host";
