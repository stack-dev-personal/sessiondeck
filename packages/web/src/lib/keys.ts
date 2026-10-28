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
 * or a modal (the detail drawer, the command palette) is open.
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
    ui.paletteOpen
  );
}

/**
 * Global single-key shortcuts. Ignored on auto-repeat, while typing and when Ctrl, Meta or Alt is held
 * (Ctrl+K is the command palette). Keys are matched on event.key.
 */
export function useShortcuts(map: Record<string, () => void>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e)) return;
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
