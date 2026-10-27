import { useEffect } from "react";
import { useUi } from "../store/ui";

/** True when the event target is somewhere the user types; shortcuts must not fire there. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Global single-key shortcuts. Ignored on auto-repeat, while typing and when Ctrl, Meta or Alt is held
 * (Ctrl+K and friends belong to later units). Keys are matched on event.key.
 */
export function useShortcuts(map: Record<string, () => void>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        isTypingTarget(e.target) ||
        // A modal (the detail drawer) is open: board keys are blocked wherever focus is.
        useUi.getState().selectedSessionId !== null
      )
        return;
      const fn = map[e.key];
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
 *   1 - 9                  switch to the saved layout in that slot (a layout pinned to the current
 *                          host beats an unpinned one); the status line names it
 *   s                      save the current layout (name, slot, pin); Enter saves, Esc cancels
 *   m                      manage saved layouts: rename, reassign slot, delete, open
 *   Shift+C                compact every pane; again restores the previous layout exactly
 *                          (lowercase c stays the global board compact toggle)
 *   Tab                    reaches each pane's Compact/Expand button; Enter or Space toggles it
 *   Tab to a divider       Left/Right or Up/Down resize the two panes next to it (react-resizable-panels)
 * Later units add assignment keys here.
 */
export const LAYOUT_KEYS = {
  menu: "l",
  save: "s",
  manage: "m",
  compactAll: "C",
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
} as const;
