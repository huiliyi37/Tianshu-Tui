# CodexClient Timeout Resilience & Long-Wait UX

**Date**: 2026-05-17
**Status**: Approved
**Scope**: Fix silent-hang and user-facing stale feedback during long model operations

## Problem Statement

When using the Codex (Responses API) provider, the terminal conversation can silently hang:

1. **CodexClient has no SSE idle timeout.** If the TCP connection dies or the server stops sending events, `reader.read()` in `processSSEStream()` blocks forever. The other two clients (`ApiClient`, `OpenAIClient`) have a 120s idle timeout; CodexClient has none.

2. **Users cannot distinguish "model is working" from "model is stuck."** The current stale detection fires at 10s regardless of phase, showing "may be stuck" warnings during normal long operations (deep thinking, file collection). This trains users to ignore warnings — defeating the purpose.

### Observed symptoms (all Codex provider)

| Symptom | Root cause |
|---------|------------|
| Thinking ends, no text reply, cursor stops | SSE stream died silently; no idle timeout to detect it |
| Spinner runs for minutes, no thinking, no text | SSE connected but server is hung or model is in long internal processing |
| Partial text, then stops mid-sentence | Stream error swallowed without surfacing to user |
| Cannot recover via Ctrl+C for a long time | Abort signal doesn't propagate to a dead `reader.read()` |

## Design

Two independent fixes. Neither depends on the other.

### Fix 1: CodexClient SSE Idle Timeout (180s)

**File**: `src/api/codex-client.ts` — `processSSEStream()` method (line 206)

**Approach**: Port the idle-timer pattern already proven in `ApiClient` (`client.ts:292-306`) and `OpenAIClient` (`openai-client.ts:219-225`).

**Timeout value**: 180s (vs. 120s for other clients). Rationale: Responses API's agentic loop (parallel tool calls + reasoning) can produce longer silent gaps than a single chat completion. Research confirms Cursor and other coding agents struggle with the same issue during extended reasoning phases.

```typescript
const READ_TIMEOUT_MS = 180_000
let streamTimedOut = false
let idleTimer: ReturnType<typeof setTimeout> | null = null

const resetIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    streamTimedOut = true
    reader.cancel().catch(() => {})
  }, READ_TIMEOUT_MS)
}
```

**Integration point** in `processSSEStream()`:

```
try {
  resetIdleTimer()                    // Start initial timer
  while (true) {
    if (signal?.aborted) break
    if (streamTimedOut) throw new Error('Codex SSE stream idle timeout (180s)')
    const { done, value } = await reader.read()
    if (done) break
    resetIdleTimer()                  // Bytes received, reset timer
    // ... existing SSE parsing ...
  }
} finally {
  if (idleTimer) clearTimeout(idleTimer)  // Prevent leak
  reader.releaseLock()
}
```

**Error propagation**:
- `throw` → caught by `stream()` outer catch (line 67)
- Retried up to 3 times via existing retry loop (lines 30-79)
- After retries exhausted → `callbacks.onError()` → TUI displays error
- User can then Ctrl+C / re-ask

**Why not `AbortSignal.timeout()`**: Single-shot from request start, does NOT reset per chunk. Would kill active streams that happen to be slow. The manual `setTimeout` reset pattern is the proven approach (confirmed by research).

### Fix 2: Phase-Aware Long-Wait Feedback

**Files**:
- `src/tui/fluency-policy.ts` — stale detection thresholds and messages
- `src/tui/thinking.tsx` — thinking-phase wait messaging

**Current behavior** (to be replaced):
- `fluency-policy.ts:43`: Fires "Waiting Xs..." at 10s, "may be stuck" at 30s — regardless of phase
- `thinking.tsx:70-73`: Shows "waiting for response..." after 5s — too aggressive during normal deep thinking
- `fluency-policy.ts:81-88` (`STALE_THRESHOLDS`): thinking=60s, streaming=15s, tool=30s — reasonable but not surfaced to user as tiered messages

**New behavior**: Three tiers of user-facing feedback, phase-aware.

#### 2a. `fluency-policy.ts` — `computeFluencyPolicy()` (lines 28-63)

Replace the single `silentMs >= 10_000` check with phase-aware thresholds:

| Phase | Tier 1 (info) | Tier 2 (warn) | Tier 3 (actionable) |
|-------|---------------|---------------|---------------------|
| thinking | 30s: "Thinking deeply... (Xs)" | 90s: "Collecting context... (Xm)" | 180s: "Long think — Ctrl+C to stop" |
| streaming | 15s: "Waiting for response... (Xs)" | 60s: "Still waiting... (Xm)" | 120s: "No response — Ctrl+C to interrupt" |
| tool | 45s: "Executing tools... (Xs)" | 90s: "Tool running long... (Xm)" | 180s: "Tool may be stuck — Ctrl+C" |
| mcp | 15s: same as streaming | 30s: same | 60s: same |
| compacting | 30s: "Compacting... (Xs)" | 120s: same | 240s: same |
| analyzing | 15s: same as streaming | 60s: same | 120s: same |

Implementation: replace the `silentMs >= 10_000` block with a `PHASE_STALE_TIERS` lookup table and tiered message generation.

#### 2b. `fluency-policy.ts` — `STALE_THRESHOLDS` (lines 81-88)

Update to align with Tier 2 thresholds (the point at which `computeStageHealth` reports `isStale`):

```typescript
const STALE_THRESHOLDS: Partial<Record<ActivityPhase, number>> = {
  thinking: 90_000,     // was 60_000
  streaming: 20_000,    // was 15_000
  tool: 60_000,         // was 30_000
  mcp: 30_000,          // unchanged
  compacting: 120_000,  // unchanged
  analyzing: 30_000,    // unchanged
}
```

#### 2c. `thinking.tsx` — thinking-phase messaging (lines 70-73, 97-98)

Replace fixed 5s "waiting for response..." with tiered display:

| thinking elapsed | Display |
|-----------------|---------|
| 0-30s | spinner + elapsed time (current behavior) |
| 30-90s | spinner + "Collecting context... Xs" |
| 90s-180s | spinner + "Still thinking... Xm Ys" |
| 180s+ | spinner + "Long think — Ctrl+C to stop (Xm Ys)" |

The spinner never stops — it keeps animating so the user knows the process is alive (or not, if it freezes — which would indicate a true hang that Fix 1 should catch).

## What This Does NOT Cover

- **SSE connection health probe**: OpenAI Responses API does not guarantee keepalive pings. Without server-side keepalive, a health probe cannot distinguish "connection dead" from "model thinking." Skip until we have evidence of non-event data being sent.
- **Auto-reconnect / stream resumption**: Codex Responses API does not document `Last-Event-ID` support. Skip.
- **Configurable timeout via CLI**: The 180s value is hardcoded. If needed later, expose as a config option.

## Files Changed

| File | Change |
|------|--------|
| `src/api/codex-client.ts` | Add idle timeout to `processSSEStream()` |
| `src/tui/fluency-policy.ts` | Phase-aware stale thresholds and tiered messages |
| `src/tui/thinking.tsx` | Tiered thinking-phase wait messaging |

## Tests

- `src/api/codex-client.ts` — add test: SSE stream that goes silent for >180s triggers timeout error
- `src/tui/fluency-policy.ts` — add tests: verify tiered messages per phase and duration
- `src/tui/thinking.tsx` — add test: verify tiered thinking messages at 30s/90s/180s boundaries

## Verification

1. `npm test` — all existing tests pass
2. `npm run typecheck` — no type errors
3. Manual: start Rivet with Codex provider, send a prompt that triggers file reading, verify:
   - Activity status shows "Collecting context..." after 30s of thinking
   - Ctrl+C interrupts cleanly within 2s
   - If SSE stream dies (simulate by killing backend), error surfaces within 180s
