import { useCallback, useEffect, useRef } from "react";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";
import { useSessionHash } from "../hooks/useSessionHash";
import { SessionPopout } from "./SessionPopout";

/** Focuses the card for a session, found by id (the node may have been re-created meanwhile). */
export function focusCard(id: string): boolean {
  const cards = document.querySelectorAll<HTMLElement>('[data-testid="session-card"]');
  for (const c of cards) {
    if (c.dataset["sessionId"] === id) {
      c.focus();
      return true;
    }
  }
  return false;
}

/** Id of the card after the given one in DOM order, else the one before it, else null. */
function neighbourOf(id: string): string | null {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="session-card"]'));
  const i = cards.findIndex((c) => c.dataset["sessionId"] === id);
  if (i === -1) return null;
  return (cards[i + 1] ?? cards[i - 1])?.dataset["sessionId"] ?? null;
}

/** The card is gone: keep the keyboard user near it (its recorded neighbour), else the main region. */
function focusNearest(neighbour: string | null): void {
  if (neighbour !== null && focusCard(neighbour)) return;
  const first = document.querySelector<HTMLElement>('[data-testid="session-card"]');
  if (first) {
    first.focus();
    return;
  }
  const main = document.querySelector<HTMLElement>("main");
  if (main) {
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus();
  }
}

/**
 * Mounts the session popout (R3.11; it replaced the drawer) for ui.selectedSessionId. Subscribes to the one session and its history, not
 * the whole store. When the popout closes, focus goes back to that session's card.
 */
export function DrawerHost() {
  const id = useUi((s) => s.selectedSessionId);
  const closeSession = useUi((s) => s.closeSession);
  const session = useBoard((s) => (id === null ? undefined : s.sessions[id]));
  useSessionHash();
  const open = id !== null && session !== undefined;
  const openedFor = useRef<string | null>(null);
  const neighbour = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      openedFor.current = id;
      neighbour.current = id === null ? null : neighbourOf(id);
    } else if (openedFor.current !== null) {
      if (!focusCard(openedFor.current)) focusNearest(neighbour.current);
      openedFor.current = null;
      neighbour.current = null;
    }
  }, [open, id]);

  // The session vanished (resync dropped it): drop the selection so board keys come back.
  useEffect(() => {
    if (id !== null && session === undefined) closeSession();
  }, [id, session, closeSession]);

  const onClose = useCallback(() => closeSession(), [closeSession]);
  if (!open) return null;
  return <SessionPopout key={id} session={session} onClose={onClose} />;
}
