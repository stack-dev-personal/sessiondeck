// Types only. Target schema from Crystal's UnifiedMessage and vibe-kanban's
// NormalizedEntryType (architecture 3.5). No normalizer lives in this package yet.

// provisional: finalized in Phase 4 (S7)
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

// provisional: finalized in Phase 4 (S7)
export interface ToolResult {
  content: string;
  is_error: boolean;
}

// provisional: finalized in Phase 4 (S7)
export interface SystemInfoData {
  subtype: string;
  message: string;
}

export interface UnifiedMessageMetadata {
  agent?: string;
  model?: string;
  duration?: number;
  tokens?: number;
  cost?: number;
  systemSubtype?: string;
  [key: string]: unknown;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool_call"; tool: ToolCall }
  | { type: "tool_result"; result: ToolResult & { toolCallId: string } }
  | { type: "system_info"; info: SystemInfoData }
  | { type: "thinking"; content: string }
  | { type: "diff"; diff: string }
  | { type: "error"; error: { message: string; details?: string } };

export interface UnifiedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  segments: MessageSegment[];
  metadata?: UnifiedMessageMetadata;
}

/** Alias used by the WS /stream transcript message in architecture 3.4. */
export type NormalizedEntry = UnifiedMessage;
