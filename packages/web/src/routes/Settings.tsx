import { useState, type FormEvent } from "react";
import { useUi } from "../store/ui";

const input = "w-96 rounded border border-border bg-surface-2 px-s-2 py-s-1 text-fg";

/** Hub URL, token, notification opt-in. Saved to localStorage only; nothing uses it yet. */
export function Settings() {
  const { settings, saveSettings } = useUi();
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveSettings(draft);
    setSaved(true);
  };
  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-s-4 p-s-4">
      <h1 className="text-xl">Settings</h1>
      <label className="flex flex-col gap-s-1">
        Hub URL
        <input
          className={input}
          value={draft.hubUrl}
          placeholder="http://localhost:8787"
          onChange={(e) => {
            setDraft({ ...draft, hubUrl: e.target.value });
            setSaved(false);
          }}
        />
      </label>
      <label className="flex flex-col gap-s-1">
        Token
        <input
          className={input}
          type="password"
          autoComplete="off"
          value={draft.token}
          onChange={(e) => {
            setDraft({ ...draft, token: e.target.value });
            setSaved(false);
          }}
        />
      </label>
      <label className="flex items-center gap-s-2">
        <input
          type="checkbox"
          checked={draft.notifications}
          onChange={(e) => {
            setDraft({ ...draft, notifications: e.target.checked });
            setSaved(false);
          }}
        />
        Browser notifications when a session needs me
      </label>
      <div className="flex items-center gap-s-3">
        <button
          type="submit"
          className="rounded border border-border bg-surface-2 px-s-3 py-s-1 hover:bg-surface-3"
        >
          Save
        </button>
        <span role="status" className="text-sm text-fg-muted">
          {saved ? "✓ Saved" : ""}
        </span>
      </div>
    </form>
  );
}
