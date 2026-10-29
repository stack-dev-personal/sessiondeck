import { useEffect, useRef, useState } from "react";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

const PREFIX = "#session-";

function parse(hash: string): string | null {
  if (!hash.startsWith(PREFIX) || hash.length === PREFIX.length) return null;
  try {
    return decodeURIComponent(hash.slice(PREFIX.length));
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
  const known = useBoard((s) => (hashId !== null ? hashId in s.sessions : false));
  const prevHash = useRef(hashId);

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
      if (known && ui.selectedSessionId !== hashId) ui.openSession(hashId);
    } else if (was !== null && ui.selectedSessionId !== null) {
      ui.closeSession();
    }
  }, [hashId, known]);

  // Selection -> hash.
  useEffect(() => {
    try {
      if (selected !== null) {
        const want = `${PREFIX}${encodeURIComponent(selected)}`;
        if (window.location.hash !== want) window.location.hash = want;
        setHashId(selected);
        prevHash.current = selected;
      } else if (window.location.hash.startsWith(PREFIX) && parse(window.location.hash) !== null) {
        // Selection null while a hash is pending for a not-yet-known session: leave it alone.
        if (hashId !== null && !known) return;
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        setHashId(null);
        prevHash.current = null;
      }
    } catch {
      /* location unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to selection only
  }, [selected]);
}
