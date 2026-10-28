// Ported from stravu/crystal frontend/src/components/panels/ai/transformers/MessageTransformer.ts @ 1e18e0bc981225f75b5226f82a300fa741970c6f (MIT, Copyright (c) 2024 Stravu)
// Changes: kept only the UnifiedMessage and MessageSegment shapes (no transformer interface); metadata drops
//   sessionInfo; ToolCall carries id/name/input plus the paired result and nested subagent thread; ToolResult
//   uses snake_case is_error and gains truncation info; SystemInfoData gains level/data; a raw segment type
//   is added for rows the normalizer does not know; NormalizedEntry alias added. Finalized in Phase 4 (S7).
// Also shaped by vibe-kanban's NormalizedEntryType (BloopAI/vibe-kanban crates/executors/src/logs/mod.rs @
//   7c3807084daad0d9d315064f60fa869de254f027, Apache-2.0; architecture 3.5, shape only).
// Types only. The normalizer lives in ./normalize.

/** Anthropic usage figures, summed or taken from one message. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** A subagent's own transcript, nested under the Agent/Task call that spawned it (R4.3). */
export interface SubagentThread {
  agentId: string;
  agentType?: string;
  description?: string;
  messages: UnifiedMessage[];
  /** Sum of the usage of the subagent's own assistant messages (one per message id). */
  usage: TokenUsage;
  /** Context size of the last assistant message: input + cache read + cache creation tokens. */
  contextTokens: number;
  assistantMessageCount: number;
  toolCallCount: number;
  /** What the parent's tool result reported about the subagent, when present. */
  reported?: {
    status?: string;
    totalTokens?: number;
    totalDurationMs?: number;
    totalToolUseCount?: number;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Paired from the matching tool_result block; absent while the call is pending. */
  result?: ToolResult;
  /** Present for Agent/Task calls whose subagent transcript was supplied. */
  subagent?: SubagentThread;
}

export interface ToolResult {
  content: string;
  is_error: boolean;
  /** Set when the transcript holds only a pointer to a large output stored on the laptop. */
  truncation?: { sizeLabel?: string; path?: string };
  /** Why the tool call was denied (permission-rule, user-rejected, ...). */
  denial?: string;
  timestamp?: string;
}

export interface SystemInfoData {
  subtype: string;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface UnifiedMessageMetadata {
  agent?: string;
  model?: string;
  duration?: number;
  tokens?: number;
  cost?: number;
  systemSubtype?: string;
  /** Row kind of a raw fallback message, for example "unknown-type" or "system:future_subtype". */
  rawType?: string;
  usage?: TokenUsage;
  stopReason?: string;
  [key: string]: unknown;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool_call"; tool: ToolCall }
  | { type: "tool_result"; result: ToolResult & { toolCallId: string } }
  | { type: "system_info"; info: SystemInfoData }
  | { type: "thinking"; content: string }
  | { type: "diff"; diff: string }
  | { type: "error"; error: { message: string; details?: string } }
  /** A row or content block the normalizer has no case for; `label` names it, `data` is the row as read. */
  | { type: "raw"; label: string; data: unknown };

export interface UnifiedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  segments: MessageSegment[];
  metadata?: UnifiedMessageMetadata;
}

/** Alias used by the WS /stream transcript message in architecture 3.4. */
export type NormalizedEntry = UnifiedMessage;
