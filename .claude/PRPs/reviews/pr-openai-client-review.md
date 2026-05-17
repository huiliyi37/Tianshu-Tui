# Code Review: feat/openai-client — OpenAI Protocol Client

**Reviewed**: 2026-05-17
**Branch**: feat/openai-client → main
**Decision**: APPROVE with comments

## Summary

Solid implementation of OpenAI protocol support. Message format conversion (Anthropic ContentBlock[] → OpenAI chat completions) and SSE stream parsing are correct and well-tested. Three MEDIUM gaps vs. the existing `ApiClient` are worth addressing in a follow-up.

## Findings

### CRITICAL
None

### HIGH
None

### MEDIUM

**M1. No retry logic (openai-client.ts:30-56)**
`ApiClient` has `withRetry` with exponential backoff and 429 `retry-after` handling. `OpenAIClient.stream()` throws immediately on transient failures. A single 429 or 5xx will crash the agent turn.
→ Fix: Extract shared retry wrapper or add retry to `OpenAIClient.stream()`.

**M2. No stream idle timeout (openai-client.ts:142-177)**
`ApiClient` has a 120s `READ_TIMEOUT_MS` that cancels stalled readers. `parseStreamFromReader` has no such protection — a stalled upstream will hang the TUI indefinitely.
→ Fix: Add idle timeout parameter to `parseStreamFromReader` or wrap in a `Promise.race` with timeout.

**M3. Empty usage in onStopReason (openai-client.ts:216)**
`onStopReason` is called with `{}`. OpenAI provides usage in the final chunk when `stream_options: { include_usage: true }` is set, but this isn't configured in `buildRequestBody`. Token counting for cost display will be missing for OpenAI models.
→ Fix: Add `stream_options: { include_usage: true }` to request body and parse usage from the final chunk.

### LOW

**L1. flushToolCalls signature includes unused onStopReason (openai-client.ts:220)**
`flushToolCalls` takes `Partial<Pick<StreamCallbacks, 'onContentBlock' | 'onStopReason'>>` but only uses `onContentBlock`. The `onStopReason` in the Pick is dead.

**L2. toolCallBuffer not cleared between stream calls (openai-client.ts:26)**
If a single `OpenAIClient` instance were reused across multiple `stream()` calls, leftover buffer from a prior stream could leak into the next. The factory creates fresh instances per call, so this is safe in practice but fragile.

**L3. Tests use `as any` to access buildRequestBody (openai-client.test.ts:33,53,74,...)**
Private method tested via bracket access. Acceptable tradeoff for testing internal logic without exposing it in the public API, but consider making `buildRequestBody` `protected` or `public` if testability is a priority.

**L4. Missing test: system as SystemBlock[] (openai-client.test.ts)**
`buildRequestBody` handles both `string` and `SystemBlock[]` for `request.system`, but only the string case is tested.

**L5. Missing test: assistant with thinking + tool_use blocks**
No test verifies that thinking blocks are correctly skipped when converting assistant messages with mixed content types.

## Validation Results

| Check | Result |
|---|---|
| Type check | Pass (0 errors) |
| Tests | Pass (1046/1046) |
| Lint | Skipped (no lint config) |
| Build | Skipped (not requested) |

## Files Reviewed

| File | Change |
|------|--------|
| `src/api/openai-client.ts` | Added — OpenAIClient class |
| `src/api/__tests__/openai-client.test.ts` | Added — 17 tests |
| `src/api/stream-client.ts` | Modified — added optional setReasoningEffort |
| `src/api/factory.ts` | Modified — returns StreamClient, creates OpenAIClient |
| `src/api/__tests__/factory.test.ts` | Modified — test expects OpenAIClient |
| `src/agent/loop.ts` | Modified — client typed as StreamClient |
| `src/agent/worker-session.ts` | Modified — client typed as StreamClient |
| `src/compact/auto.ts` | Modified — client typed as StreamClient |
