import { useCallback, useEffect, useRef } from "react";
import { useNow } from "../hooks/useNow";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";
import { DetailDrawer } from "./DetailDrawer";

/** Focuses the card for a session, found by id (the node may have been re-created meanwhile). */
export function focusCard(id: string): void {
  const cards = document.querySelectorAll<HTMLElement>('[data-testid="session-card"]');
  for (const c of cards) {
    if (c.dataset["sessionId"] === id) {
      c.focus();
      return;
    }
  }
}

/**
 * Mounts the drawer for ui.selectedSessionId. Subscribes to the one session and its history, not
 * the whole store. When the drawer closes, focus goes back to that session's card.
 */
export function DrawerHost() {
  const id = useUi((s) => s.selectedSessionId);
  const closeSession = useUi((s) => s.closeSession);
  const session = useBoard((s) => (id === null ? undefined : s.sessions[id]));
  const history = useBoard((s) => (id === null ? undefined : s.history[id]));
  const now = useNow(1000 * 30);
  const open = id !== null && session !== undefined;
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      openedFor.current = id;
    } else if (openedFor.current !== null) {
      focusCard(openedFor.current);
      openedFor.current = null;
    }
  }, [open, id]);

  // The session vanished (resync dropped it): drop the selection so board keys come back.
  useEffect(() => {
    if (id !== null && session === undefined) closeSession();
  }, [id, session, closeSession]);

  const onClose = useCallback(() => closeSession(), [closeSession]);
  if (!open) return null;
  return <DetailDrawer session={session} history={history} now={now} onClose={onClose} />;
}
