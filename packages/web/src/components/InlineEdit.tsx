import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface InlineEditProps {
  /** Text the editor opens with. */
  value: string;
  /** Accessible name of the control, e.g. "Phase for Docs navigation". */
  label: string;
  /** What the display button shows (text only). */
  children: ReactNode;
  /** Enter. Resolve to leave edit mode; reject (throw) to stay and show the error. */
  onSave: (text: string) => Promise<unknown>;
  maxLength: number;
  /** Rejects an empty value (names); phases allow it (clears to inferred). */
  required?: boolean;
  hint: string;
  /** Classes for the fixed-size wrapper. The wrapper never changes size between display and edit. */
  className?: string;
  testId?: string;
}

const field =
  "w-full min-w-0 rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg";

/**
 * One text value that edits in place. The display is a real button (Enter or Space opens it), the
 * editor is a text input: Enter saves, Escape cancels, blur cancels. Escape is consumed here so an
 * enclosing drawer does not close. Display and editor share one fixed-size wrapper.
 */
export function InlineEdit({
  value,
  label,
  children,
  onSave,
  maxLength,
  required = false,
  hint,
  className = "",
  testId,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const hintId = useId();
  const errId = useId();

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      btnRef.current?.focus();
    }
  }, [editing]);

  const open = () => {
    setDraft(value);
    setError(null);
    setEditing(true);
  };
  const close = () => {
    refocus.current = true;
    setError(null);
    setEditing(false);
  };
  const save = async () => {
    if (busy) return;
    const text = draft.trim();
    if (required && text === "") {
      setError("Cannot be empty");
      return;
    }
    if (text === value.trim()) {
      close();
      return;
    }
    setBusy(true);
    try {
      await onSave(text);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) close();
    }
  };

  return (
    <span className={`relative inline-flex min-w-0 items-center ${className}`} data-testid={testId}>
      {editing ? (
        <>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={maxLength}
            readOnly={busy}
            aria-busy={busy || undefined}
            aria-label={label}
            aria-describedby={`${hintId}${error ? ` ${errId}` : ""}`}
            aria-invalid={error ? true : undefined}
            title={hint}
            className={field}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => {
              if (!busy) setEditing(false);
            }}
          />
          <span id={hintId} className="sr-only">
            {hint}
          </span>
          {error ? (
            <span
              id={errId}
              role="alert"
              className="absolute left-0 top-full z-10 mt-0.5 whitespace-nowrap rounded border border-state-error bg-surface-1 px-s-2 text-xs text-state-error"
            >
              <span aria-hidden="true">✖ </span>
              {error}
            </span>
          ) : null}
        </>
      ) : (
        <button
          ref={btnRef}
          type="button"
          aria-label={label}
          title={`${label} (Enter to edit)`}
          onClick={open}
          className="flex w-full min-w-0 items-center gap-s-1 rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-left text-sm text-fg hover:bg-surface-3"
        >
          {children}
          <span aria-hidden="true" className="num ml-auto shrink-0 text-fg-faint">
            ✎
          </span>
        </button>
      )}
    </span>
  );
}
