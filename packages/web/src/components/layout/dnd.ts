/**
 * Native HTML5 drag and drop for pane assignment (R6.6); no dependency. The payload is the session
 * id under a private MIME type, so a file or text drag from elsewhere is never taken for a session.
 * Browsers only expose a drag's types (not its data) until the drop, which is all dragover needs.
 */
import type { DragEvent } from "react";

export const SESSION_MIME = "application/x-sessiondeck-session";

type Transfer = Pick<DataTransfer, "types" | "getData">;

export function hasSessionDrag(dt: Pick<DataTransfer, "types"> | null): boolean {
  return dt !== null && Array.from(dt.types).includes(SESSION_MIME);
}

export function sessionFromDrop(dt: Transfer | null): string | null {
  if (!dt || !hasSessionDrag(dt)) return null;
  const id = dt.getData(SESSION_MIME);
  return id === "" ? null : id;
}

/** Props that make an element a drag source for `sessionId`. */
export function sessionDragProps(sessionId: string) {
  return {
    draggable: true as const,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(SESSION_MIME, sessionId);
      e.dataTransfer.effectAllowed = "move";
    },
  };
}
