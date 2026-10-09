import { z } from "zod";
import { EnvelopeSchema, type Envelope } from "./envelope";
import type { SessionSnapshot } from "./snapshot";
import type { NormalizedEntry } from "./transcript";

/** POST /ingest body (architecture 3.4). */
export const IngestRequestSchema = z.object({
  host: z.string().min(1),
  envelopes: z.array(EnvelopeSchema),
});
export interface IngestRequest {
  host: string;
  envelopes: Envelope[];
}

/** POST /ingest response. */
export const IngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** WS /stream heartbeat interval in ms (architecture 3.4: ping every 25 s). */
export const STREAM_HEARTBEAT_MS = 25_000;

export interface StreamInitialMessage {
  type: "initial";
  sessions: SessionSnapshot[];
}
export interface StreamSessionMessage {
  type: "session";
  data: SessionSnapshot;
}
export interface StreamTranscriptMessage {
  type: "transcript";
  session_id: string;
  lines: NormalizedEntry[];
}
/** provisional: alert shape is not specified yet; kept minimal. */
export interface StreamAlertMessage {
  type: "alert";
  session_id?: string;
  message: string;
}

export type StreamMessage =
  StreamInitialMessage | StreamSessionMessage | StreamTranscriptMessage | StreamAlertMessage;
