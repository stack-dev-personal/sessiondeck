import { useBoard } from "../store/board";
import { atlasApi } from "./api";
import type { AtlasSession } from "./types";

/** Puts a PATCH response into the board store when that session is on the board (the WS delta says the same). */
export function publishToBoard(s: AtlasSession): void {
  const st = useBoard.getState();
  if (st.sessions[s.session_id] !== undefined) st.enqueueSnapshot(s);
}

export async function savePhase(sessionId: string, phase: string | null): Promise<AtlasSession> {
  const s = await atlasApi.setSessionPhase(sessionId, phase);
  publishToBoard(s);
  return s;
}

export async function moveSession(
  sessionId: string,
  projectId: string | null,
): Promise<AtlasSession> {
  const s = await atlasApi.setSessionProject(sessionId, projectId);
  publishToBoard(s);
  return s;
}
