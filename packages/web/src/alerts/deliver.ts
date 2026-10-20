import { displayNameOf, projectOf } from "../lib/attention";
import type { AttentionEvent, AttentionState } from "./detect";

/** Env seams so tests can stub the browser APIs. */
export interface AlertEnv {
  Notification?: {
    new (title: string, options?: NotificationOptions): { onclick: unknown; close(): void };
    permission: NotificationPermission;
  };
  AudioContext?: new () => AudioContext;
  focus?: () => void;
}

export function browserEnv(): AlertEnv {
  const w = window as unknown as {
    Notification?: AlertEnv["Notification"];
    AudioContext?: AlertEnv["AudioContext"];
    webkitAudioContext?: AlertEnv["AudioContext"];
  };
  return {
    Notification: w.Notification,
    AudioContext: w.AudioContext ?? w.webkitAudioContext,
    focus: () => window.focus(),
  };
}

/**
 * Design system 7 text: title "<project> needs permission|input", body the session name and the
 * tool name when the snapshot has it. Nothing from the transcript, the tool input or the last
 * message ever goes into a notification.
 */
export function notificationText(e: AttentionEvent): { title: string; body: string } {
  const s = e.session;
  const need = e.state === "waiting_permission" ? "needs permission" : "needs input";
  const holder = s.tracking?.permission;
  const tool = e.state === "waiting_permission" && holder && "tool" in holder ? holder.tool : null;
  const parts = [displayNameOf(s)];
  if (tool) parts.push(`Tool: ${tool}`);
  return { title: `${projectOf(s)} ${need}`, body: parts.join(" - ") };
}

export interface ShownNotification {
  onclick: unknown;
  close(): void;
}

/** The tag includes state_since so each episode is its own notification, never a silent replace. */
export function showNotification(env: AlertEnv, e: AttentionEvent): ShownNotification | null {
  const N = env.Notification;
  if (!N || N.permission !== "granted") return null;
  try {
    const { title, body } = notificationText(e);
    const tag = `sd-${e.sessionId}-${e.session.state_since}`;
    const n = new N(title, { body, tag, silent: true });
    n.onclick = () => env.focus?.();
    return n;
  } catch {
    return null;
  }
}

const TONE_HZ: Record<AttentionState, number> = { waiting_permission: 880, waiting_input: 660 };
export const TONE_MS = 200;

/** Created on first use and kept; browsers allow it to start only after a user gesture. */
let ctx: AudioContext | null = null;

/** Call from a click handler (the Settings toggles) so later tones are allowed to play. */
export function primeAudio(env: AlertEnv): void {
  try {
    if (!env.AudioContext) return;
    ctx ??= new env.AudioContext();
    void ctx.resume?.();
  } catch {
    /* no audio available */
  }
}

/** One 200 ms sine tone with a short fade out. Pitch differs per state; no asset needed. */
export function playTone(env: AlertEnv, state: AttentionState): boolean {
  try {
    if (!env.AudioContext) return false;
    ctx ??= new env.AudioContext();
    void ctx.resume?.();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = ctx.currentTime;
    osc.frequency.value = TONE_HZ[state];
    gain.gain.setValueAtTime(0.15, t0);
    gain.gain.linearRampToValueAtTime(0, t0 + TONE_MS / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + TONE_MS / 1000);
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget the shared AudioContext. */
export function resetAudioForTests(): void {
  ctx = null;
}
