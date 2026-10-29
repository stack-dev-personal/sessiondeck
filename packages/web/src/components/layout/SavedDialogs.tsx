import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { MAX_NAME, type SavedLayout } from "../../layout/saved";
import { useLayout } from "../../store/layout";
import { useSaved } from "../../store/saved";
import { useUi } from "../../store/ui";

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']";

/** Modal frame: focus moves in, Tab wraps inside, Esc closes, focus returns to where it was. */
function Modal({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    // Global shortcuts (t, c, layout keys) stay quiet while any dialog is mounted.
    useUi.getState().setModalOpen(true);
    return () => {
      useUi.getState().setModalOpen(false);
      prev?.focus?.();
    };
  }, []);
  // Esc works wherever focus is, including after a deleted row took the focused element with it.
  useEffect(() => {
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return (
    <>
      <div aria-hidden="true" className="sd-scrim fixed inset-0 z-30" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        data-testid={testId}
        onKeyDown={onKey}
        className="fixed left-1/2 top-s-8 z-40 flex max-h-[80vh] w-[32rem] max-w-[95vw] -translate-x-1/2 flex-col gap-s-3 rounded border border-border-strong bg-surface-1 p-s-4 text-sm text-fg"
      >
        <h2 id={id} className="m-0 text-lg font-normal">
          {title}
        </h2>
        {children}
      </div>
    </>
  );
}

const control =
  "rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg hover:bg-surface-3";

/**
 * `s` on the layout route: name, slot 1-9 or none, pin to the Viewer host (Settings) or all hosts.
 * The host is frozen when the dialog opens, so the one shown is the one saved. While compact-all
 * is on, the layout saved is the one from before it, and the dialog says so.
 */
export function SaveDialog({
  host: liveHost,
  onClose,
}: {
  host: string | null;
  onClose: () => void;
}) {
  const [host] = useState(liveHost);
  const compacted = useLayout((s) => s.snapshot !== null);
  const save = useSaved((s) => s.save);
  const taken = useSaved((s) => s.rows);
  const [name, setName] = useState("");
  const [slot, setSlot] = useState<number | null>(null);
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const slotId = useId();
  const pinId = useId();
  const trimmed = name.trim();
  const holder =
    slot === null
      ? undefined
      : taken.find((r) => r.hotkey === slot && r.host === (pin ? host : null));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    const err = await save({ name: trimmed, hotkey: slot, host: pin ? host : null });
    setBusy(false);
    if (err === null) onClose();
    else setError(err);
  };
  return (
    <Modal title="Save layout" onClose={onClose} testId="save-dialog">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-s-3">
        <label htmlFor={nameId} className="flex flex-col gap-s-1">
          Name
          <input
            id={nameId}
            data-autofocus
            className={control}
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label htmlFor={slotId} className="flex flex-col gap-s-1">
          Hotkey slot
          <select
            id={slotId}
            className={control}
            value={slot ?? ""}
            onChange={(e) => setSlot(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">None</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={pinId} className="flex items-center gap-s-2">
          <input
            id={pinId}
            type="checkbox"
            checked={pin}
            disabled={host === null}
            onChange={(e) => setPin(e.target.checked)}
          />
          {host === null
            ? "Pin to the Viewer host (none set; choose one in Settings)"
            : `Pin to Viewer host ${host}`}
        </label>
        {compacted ? (
          <p className="m-0 text-xs text-fg-muted" data-testid="save-compact-note">
            <span aria-hidden="true">ℹ </span>
            Compact all is on. This saves your layout from before it, not the compacted panes.
          </p>
        ) : null}
        <p className="num m-0 min-h-[2.5em] text-xs text-fg-muted" role="status">
          {holder
            ? `Slot ${slot} currently opens "${holder.name}"; saving moves it to this layout.`
            : pin
              ? "Only opens on this host."
              : "Opens on every host."}
        </p>
        {error ? (
          <p role="alert" className="m-0 text-state-error" data-testid="save-error">
            <span aria-hidden="true">✖ </span>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-s-2">
          <button type="button" className={control} onClick={onClose}>
            Cancel (Esc)
          </button>
          <button type="submit" className={control} disabled={trimmed === "" || busy}>
            {busy ? "Saving" : "Save (Enter)"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const FALLBACK_ROW_PX = 40;
const VIRTUAL_OVER = 100;

function Row({ row, onOpen }: { row: SavedLayout; onOpen: (r: SavedLayout) => void }) {
  const update = useSaved((s) => s.update);
  const remove = useSaved((s) => s.remove);
  const [name, setName] = useState(row.name);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setName(row.name), [row.name]);
  const commitName = async () => {
    const t = name.trim();
    if (t === "" || t === row.name) return setName(row.name);
    setErr(await update(row.id, { name: t }));
  };
  return (
    <li
      className="flex h-[var(--strip-h)] items-center gap-s-2"
      data-testid="saved-row"
      data-layout-row={row.id}
      title={err ?? undefined}
    >
      <input
        aria-label={`Name of ${row.name}`}
        className={`${control} min-w-0 flex-1`}
        value={name}
        maxLength={MAX_NAME}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void commitName()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <select
        aria-label={`Slot of ${row.name}`}
        className={control}
        value={row.hotkey ?? ""}
        onChange={(e) =>
          void update(row.id, {
            hotkey: e.target.value === "" ? null : Number(e.target.value),
          }).then(setErr)
        }
      >
        <option value="">No slot</option>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <option key={n} value={n}>{`Slot ${n}`}</option>
        ))}
      </select>
      <span className="num w-20 truncate text-xs text-fg-muted" title={row.host ?? "all hosts"}>
        {row.host ?? "all hosts"}
      </span>
      <button type="button" className={control} onClick={() => onOpen(row)}>
        Open
      </button>
      <button
        type="button"
        className={control}
        aria-label={confirm ? `Confirm delete ${row.name}` : `Delete ${row.name}`}
        onBlur={() => setConfirm(false)}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          void remove(row.id).then(setErr);
        }}
      >
        {confirm ? "Confirm" : "Delete"}
      </button>
    </li>
  );
}

/** `m` on the layout route: rename, reassign the slot, delete, open. Windowed past 100 rows. */
export function ManageDialog({ onClose }: { onClose: () => void }) {
  const rows = useSaved((s) => s.rows);
  const open = useSaved((s) => s.open);
  const listRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [rowH, setRowH] = useState(FALLBACK_ROW_PX);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const v = parseFloat(getComputedStyle(el).getPropertyValue("--strip-h"));
    if (Number.isFinite(v) && v > 0) setRowH(v);
    setViewH(el.clientHeight);
  }, []);
  // A deleted row takes the focused control with it: put focus back inside the dialog.
  useEffect(() => {
    const dlg =
      listRef.current?.closest("[role=dialog]") ?? document.querySelector("[role=dialog]");
    if (dlg && !dlg.contains(document.activeElement))
      dlg.querySelector<HTMLElement>("[data-autofocus], button, input, select")?.focus();
  }, [rows.length]);
  const virtual = rows.length > VIRTUAL_OVER;
  // Past the window, rows that are not rendered cannot take focus. The scroll area itself is a Tab
  // stop and scrolls on the arrow keys, so every row is reachable without a pointer.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !virtual) return;
    const page = Math.max(rowH, viewH - rowH);
    const max = Math.max(0, rows.length * rowH - viewH);
    const delta: Record<string, number> = {
      ArrowDown: rowH,
      ArrowUp: -rowH,
      PageDown: page,
      PageUp: -page,
      Home: -Infinity,
      End: Infinity,
    };
    const d = delta[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const next = Math.min(max, Math.max(0, e.currentTarget.scrollTop + d));
    e.currentTarget.scrollTop = next;
    setScroll(next);
  };
  const per = Math.max(10, Math.ceil(viewH / rowH) + 6);
  const start = virtual ? Math.max(0, Math.floor(scroll / rowH) - 3) : 0;
  const shown = virtual ? rows.slice(start, start + per) : rows;
  return (
    <Modal title="Saved layouts" onClose={onClose} testId="manage-dialog">
      {rows.length === 0 ? (
        <p className="m-0 text-fg-muted">
          Nothing saved yet. Press s on the layout page to save the current layout.
        </p>
      ) : (
        <div
          ref={listRef}
          className="min-h-0 overflow-auto"
          style={{ maxHeight: "50vh" }}
          tabIndex={virtual ? 0 : undefined}
          role={virtual ? "region" : undefined}
          aria-label={
            virtual
              ? `Saved layouts, ${rows.length} rows. Arrow keys, Page Up, Page Down, Home and End scroll.`
              : undefined
          }
          onKeyDown={onListKey}
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          <ul
            className="m-0 list-none p-0"
            style={
              virtual
                ? {
                    paddingTop: start * rowH,
                    paddingBottom: Math.max(0, rows.length - start - shown.length) * rowH,
                  }
                : undefined
            }
            aria-label="Saved layouts"
          >
            {shown.map((r) => (
              <Row
                key={r.id}
                row={r}
                onOpen={(x) => {
                  open(x.id);
                  onClose();
                }}
              />
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" className={control} onClick={onClose} data-autofocus>
          Close (Esc)
        </button>
      </div>
    </Modal>
  );
}
