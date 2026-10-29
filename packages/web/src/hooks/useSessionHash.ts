import { useEffect, useRef, useState } from "react";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

const PREFIX = "#session-";
/** The contract sets no session_id cap; ids are UUID-like, so 256 is generous. */
export const MAX_ID_CHARS = 256;

export function parse(hash: string): string | null {
  if (!hash.startsWith(PREFIX) || hash.length === PREFIX.length) return null;
  // Raw length first so an oversized value is never decoded.
  if (hash.length - PREFIX.length > MAX_ID_CHARS * 9) return null;
  try {
    const id = decodeURIComponent(hash.slice(PREFIX.length));
    return id.length > MAX_ID_CHARS ? null : id;
  } catch {
    return null;
  }
}

/**
 * Keeps ui.selectedSessionId and the `#session-<id>` hash in step (R3.11). Opening sets the hash,
 * closing clears it, a hash present at load (or arriving via the address bar or Back) opens that
 * session once the board knows it. An unknown id opens nothing and breaks nothing.
 */
export function useSessionHash(): void {
  const selected = useUi((s) => s.selectedSessionId);
  const [hashId, setHashId] = useState<string | null>(() => parse(window.location.hash));
  const known = useBoard((s) => (hashId !== null ? Object.hasOwn(s.sessions, hashId) : false));
  const prevHash = useRef(hashId);
  const started = useRef(false);
  const pushed = useRef(false); // this hook pushed the history entry for the open popout
  // Latest values for the selection effect, which must react to `selected` only.
  const latest = useRef({ hashId, known });
  latest.current = { hashId, known };

  useEffect(() => {
    const onHash = () => setHashId(parse(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Hash -> selection.
  useEffect(() => {
    const was = prevHash.current;
    prevHash.current = hashId;
    const ui = useUi.getState();
    if (hashId !== null) {
      if (known && ui.selectedSessionId !== hashId) {
        // Selection came from the hash side: any entry we pushed earlier belongs to another session.
        pushed.current = false;
        ui.openSession(hashId);
      }
    } else if (was !== null && ui.selectedSessionId !== null) {
      ui.closeSession();
    }
  }, [hashId, known]);

  // Selection -> hash. The first run only observes: a hash present at load is for the other
  // effect to open, not to clear.
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      return;
    }
    const { hashId: pending, known: pendingKnown } = latest.current;
    try {
      if (selected !== null) {
        const want = `${PREFIX}${encodeURIComponent(selected)}`;
        if (window.location.hash !== want) {
          window.location.hash = want;
          pushed.current = true;
        }
        setHashId(selected);
        prevHash.current = selected;
      } else if (window.location.hash.startsWith(PREFIX) && parse(window.location.hash) !== null) {
        // Selection null while a hash is pending for a not-yet-known session: leave it alone.
        if (pending !== null && !pendingKnown) return;
        if (pushed.current) window.history.back();
        else
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        pushed.current = false;
        setHashId(null);
        prevHash.current = null;
      }
    } catch {
      /* location unavailable */
    }
  }, [selected]);
}
