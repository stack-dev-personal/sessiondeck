import { z } from "zod";

/**
 * Payload of a `liveness` envelope. This is sessiondeck's own payload (not Claude Code's).
 * The envelope's session_id names the session; the pid travels here, not on the envelope.
 * alive: true is the pid report; alive: false means the pid is gone.
 */
export const LivenessPayloadSchema = z.object({
  pid: z.number().int().positive(),
  alive: z.boolean(),
});

export type LivenessPayload = z.infer<typeof LivenessPayloadSchema>;
