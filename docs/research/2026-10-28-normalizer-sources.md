# 2026-10-28 Normalizer borrow sources (S7, sd-researcher)

## Crystal ClaudeMessageTransformer (MIT, Copyright (c) 2024 Stravu)
- https://raw.githubusercontent.com/stravu/crystal/1e18e0bc981225f75b5226f82a300fa741970c6f/frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
- transform() lines 78-137. Pass 1: `toolResults: Map<tool_use_id, {content (string or JSON.stringify), isError}>` from user rows' tool_result blocks; `parentToolMap: Map<tool_use id, parent_tool_use_id>` from rows carrying parent_tool_use_id. Pass 2: `allToolCalls` built from assistant tool_use blocks: `{id, name, input, status: toolResults.has(id) ? 'success' : 'pending', result, isSubAgent: name === 'Task', subAgentType: input.subagent_type, parentToolId, childToolCalls: []}`.
- parseAssistantMessage (244-260): text blocks trimmed, non-empty -> text segment; thinking (block.thinking || content || text) trimmed -> thinking segment; tool_use -> tool_call segment only when top-level (no parentToolId).
- parseSystemMessage (300-337): subtype 'init' -> role system, one system_info segment (cwd, model, tools, mcp_servers, permissionMode, session_id, slash_commands).
- parseResultMessage (401-416): is_error && result -> role system text `Error: ${result}`, metadata systemSubtype 'error', duration_ms, total_cost_usd.
- tool_result has no segment of its own in Crystal; it attaches to ToolCall.result.

## vibe-kanban NormalizedEntryType (Apache-2.0)
- https://raw.githubusercontent.com/BloopAI/vibe-kanban/7c3807084daad0d9d315064f60fa869de254f027/crates/executors/src/logs/mod.rs
- NormalizedEntryType: UserMessage, UserFeedback{denied_tool}, AssistantMessage, ToolUse{tool_name, action_type, status}, SystemMessage, ErrorMessage{error_type}, Thinking, Loading, NextAction{...}, TokenUsageInfo, UserAnsweredQuestions{answers}.
- ActionType: FileRead{path}, FileEdit{path, changes}, CommandRun{command, result, category}, Search{query}, WebFetch{url}, Tool{tool_name, arguments, result}, TaskCreate{description, subagent_type, result}, PlanPresentation{plan}, TodoManagement{todos, operation}, AskUserQuestion{questions}, Other{description}.

## ccusage dedup (MIT, Copyright (c) 2025 ryoppippi)
- rust/adapters/claude/src/lib.rs `usage_dedupe_hash`: message id + request id (plus session id when request id is absent).

## Fixture check (orchestrator, local)
- Assistant rows sharing a message.id: 01: 56 rows / 27 ids; 02: 263 / 119; 03: 524 / 335; 04: 1036 / 601; 05: 83 / 29.
