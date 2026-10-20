import type { BoardState } from "../store/board";
import type { StoreApi, UseBoundStore } from "zustand";
import { playTimeline } from "./player";
import { buildMockTimeline } from "./timeline";

/** Mock mode: no hub, no network. Replays contract fixtures through the store's reducers. */
export function startMock(store: UseBoundStore<StoreApi<BoardState>>): () => void {
  const { setConnection, enqueue } = store.getState();
  setConnection("mock");
  return playTimeline(buildMockTimeline(Date.now()), enqueue);
}
