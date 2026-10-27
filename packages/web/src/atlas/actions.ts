import { atlasApi } from "./api";
import type { AtlasSession } from "./types";

// The hub pushes the annotated `session` delta over the WebSocket after each PATCH, so the board
// is updated by the stream only. Writing the (possibly older) PATCH response into the board here
// could overwrite a newer delta.

export async function savePhase(sessionId: string, phase: string | null): Promise<AtlasSession> {
  return atlasApi.setSessionPhase(sessionId, phase);
}

export async function moveSession(
  sessionId: string,
  projectId: string | null,
): Promise<AtlasSession> {
  return atlasApi.setSessionProject(sessionId, projectId);
}
