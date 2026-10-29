import { useEffect, useId, useRef, type ReactNode } from "react";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { formatCost } from "../lib/format";
import { STATE_VOCAB } from "../lib/state-vocab";
import { AgentRollup } from "./AgentRollup";
import { cardInfo } from "./SessionCard";

const FOCUSABLE =
  'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';

function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.matches('[disabled], [tabindex="-1"]') &&
      !el.closest("[inert]") &&
      !el.closest("fieldset[disabled]"),
  );
}

const NA = <span className="num text-fg-muted">n/a</span>;

function Fact({ label, slot, children }: { label: string; slot: string; children: ReactNode }) {
  return (
    <div data-slot={slot} className="flex min-w-0 flex-col">
      <dt className="text-xs uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="num m-0 min-w-0 truncate">{children}</dd>
    </div>
  );
}

export interface SessionPopoutProps {
  session: SessionSnapshot;
  onClose: () => void;
  /**
   * Content slot for S8 (the session content view). Rendered inside
   * `<div data-slot="content">` below the header and above the subagent rollup. When omitted the
   * region still renders, empty and zero height, so S8 only has to pass this prop.
   */
  contentSlot?: ReactNode;
}

/**
 * Large centered modal for one session (R3.11, replaces the side drawer). role=dialog,
 * aria-modal, labelled by the header; focus moves to the close button and is trapped; Esc,
 * the close button and a click on the backdrop close it. Focus return to the opening card and the
 * #session-<id> hash are the host's job (DrawerHost), as the drawer's were.
 */
export function SessionPopout({ session: s, onClose, contentSlot }: SessionPopoutProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { name } = cardInfo(s);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Everything behind the modal is inert while it is open, so focus cannot reach it.
  useEffect(() => {
    const dlg = ref.current;
    const siblings = dlg?.parentElement ? Array.from(dlg.parentElement.children) : [];
    const marked = siblings.filter(
      (el) => el !== dlg && !el.classList.contains("sd-scrim") && !el.hasAttribute("inert"),
    );
    for (const el of marked) el.setAttribute("inert", "");
    return () => {
      for (const el of marked) el.removeAttribute("inert");
    };
  }, []);

  // Document-level so it works wherever focus is, including document.body after a click on text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
        return;
      }
      const root = ref.current;
      if (e.key !== "Tab" || !root) return;
      const items = tabbable(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = root.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const st = STATE_VOCAB[s.state];
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="popout-backdrop"
        className="sd-scrim fixed inset-0 z-30"
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="session-popout"
        data-session-id={s.session_id}
        className="sd-popout fixed left-1/2 top-1/2 z-40 flex max-h-[90vh] w-[min(64rem,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface-1 text-sm"
      >
        <header className="flex items-start justify-between gap-s-3 border-b border-border p-s-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 truncate text-lg font-normal">
              {name}
            </h2>
            <span className={`inline-flex items-center gap-s-2 ${st.textClass}`}>
              <span aria-hidden="true" className="num">
                {st.glyph}
              </span>
              <span data-slot="state">{st.label}</span>
              {s.state_detail ? (
                <span className="num text-fg-muted">· {s.state_detail}</span>
              ) : null}
            </span>
            <dl className="m-0 mt-s-2 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-s-3">
              <Fact label="Model" slot="model">
                {s.model ? s.model.display_name : NA}
              </Fact>
              <Fact label="Effort" slot="effort">
                {s.effort ?? NA}
              </Fact>
              <Fact label="Speed" slot="speed">
                {s.fast_mode === null || s.fast_mode === undefined
                  ? NA
                  : s.fast_mode
                    ? "fast"
                    : "standard"}
              </Fact>
              <Fact label="Cost (API-equivalent)" slot="cost">
                {s.cost.usd === null ? NA : formatCost(s.cost.usd)}
              </Fact>
              <Fact label="Branch" slot="branch">
                {s.git.branch ?? NA}
              </Fact>
            </dl>
            <div className="num mt-s-1 text-xs text-fg-faint">{s.host}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg hover:bg-surface-3"
          >
            Close (Esc)
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-s-4 overflow-y-auto p-s-3">
          <div data-slot="content">{contentSlot}</div>
          <AgentRollup agents={s.subagents} />
        </div>
      </div>
    </>
  );
}
