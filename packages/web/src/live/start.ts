import type { StoreApi, UseBoundStore } from "zustand";
import type { BoardState } from "../store/board";
import type { Settings } from "../store/ui";
import { createStreamClient, streamUrl, type StreamClientOptions } from "./stream-client";

type Extra = Partial<
  Pick<
    StreamClientOptions,
    "WebSocketCtor" | "setTimeout" | "clearTimeout" | "random" | "now" | "livenessMs"
  >
>;

/**
 * Connects the board store to the hub. Returns a stop function. The store's connection field
 * carries connecting/open/closed and the next retry time for the banner.
 */
export function wireStream(
  store: UseBoundStore<StoreApi<BoardState>>,
  cfg: Pick<Settings, "hubUrl" | "token"> &
    Extra & { location?: { protocol: string; host: string } },
): () => void {
  const { setConnection, replaceAll, enqueueSnapshot } = store.getState();
  const url = streamUrl(cfg.hubUrl, cfg.location ?? window.location);
  if (url === null) {
    setConnection("invalid");
    return () => undefined;
  }
  const { hubUrl: _h, token, location: _l, ...extra } = cfg;
  void _h;
  void _l;
  const client = createStreamClient({
    ...extra,
    url,
    token,
    onInitial: replaceAll,
    onSession: enqueueSnapshot,
    onStatus: setConnection,
  });
  client.start();
  return () => client.stop();
}

/** Live mode: follows Settings, reconnecting when the hub URL or token is saved. */
export function startLive(
  store: UseBoundStore<StoreApi<BoardState>>,
  ui: UseBoundStore<StoreApi<{ settings: Settings }>>,
): () => void {
  let cur = ui.getState().settings;
  let stop = wireStream(store, cur);
  const unsub = ui.subscribe((s) => {
    const next = s.settings;
    if (next.hubUrl === cur.hubUrl && next.token === cur.token) return;
    cur = next;
    stop();
    store.getState().replaceAll([]);
    stop = wireStream(store, cur);
  });
  return () => {
    unsub();
    stop();
  };
}
