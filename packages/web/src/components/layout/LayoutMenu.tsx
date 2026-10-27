import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PRESET_LABELS, PRESET_NAMES, type PresetName } from "../../layout/presets";

/**
 * Preset menu: a button that opens a role=menu of the seven builtin presets. Fully keyboard
 * driven (open from outside with the `open` prop's owner via the `l` shortcut).
 */
export function LayoutMenu({
  current,
  currentName,
  open,
  onOpenChange,
  onPick,
}: {
  current: string;
  /** Saved name of the current layout when it is not a builtin preset (its id is not for people). */
  currentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (name: PresetName) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [wasOpen, setWasOpen] = useState(false);
  useEffect(() => {
    if (open) {
      const i = Math.max(0, PRESET_NAMES.indexOf(current as PresetName));
      items.current[i]?.focus();
    } else if (wasOpen) btn.current?.focus();
    setWasOpen(open);
    // focus moves only when the open state flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const move = (to: number) => {
    const n = PRESET_NAMES.length;
    items.current[((to % n) + n) % n]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const cur = items.current.findIndex((b) => b === document.activeElement);
    if (e.key === "Escape") onOpenChange(false);
    else if (e.key === "ArrowDown") move(cur + 1);
    else if (e.key === "ArrowUp") move(cur - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(PRESET_NAMES.length - 1);
    else if (e.key === "Tab") onOpenChange(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
    e.stopPropagation();
  };
  const label = PRESET_NAMES.includes(current as PresetName)
    ? PRESET_LABELS[current as PresetName].split(":")[0]
    : (currentName ?? current);
  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        className="rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-sm text-fg hover:bg-surface-3"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        data-testid="layout-menu-button"
      >
        Layout: {label} (l)
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-10"
            aria-hidden="true"
            onClick={() => onOpenChange(false)}
          />
          <ul
            role="menu"
            aria-label="Layout presets"
            className="absolute left-0 top-full z-20 m-0 mt-s-1 w-80 list-none rounded border border-border-strong bg-surface-2 p-s-1"
            onKeyDown={onKey}
          >
            {PRESET_NAMES.map((name, i) => (
              <li key={name} role="none">
                <button
                  ref={(el) => {
                    items.current[i] = el;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current === name}
                  className="flex w-full items-center gap-s-2 rounded px-s-2 py-s-1 text-left text-sm text-fg hover:bg-surface-3 focus-visible:bg-surface-3"
                  onClick={() => {
                    onPick(name);
                    onOpenChange(false);
                  }}
                  data-preset={name}
                >
                  <span className="num w-4" aria-hidden="true">
                    {current === name ? "●" : "○"}
                  </span>
                  {PRESET_LABELS[name]}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
