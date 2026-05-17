# Failure Classifier Expansion + Activity Status Integration

> **Status**: Design approved, ready for implementation plan
> **Date**: 2026-05-17
> **Scope**: Extend `classifyFailure()` with 5 new failure types, add repair hint templates, integrate with Activity Status Layer for user-facing blocked notifications

## Problem

The current `classifyFailure()` covers 9 types focused on test/compilation scenarios. Common tool-execution errors (permission denied, API rate limits, context overflow, syntax errors, malformed output) fall into `unknown`, giving the agent vague "read the error carefully" guidance. This slows recovery, especially for long-running tasks.

Additionally, when tools are blocked (doom loop, rate limit, permission), the TUI provides no visual feedback — the user sees only `isError: true` text in the conversation, not a status indicator.

## Design Principles

1. **Minimal surface area** — 5 new types, no architectural changes to `classifyFailure()`
2. **Regex-based classification** — same pattern as existing types, deterministic and testable
3. **Activity Status integration** — specific error types trigger `onPhaseChange('blocked')` so TUI can display status
4. **Backward compatible** — all existing types and behaviors unchanged

---

## Part 1: New Failure Types

### Type Definitions

| # | `FailureClass` | Regex Patterns | Suggestion | Retryable |
|---|---------------|----------------|------------|-----------|
| 1 | `permission_denied` | `EACCES`, `Permission denied`, `Operation not permitted` | Check file permissions or sandbox policy. | No |
| 2 | `context_window_exceeded` | `context length exceeded`, `maximum context length`, `token limit`, `too many tokens` | Use /compact to reduce context, or start a new session. | No |
| 3 | `api_error` | `429`, `500`, `502`, `503`, `rate limit`, `Too Many Requests`, `Bad Gateway`, `Internal Server Error` | Transient API error. Retry after cooldown. | **Yes** |
| 4 | `syntax_error` | `SyntaxError`, `ParseError`, `unexpected token`, `Unexpected end of input`, `compilation error`, `Cannot find name`, `is not defined` | Fix the syntax or reference error in the code. | No |
| 5 | `format_error` | `JSON parse`, `malformed`, `Unterminated string`, `Unexpected end of JSON`, `Invalid character in JSON` | Model output was malformed. Retry with clearer format instructions. | Yes |

### Insertion Order in classifyFailure()

New types insert into the existing priority chain:

```
 1. type_error              (existing — TS-specific: error TS\d{4}:)
 2. module_resolution       (existing — Cannot find module)
 3. permission_denied       ← NEW (EACCES, Permission denied)
 4. missing_dep             (existing — command not found, Cannot find package)
 5. context_window_exceeded ← NEW (context length exceeded, token limit)
 6. timeout                 (existing — timeout, ECONNRESET)
 7. api_error               ← NEW (429, 500, rate limit)  ← after timeout to avoid double-match
 8. syntax_error            ← NEW (SyntaxError, ParseError, unexpected token)
 9. snapshot                (existing — snapshot diff/mismatch)
10. env_missing             (existing — environment variable, API key)
11. assertion               (existing — assert, expect)
12. format_error            ← NEW (JSON parse, malformed)  ← near bottom, broadest format catch
13. flaky                   (existing — flaky, intermittent)
```

Key ordering rationale:
- `permission_denied` before `missing_dep` — "Permission denied" on a command execution is more specific than "command not found"
- `context_window_exceeded` before `timeout` — context overflow is a distinct session-level issue, not a network timeout
- `api_error` after `timeout` — pure timeouts ("timed out") stay as `timeout`; HTTP status errors (429/5xx) become `api_error`
- `syntax_error` after `api_error` — compilation errors are more specific than HTTP errors
- `format_error` near bottom — broadest format catch, only matched if nothing more specific fits

### Updated isTransient()

Add `api_error` to the transient set (alongside `timeout` and `flaky`):

```typescript
const TRANSIENT_CLASSES: ReadonlySet<FailureClass> = new Set(['timeout', 'flaky', 'api_error'])
```

This means `api_error` will be auto-retried by `TurnHarness` (up to 2 retries) for concurrency-safe tools.

---

## Part 2: Repair Hint Templates

Extend `HINT_TEMPLATES` in `repair-hint.ts`:

```typescript
const HINT_TEMPLATES: Record<string, string> = {
  // Existing (unchanged)
  type_error: 'Ensure all parameters match the expected types exactly.',
  assertion: 'Verify the target content exists before attempting modification.',
  timeout: 'Use shorter commands or break into smaller operations.',
  missing_dep: 'Check that required imports and dependencies are available.',

  // NEW
  permission_denied: 'Check file permissions or run with appropriate access.',
  context_window_exceeded: 'Use /compact to reduce context before continuing.',
  api_error: 'Wait a moment for rate limit cooldown, then retry.',
  syntax_error: 'Fix the syntax error — check for missing brackets, semicolons, or typos.',
  format_error: 'The output was malformed. Retry with clearer format instructions.',
}
```

These templates are injected via `<repair-hint>` tags after 2+ consecutive failures of the same type on the same tool.

---

## Part 3: Activity Status Integration

### Interface Definition

The Activity Status Layer defines `onPhaseChange` on `AgentCallbacks`. This design specifies how failure classification triggers phase changes.

```typescript
// Extends existing AgentCallbacks in src/agent/loop.ts
interface AgentCallbacks {
  // ... existing callbacks ...
  onPhaseChange?: (phase: AgentPhase, detail?: PhaseDetail) => void
}

type AgentPhase =
  | 'idle' | 'research' | 'analysis' | 'implementation'
  | 'verification' | 'review' | 'responding'
  | 'blocked' | 'planning'

interface PhaseDetail {
  tool?: string
  target?: string
  step?: string
  file?: string
  reason?: string
  suggestion?: string
}
```

### Error-to-Phase Mapping

When `classifyFailure()` returns one of these classes, `tool-pipeline.ts` triggers `onPhaseChange`:

| FailureClass | Phase | Detail |
|-------------|-------|--------|
| `context_window_exceeded` | `blocked` | `{ reason: 'context overflow', suggestion: 'Use /compact to free context space' }` |
| `api_error` (429) | `blocked` | `{ reason: 'rate limited', suggestion: 'Waiting for cooldown...' }` |
| `api_error` (5xx) | `blocked` | `{ reason: 'server error', suggestion: 'Retrying with backoff' }` |
| `permission_denied` | `blocked` | `{ reason: 'permission denied', suggestion: 'Check file permissions' }` |

Other failure types (syntax_error, format_error) do NOT trigger `blocked` — they are recoverable by the agent without strategy change.

### Integration Point

In `tool-pipeline.ts`, after Layer 12 (repair hint + antibody), add:

```typescript
// After repairHintTracker.recordFailure(...)
if (callbacks.onPhaseChange && classified.class !== 'unknown') {
  if (BLOCKED_CLASSES.has(classified.class)) {
    callbacks.onPhaseChange('blocked', {
      tool: toolName,
      reason: classified.class,
      suggestion: classified.suggestion,
    })
  }
}
```

Where `BLOCKED_CLASSES` is:

```typescript
const BLOCKED_CLASSES: ReadonlySet<FailureClass> = new Set([
  'context_window_exceeded',
  'api_error',
  'permission_denied',
])
```

### TUI Display

The StatusBar phase indicator shows blocked state:

```
⛔ blocked — rate limited · waiting for cooldown
```

When the next tool call succeeds, phase transitions back to the appropriate active phase (research/implementation/etc.).

---

## Part 4: Behavioral Changes Summary

### Retry Policy Impact

| Change | Before | After |
|--------|--------|-------|
| `api_error` retries | Falls into `unknown` (no retry) | Auto-retried up to 2 times (transient) |
| `format_error` retries | Falls into `unknown` (no retry) | Auto-retried up to 2 times (transient) |
| `permission_denied` retries | Falls into `unknown` (no retry) | Not retried (correct — permissions won't change) |
| `context_window_exceeded` retries | Falls into `unknown` (no retry) | Not retried (correct — needs /compact) |
| `syntax_error` retries | Falls into `unknown` (no retry) | Not retried (correct — needs code fix) |

### Antibody Generation

New failure types will generate `failure_pattern` claims (antibodies) via `createAntibodyProposal()`:
- `api_error` antibodies will record the HTTP status code
- `permission_denied` antibodies will record the file path
- Other types follow existing pattern

### Doom Loop Interaction

Doom loop fingerprints include the failure class in the output classification. New types will produce different fingerprints than `unknown`, so:
- 3 consecutive `api_error` on same tool+input → blocked (correct: persistent rate limiting)
- 3 consecutive `permission_denied` on same file → blocked (correct: permission won't change)
- Mixed errors (api_error then syntax_error) → different fingerprints, no doom loop trigger

---

## Part 5: Test Plan

### New Tests in failure-classifier.test.ts

| Test | Input | Expected Class |
|------|-------|---------------|
| EACCES permission error | `EACCES: permission denied, open '/etc/shadow'` | `permission_denied` |
| Permission denied string | `Error: Permission denied` | `permission_denied` |
| Operation not permitted | `EPERM: operation not permitted` | `permission_denied` |
| Context length exceeded | `This model's maximum context length is 200000 tokens` | `context_window_exceeded` |
| Token limit | `Maximum context length exceeded` | `context_window_exceeded` |
| Too many tokens | `Too many tokens in input` | `context_window_exceeded` |
| Rate limit 429 | `429 Too Many Requests` | `api_error` |
| Server error 500 | `500 Internal Server Error` | `api_error` |
| Bad gateway 502 | `502 Bad Gateway` | `api_error` |
| Rate limit in text | `Error: rate limit exceeded` | `api_error` |
| SyntaxError | `SyntaxError: Unexpected token` | `syntax_error` |
| ParseError | `ParseError: Unexpected end of input` | `syntax_error` |
| Compilation error | `compilation error in module` | `syntax_error` |
| Reference error | `x is not defined` | `syntax_error` |
| JSON parse error | `JSON.parse: unexpected character` | `format_error` |
| Malformed output | `Error: malformed response` | `format_error` |
| Unterminated string | `Unterminated string in JSON` | `format_error` |
| Existing types unchanged | All existing regex patterns | Same class as before |

### New Tests in repair-hint.test.ts

| Test | Input | Expected |
|------|-------|----------|
| permission_denied hint after 2 failures | 2x `recordFailure('bash', 'permission_denied')` | Hint contains "Check file permissions" |
| api_error hint after 2 failures | 2x `recordFailure('web_fetch', 'api_error')` | Hint contains "rate limit cooldown" |
| context_window hint after 2 failures | 2x `recordFailure('bash', 'context_window_exceeded')` | Hint contains "/compact" |
| Existing hints unchanged | Existing failure types | Same templates as before |

### isTransient Tests

| Test | Expected |
|------|----------|
| `isTransient('api_error')` | `true` |
| `isTransient('permission_denied')` | `false` |
| `isTransient('context_window_exceeded')` | `false` |
| `isTransient('syntax_error')` | `false` |
| `isTransient('format_error')` | `true` |

---

## Files Changed

| File | Change |
|------|--------|
| `src/agent/failure-classifier.ts` | Add 5 failure types, update `isTransient()` |
| `src/agent/repair-hint.ts` | Add 5 hint templates |
| `src/agent/tool-pipeline.ts` | Add `onPhaseChange` trigger for blocked classes |
| `src/agent/__tests__/failure-classifier.test.ts` | Add 18+ classification tests |
| `src/agent/__tests__/repair-hint.test.ts` | Add 3+ hint template tests |

---

## Open Questions

1. **Activity Status Layer implementation** — `onPhaseChange` interface and TUI rendering are defined in `docs/superpowers/specs/2026-05-17-agent-activity-status-layer-design.md`. This spec only defines the error-to-phase mapping and integration point. The full Activity Status implementation (phase state machine, heartbeat, TUI display) is a separate workstream.

2. **`is not defined` false positives** — The pattern `is not defined` matches both `ReferenceError: x is not defined` (syntax_error) and legitimate "module X is not defined" messages. Since this is placed after `module_resolution` and `missing_dep`, those will catch module-related cases first.

---

## Non-Goals

- Sub-classification (e.g., `api_error.rate_limit` vs `api_error.server_error`) — keep flat for now
- New failure types beyond the 5 specified (e.g., `sandbox_error`, `limit_exceeded`) — not common enough in Rivet's architecture to justify
- Modifying existing tool error messages — tools already return descriptive errors; the classifier improves how those errors are categorized
