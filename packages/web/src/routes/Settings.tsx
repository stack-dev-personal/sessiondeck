import { useState, type FormEvent } from "react";
import { streamUrl } from "../live/stream-client";
import { useUi } from "../store/ui";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Warning text when the token would travel unencrypted to a non-loopback host, else null. */
export function insecureHubWarning(hubUrl: string): string | null {
  const raw = hubUrl.trim();
  if (raw === "") return null;
  const ws = streamUrl(raw, { protocol: "https:", host: "x" });
  if (ws === null) return "Hub URL is not valid. Use http(s):// or ws(s)://.";
  const u = new URL(ws);
  if (u.protocol === "wss:" || LOOPBACK.has(u.hostname)) return null;
  return "This URL is not encrypted. The token is sent in clear text; use https unless the network is trusted.";
}

const input = "w-96 rounded border border-border bg-surface-2 px-s-2 py-s-1 text-fg";

/** Hub URL, token, notification opt-in. Saved to localStorage only; nothing uses it yet. */
export function Settings() {
  const { settings, saveSettings } = useUi();
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const warning = insecureHubWarning(draft.hubUrl);
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
      {warning ? (
        <p role="alert" className="flex items-center gap-s-2 text-sm text-fg">
          <span aria-hidden="true">▲</span>
          <span>{warning}</span>
        </p>
      ) : null}
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
