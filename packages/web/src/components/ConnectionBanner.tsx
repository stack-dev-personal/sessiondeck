import { useEffect, useState } from "react";
import { useBoard } from "../store/board";

/**
 * Shown while the hub link is down or being re-established. Fixed overlay at the bottom
 * (no flow space), so the board never shifts. The live region stays mounted so
 * assistive tech announces the text changes. Icon + words; color only reinforces.
 */
export function ConnectionBanner() {
  const connection = useBoard((s) => s.connection);
  const retryAt = useBoard((s) => s.retryAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connection !== "closed" || retryAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [connection, retryAt]);
  let text: string | null = null;
  if (connection === "closed") {
    const secs = retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
    text =
      secs === null || secs === 0
        ? "Disconnected, reconnecting"
        : `Disconnected, reconnecting in ${secs}s`;
  } else if (connection === "invalid") {
    text = "Hub URL invalid, check Settings";
  } else if (connection === "connecting") {
    text = "Reconnecting";
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-s-4 z-30 flex justify-center">
      <div role="status" aria-live="polite" data-testid="connection-banner">
        {text !== null ? (
          <p className="num pointer-events-auto flex items-center gap-s-2 rounded border border-state-error bg-surface-2 px-s-3 py-s-1 text-sm text-fg shadow-lg">
            <span aria-hidden="true">
              {connection === "closed" || connection === "invalid" ? "✖" : "◌"}
            </span>
            <span>{text}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
