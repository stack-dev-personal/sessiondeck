import { useState, type FormEvent } from "react";
import { browserEnv, playTone, primeAudio } from "../alerts/deliver";
import { streamUrl } from "../live/stream-client";
import { useUi } from "../store/ui";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Warning text when the token would travel unencrypted to a non-loopback host, else null. */
export function insecureHubWarning(
  hubUrl: string,
  loc: { protocol: string; host: string } = window.location,
): string | null {
  const raw = hubUrl.trim();
  const ws = streamUrl(raw, raw === "" ? loc : { protocol: "https:", host: "x" });
  if (ws === null) return "Hub URL is not valid. Use http(s):// or ws(s)://.";
  const u = new URL(ws);
  if (u.protocol === "wss:" || LOOPBACK.has(u.hostname)) return null;
  return "This URL is not encrypted. The token is sent in clear text; use https unless the network is trusted.";
}

const input = "w-96 max-w-full rounded border border-border bg-surface-2 px-s-2 py-s-1 text-fg";

type Perm = NotificationPermission | "unsupported";

function currentPermission(): Perm {
  return browserEnv().Notification?.permission ?? "unsupported";
}

const PERM_TEXT: Record<Perm, string> = {
  default: "Browser permission: not asked yet. It is requested when you turn this on.",
  granted: "Browser permission: granted.",
  denied:
    "Browser permission: blocked. Allow notifications for this site in the browser, then turn this on again.",
  unsupported: "Browser permission: this browser has no Notification support.",
};

/** Hub URL, token, and the alert opt-ins (browser notification, one tone per attention state). */
export function Settings() {
  const { settings, saveSettings } = useUi();
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [perm, setPerm] = useState<Perm>(currentPermission);
  const warning = insecureHubWarning(draft.hubUrl);
  /** The change handler is a user gesture, which is what requestPermission needs. */
  const toggleNotifications = (on: boolean) => {
    setDraft({ ...draft, notifications: on });
    setSaved(false);
    const N = browserEnv().Notification as
      | {
          permission: NotificationPermission;
          requestPermission?: () => Promise<NotificationPermission>;
        }
      | undefined;
    if (on && N?.permission === "default" && N.requestPermission) {
      void N.requestPermission().then(
        (p) => setPerm(p),
        () => setPerm(currentPermission()),
      );
    }
  };
  const toggleSound = (state: "waiting_permission" | "waiting_input", on: boolean) => {
    setDraft({ ...draft, sounds: { ...draft.sounds, [state]: on } });
    setSaved(false);
    if (on) {
      const env = browserEnv();
      primeAudio(env);
      if (!draft.muted) playTone(env, state);
    }
  };
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
      <fieldset className="flex flex-col gap-s-2 border-0 p-0">
        <legend className="mb-s-1">Alerts</legend>
        <label className="flex items-center gap-s-2">
          <input
            type="checkbox"
            checked={draft.notifications}
            onChange={(e) => toggleNotifications(e.target.checked)}
          />
          Browser notifications when a session needs me
        </label>
        <p className="m-0 text-sm text-fg-muted" data-testid="notification-permission">
          {PERM_TEXT[perm]} A notification shows the session name and its state only.
        </p>
        <label className="flex items-center gap-s-2">
          <input
            type="checkbox"
            checked={draft.sounds.waiting_permission}
            onChange={(e) => toggleSound("waiting_permission", e.target.checked)}
          />
          Play a tone when a session needs permission
        </label>
        <label className="flex items-center gap-s-2">
          <input
            type="checkbox"
            checked={draft.sounds.waiting_input}
            onChange={(e) => toggleSound("waiting_input", e.target.checked)}
          />
          Play a tone when a session needs input
        </label>
        <label className="flex items-center gap-s-2">
          <input
            type="checkbox"
            checked={draft.muted}
            onChange={(e) => {
              setDraft({ ...draft, muted: e.target.checked });
              setSaved(false);
            }}
          />
          Mute all tones
        </label>
      </fieldset>
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
