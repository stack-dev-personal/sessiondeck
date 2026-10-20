import { useMemo } from "react";
import { NavLink } from "react-router-dom";
import { selectHosts, useBoard } from "../store/board";
import { useUi } from "../store/ui";

const btn =
  "rounded border border-border bg-surface-2 px-s-3 py-s-1 text-sm text-fg hover:bg-surface-3";

export function Header() {
  const sessions = useBoard((s) => s.sessions);
  const connection = useBoard((s) => s.connection);
  const hosts = useMemo(() => selectHosts(sessions), [sessions]);
  const { theme, compact, toggleTheme, toggleCompact } = useUi();
  const link = ({ isActive }: { isActive: boolean }) =>
    `px-s-2 py-s-1 rounded ${isActive ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg"}`;
  return (
    <header className="flex flex-wrap items-center gap-x-s-4 gap-y-s-2 border-b border-border bg-surface-1 px-s-4 py-s-2">
      <strong className="text-lg">sessiondeck</strong>
      <nav className="flex gap-s-1 text-sm" aria-label="Main">
        <NavLink to="/board" className={link}>
          Board
        </NavLink>
        <NavLink to="/settings" className={link}>
          Settings
        </NavLink>
      </nav>
      <ul
        className="m-0 flex min-w-[10rem] flex-1 list-none flex-wrap gap-s-2 p-0 text-sm text-fg-muted"
        aria-label="Hosts"
      >
        {hosts.length === 0 ? <li>no hosts</li> : null}
        {hosts.map((h) => (
          <li key={h} className="num whitespace-nowrap rounded border border-border px-s-2">
            {h}
          </li>
        ))}
      </ul>
      <span
        className="num text-sm text-fg-muted"
        data-testid="connection"
        title="Connection status"
      >
        {(() => {
          const [glyph, word] =
            connection === "mock"
              ? ["◇", "mock"]
              : connection === "open"
                ? ["●", "connected"]
                : connection === "connecting"
                  ? ["◌", "connecting"]
                  : connection === "invalid"
                    ? ["✖", "hub URL invalid"]
                    : ["✖", "disconnected"];
          return (
            <>
              <span aria-hidden="true">{glyph}</span> {word}
            </>
          );
        })()}
      </span>
      <button type="button" className={btn} onClick={toggleCompact} aria-pressed={compact}>
        {compact ? "Compact: on" : "Compact: off"} (c)
      </button>
      <button type="button" className={btn} onClick={toggleTheme}>
        Theme: {theme} (t)
      </button>
    </header>
  );
}
