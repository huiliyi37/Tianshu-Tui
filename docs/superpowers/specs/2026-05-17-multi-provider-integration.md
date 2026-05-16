# Multi-Provider Integration: Session Rendering P1/P2 + Cross-Provider Switching

> **Date:** 2026-05-17
> **Status:** Complete — Kimi verified working, GLM pending OpenAI protocol client

---

## What was built

### 1. Session Rendering P1/P2 (3 tasks)

| Component | File | Description |
|-----------|------|-------------|
| RingBuffer clear/drain | `src/tui/ring-buffer.ts` | Added `clear()` and `drain(n)` for segmented Static migration |
| AssistantMessage | `src/tui/assistant-message.tsx` | `●` lavender prefix + `⎿` dimColor indent, React.memo |
| App integration | `src/tui/app.tsx` | Dual Static (frozen/active), `migrateToFrozen` at turn end |

### 2. Cross-Provider Model Switching

| Component | File | Description |
|-----------|------|-------------|
| /model list all providers | `src/tui/slash-commands.ts` | Shows all providers + models, switch by alias |
| handleModelSwitch | `src/main.tsx` | Searches all providers, switches activeProvider + activeApiKey + currentModel |
| Default providers | `src/config/default.ts` | DeepSeek, Kimi, GLM built-in with correct endpoints |

### 3. Bug Fixes

| Fix | File | Root Cause |
|-----|------|------------|
| SSE `event:` without space | `src/api/sse.ts` | Kimi sends `event:message_start` (no space after colon). Parser only matched `event: `. All SSE events fell through to default `'message'`, streaming text silently dropped. |
| Ctrl+C immediate interrupt | `src/tui/app.tsx` | `agent.abort()` didn't set `isStreaming=false` immediately; second Ctrl+C couldn't reach exit path |
| Esc double-press cancel | `src/tui/app.tsx` | Only cockpit escape; now also cancels streaming tasks on double press |
| persist init order | `src/main.tsx` | `fileHistory` referenced `persist` before declaration |
| Kimi baseUrl | `src/config/default.ts` | `/coding` → `/coding/v1` (Anthropic endpoint is at `/coding/v1/messages`) |

---

## Provider Configuration

| Provider | baseUrl | Protocol | Model | Context | apiKeyEnv |
|----------|---------|----------|-------|---------|-----------|
| deepseek | `https://api.deepseek.com/anthropic` | anthropic | deepseek-v4-pro / v4-flash | 1M | `DEEPSEEK_API_KEY` |
| kimi | `https://api.kimi.com/coding/v1` | anthropic | kimi-for-coding | 200k | `KIMI_API_KEY` |
| glm | `https://open.bigmodel.cn/api/paas/v4` | openai (not yet supported) | glm-5.1 | 200k | `ZHIPU_API_KEY` |

### Key finding: SSE format compatibility

SSE spec says `event: value` (with space), but not all providers follow this. Kimi sends `event:value` (no space). The fix in `sse.ts` now accepts both formats:

```typescript
// Before: only matched "event: " (with space)
if (line.startsWith('event: ')) {

// After: matches both "event:value" and "event: value"
if (line.startsWith('event:') || line.startsWith('event: ')) {
```

This is critical for any provider using Anthropic-compatible SSE — always verify the exact byte format.

### GLM status

GLM's `/api/paas/v4` is OpenAI-compatible, not Anthropic-compatible. Requires implementing an OpenAI protocol client in `src/api/openai-client.ts` (currently factory.ts throws for `protocol: 'openai'`).

---

## Commits

```
099b0f6 fix(api): SSE parser accept 'event:' without space after colon
e84f11c fix(tui): /model shows clear error when API key missing, instead of silent skip
ff4ce98 feat(tui): /model cross-provider switching — list all providers, switch model+provider at runtime
f81fc7e fix(config): set kimi/glm contextWindow to 200k
9b44826 fix(config): update kimi/glm endpoints — api.kimi.com/coding + open.bigmodel.cn/api/anthropic
64b4724 feat(config): add kimi and glm as built-in default providers
195f469 fix: move persist declaration before fileHistory to fix initialization order
e8c03e38 feat(tui): integrate AssistantMessage + segmented Static (frozen/active)
289c2a2 test(tui): remove meaningless String.split tests from AssistantMessage
d3fd31f feat(tui): integrate AssistantMessage + segmented Static (frozen/active)
32a7a5b feat(tui): add AssistantMessage component with ● prefix and ⎿ indent
720f63b feat(tui): add clear() and drain(n) to RingBuffer for segmented Static
```
