import { useEffect } from "react";
import { useUi } from "../store/ui";

/** True when the event target is somewhere the user types; shortcuts must not fire there. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * True when a single-key shortcut must not fire: auto-repeat, a modifier is held, the user is typing,
 * or a modal (the detail drawer, the command palette, a save/manage dialog) is open.
 */
export function shouldIgnoreKey(e: KeyboardEvent): boolean {
  const ui = useUi.getState();
  return (
    e.defaultPrevented ||
    e.repeat ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    isTypingTarget(e.target) ||
    ui.selectedSessionId !== null ||
    ui.paletteOpen ||
    ui.modalOpen
  );
}

/**
 * The key a shortcut map is written in. A single letter takes its case from Shift alone, so Caps
 * Lock does not swap c and C (event.key follows Caps Lock, event.shiftKey does not). Other keys
 * (digits, Escape) are event.key as is. Layout independent: no event.code, so Dvorak and AZERTY work.
 */
export function keyName(e: Pick<KeyboardEvent, "key" | "shiftKey">): string {
  return e.key.length === 1 && e.key.toLowerCase() !== e.key.toUpperCase()
    ? e.shiftKey
      ? e.key.toUpperCase()
      : e.key.toLowerCase()
    : e.key;
}

/**
 * Global single-key shortcuts. Ignored on auto-repeat, while typing and when Ctrl, Meta or Alt is held
 * (Ctrl+K is the command palette). Keys are matched by keyName().
 */
export function useShortcuts(map: Record<string, () => void>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e)) return;
      const fn = map[keyName(e)];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [map]);
}

/**
 * Layout keys (Phase 6), all on /layout. None fire while typing, with Ctrl/Meta/Alt held, or while a
 * layout dialog is open.
 *   l                      open the layout menu
 *   Up / Down, Home / End  move in the menu; Enter applies the preset; Esc closes
 *   1 - 9                  switch to the saved layout in that slot (a layout pinned to the Viewer
 *                          host from Settings beats an unpinned one; with no Viewer host only
 *                          unpinned layouts open); the status line names it
 *   s                      save the current layout (name, slot, pin); Enter saves, Esc cancels
 *   m                      manage saved layouts: rename, reassign slot, delete, open
 *   Shift+C                compact every pane; again restores the previous layout exactly
 *                          (lowercase c stays the global board compact toggle)
 *   Tab                    reaches each pane's Compact/Expand button; Enter or Space toggles it
 *   Tab to a divider       Left/Right or Up/Down resize the two panes next to it (react-resizable-panels)
 *   a                      arrange for N live sessions: the preset for the live count, the most
 *                          urgent sessions placed in attention order (1 solo, 2 pair, 3 focus, 4 quad,
 *                          5-6 and more grid6, 0 strip); ended and exited sessions are left out
 *   p                      split by project: a column per project with a live session
 *   Tab to a session pane  the pane takes a focus ring; there:
 *   Enter or g             open the session picker: type to filter, Up/Down, Enter assigns, Esc cancels
 *   Delete or Backspace    unassign the pane
 *   (mouse)                drag a session card from the strip, a project pane or another pane's
 *                          header onto a session pane; dropping on a pane that holds another session
 *                          swaps the two. A session is in at most one session pane.
 */
export const LAYOUT_KEYS = {
  menu: "l",
  save: "s",
  manage: "m",
  compactAll: "C",
  arrange: "a",
  byProject: "p",
  pick: ["Enter", "g"] as readonly string[],
  unassign: ["Delete", "Backspace"] as readonly string[],
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
} as const;
