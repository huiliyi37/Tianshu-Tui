# Ice Mirror Cache Engine Verification Plan

**Date:** 2026-05-20
**Objective:** Verify that the ice-mirror cache engine achieves 70-90% cache hit rates on DeepSeek V4 Pro

---

## Executive Summary

The ice-mirror cache engine has been implemented to improve prefix cache hit rates from ~5% to 70-90% by maintaining byte-stable prefixes across turns. This document outlines how cache metrics are captured in the codebase and provides multiple verification approaches.

---

## Cache Metrics Architecture

### 1. API Response Extraction

**File:** `src/api/openai-client.ts`

Cache metrics are extracted from the DeepSeek API response in the final SSE chunk:

```typescript
// Lines 24-26 in openai-client.ts
cache_read_input_tokens: usage.prompt_cache_hit_tokens ?? 0,
cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
```

DeepSeek returns:
- `prompt_cache_hit_tokens` → mapped to `cache_read_input_tokens`
- `prompt_cache_miss_tokens` → mapped to `cache_creation_input_tokens`

### 2. Provider-Agnostic Mapping

**File:** `src/api/provider.ts`

The `mapDeepSeekUsage()` function normalizes cache fields:

```typescript
// Lines 37-44
export function mapDeepSeekUsage(raw: Record<string, unknown>): Usage {
  return {
    input_tokens: (raw.prompt_tokens ?? raw.input_tokens ?? 0) as number,
    output_tokens: (raw.completion_tokens ?? raw.output_tokens ?? 0) as number,
    cache_read_input_tokens: (raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? 0) as number,
    cache_creation_input_tokens: (raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0) as number,
  }
}
```

**Provider capabilities indicate cache strategy:**

```typescript
// Lines 47-56
export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  prefixCacheStrategy: 'deepseek-native',  // Transparent exact-prefix caching
  supportsCacheControl: false,              // No cache_control breakpoints needed
  mapUsage: mapDeepSeekUsage,
}
```

### 3. Session-Level Tracking

**File:** `src/agent/context.ts`

`SessionContext` maintains per-turn cache history:

```typescript
// Lines 16-22
export interface TurnCacheSnapshot {
  turn: number
  cacheRead: number        // cache_read_input_tokens for this turn
  cacheCreation: number    // cache_creation_input_tokens for this turn
  inputTokens: number
  outputTokens: number
}
```

**Key methods:**

- `recordTurnCache(turn, usage)` — Called after each turn to store cache metrics
- `getCacheHitRate()` — Returns `cache_read / (cache_read + cache_creation)` across all turns
- `getLatestTurnHitRate()` — Returns hit rate for the most recent turn
- `getRecentTurnHitRate(lastN)` — Returns rolling average over last N turns

**Cache hit rate formula:**

```typescript
// Lines 100-103
getCacheHitRate(): number {
  const total = this.state.totalUsage.cache_read_input_tokens + 
                this.state.totalUsage.cache_creation_input_tokens
  return total === 0 ? 0 : this.state.totalUsage.cache_read_input_tokens / total
}
```

### 4. TUI Cache Telemetry

**File:** `src/tui/cache-telemetry.ts`

Projects cache metrics for UI display with status indicators:

```typescript
// Lines 19-53
export function projectCacheTelemetry(
  session: CacheTelemetrySession,
  turnNumber: number,
  previousStatus: CacheStatus,
): CacheTelemetryProjection {
  const hitRate = session.getRecentTurnHitRate(3) ?? session.getCacheHitRate()
  const latestHitRate = hasCurrentCounters ? session.getLatestTurnHitRate() : null

  // Status thresholds:
  if (latestHitRate !== null && latestHitRate < 0.4 && turnNumber > 1) {
    return { hitRate, status: 'degraded', latestHitRate, wasCompacted }
  }
  if (latestHitRate !== null && latestHitRate >= 0.6) {
    return { hitRate, status: previousStatus === 'degraded' ? 'recovering' : 'healthy', ... }
  }
  return { hitRate, status: 'healthy', latestHitRate, wasCompacted }
}
```

**Status values:**
- `'healthy'` — Hit rate >= 60%
- `'degraded'` — Hit rate < 40% (after turn 1)
- `'recovering'` — Previously degraded, now improving
- `'stale'` — No current turn data but historical data exists

### 5. Debug Command

**File:** `src/tui/slash-commands.ts`

The `/debug cache` command displays comprehensive cache metrics:

```typescript
// Lines 204-208
} else if (subcmd === 'cache') {
  const usage = ctx.session.getTotalUsage()
  const hitRate = ctx.cacheHitRate
  const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  pushStatic(createLogEntry({ 
    type: 'system', 
    content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  ...`
  }))
}
```

**Output includes:**
- Overall cache hit rate (percentage)
- Total cache read tokens
- Total cache write tokens
- Total input/output tokens
- Estimated tokens
- Cost and savings

---

## Verification Approaches

### Approach A: Interactive Manual Verification (Recommended)

**Steps:**

1. **Start the agent:**
   ```bash
   cd /Users/banxia/app/deepseek-tui/opencode-tui
   npm run build
   npm start
   ```

2. **Send a series of messages (5-10 turns):**
   ```
   Turn 1: "What files are in the src directory?"
   Turn 2: "Read the main.tsx file"
   Turn 3: "Explain the AgentLoop class"
   Turn 4: "List all test files"
   Turn 5: "Run the test suite"
   ```

3. **Check cache metrics after each turn:**
   ```
   /debug cache
   ```

4. **Expected results:**

   | Turn | Expected Hit Rate | Rationale |
   |------|------------------|-----------|
   | 1    | 0%               | First turn, no cache to hit |
   | 2    | 50-70%           | System prompt + turn 1 cached |
   | 3    | 70-80%           | Growing prefix cached |
   | 5    | 80-90%           | Stable prefix well-established |
   | 10   | 85-92%           | Prefix cache mature |

5. **Check for status indicators:**
   - After turn 2+: Status should be `'healthy'` (>= 60%)
   - If compacted: May show `'degraded'` or `'recovering'`
   - If prefix drift: Status will drop

**Advantages:**
- Real-world usage patterns
- Tests actual tool calls and message accumulation
- Visual feedback from TUI

**Disadvantages:**
- Manual process
- Requires human interaction
- Not reproducible

---

### Approach B: Goal Loop Automated Verification (Recommended for CI)

**Steps:**

1. **Build the agent:**
   ```bash
   npm run build
   ```

2. **Run a goal loop with cache logging:**
   ```bash
   node dist/main.js --goal "List all TypeScript files in src/ and count them" --budget 5 --stream-json
   ```

3. **Parse JSON output for cache metrics:**
   ```bash
   node dist/main.js --goal "List all TypeScript files in src/ and count them" --budget 5 --stream-json 2>&1 | grep '"type":"goal_iteration"' | jq '.usage'
   ```

4. **Expected JSON output:**
   ```json
   {
     "type": "goal_iteration",
     "iteration": 1,
     "achieved": false,
     "usage": {
       "input_tokens": 5000,
       "output_tokens": 2000,
       "cache_read_input_tokens": 0,
       "cache_creation_input_tokens": 5000
     }
   }
   {
     "type": "goal_iteration",
     "iteration": 2,
     "achieved": false,
     "usage": {
       "input_tokens": 6000,
       "output_tokens": 1500,
       "cache_read_input_tokens": 5000,
       "cache_creation_input_tokens": 1000
     }
   }
   ```

5. **Calculate hit rates:**
   - Iteration 1: 0% (expected)
   - Iteration 2: 5000 / (5000 + 1000) = 83% ✓

**Advantages:**
- Automated and reproducible
- JSON output for programmatic analysis
- Can be integrated into CI pipeline
- No manual interaction required

**Disadvantages:**
- Goal loop has different message patterns than interactive use
- May not test all tool call scenarios
- Requires API key in CI environment

---

### Approach C: Integration Test with Mock API

**Steps:**

1. **Create a test file:** `src/prompt/__tests__/ice-mirror-integration.test.ts`

2. **Test structure:**
   ```typescript
   import { describe, it, mock } from 'node:test'
   import assert from 'node:assert/strict'
   import { PromptEngine } from '../engine.js'
   import { createVolatileSnapshot } from '../volatile-snapshot.js'

   describe('ice-mirror prefix stability', () => {
     it('should produce byte-identical prefixes across turns', async () => {
       const snapshot = createVolatileSnapshot({ cwd: process.cwd() })
       const engine = new PromptEngine({
         model: 'deepseek-v4-pro',
         maxTokens: 8192,
         staticCtx: { tools: [] },
         volatileCtx: { cwd: process.cwd() },
       })

       // Turn 1
       const turn1 = engine.buildRequest([{ role: 'user', content: 'Hello' }], snapshot)
       const prefix1 = JSON.stringify(turn1.messages[0])

       // Turn 2 (with history)
       const turn2 = engine.buildRequest([
         { role: 'user', content: 'Hello' },
         { role: 'assistant', content: 'Hi there!' },
         { role: 'user', content: 'What files?' },
       ], snapshot)
       const prefix2 = JSON.stringify(turn2.messages[0])

       // Prefix should be byte-identical
       assert.strictEqual(prefix1, prefix2)
     })
   })
   ```

3. **Run the test:**
   ```bash
   npm test -- src/prompt/__tests__/ice-mirror-integration.test.ts
   ```

**Advantages:**
- Tests byte-level prefix stability
- No API calls required
- Fast execution
- Can test edge cases

**Disadvantages:**
- Doesn't verify actual cache hit rates from API
- May miss provider-specific behavior
- Requires mock data

---

### Approach D: Telemetry Log Analysis

**Steps:**

1. **Enable verbose logging (if available):**
   ```bash
   # Check if there's a log file location
   ls ~/.rivet/logs/
   ```

2. **Run the agent and collect logs:**
   ```bash
   npm start 2>&1 | tee /tmp/rivet-session.log
   ```

3. **After session, search for cache metrics in logs:**
   ```bash
   grep -i "cache\|hit_rate\|prompt_cache" /tmp/rivet-session.log
   ```

4. **Or check session persistence:**
   ```bash
   ls ~/.rivet/sessions/
   # Find the session ID and check for usage data
   ```

**Advantages:**
- Captures real session data
- Can analyze post-hoc
- Non-intrusive

**Disadvantages:**
- Depends on logging implementation
- May require parsing unstructured logs
- Less real-time feedback

---

## Recommended Verification Strategy

### Phase 1: Manual Verification (Immediate)

1. Run the agent interactively for 10 turns
2. Check `/debug cache` after each turn
3. Verify hit rates match expected values from the ice-mirror plan:
   - Turn 2: ~50-70%
   - Turn 5: ~75-85%
   - Turn 10: ~85-92%

4. Document actual vs expected in this table:

   | Turn | Expected | Actual | Notes |
   |------|----------|--------|-------|
   | 1    | 0%       |        |       |
   | 2    | 50-70%   |        |       |
   | 3    | 70-80%   |        |       |
   | 5    | 75-85%   |        |       |
   | 10   | 85-92%   |        |       |

### Phase 2: Automated Goal Loop Verification (Next)

1. Run 3 goal loops with different goals:
   ```bash
   node dist/main.js --goal "List all .ts files" --budget 3
   node dist/main.js --goal "Read package.json and summarize dependencies" --budget 3
   node dist/main.js --goal "Count lines of code in src/" --budget 3
   ```

2. Parse JSON output for cache metrics
3. Verify hit rates increase across iterations
4. Document results:

   | Goal | Iter 1 Hit Rate | Iter 2 Hit Rate | Iter 3 Hit Rate |
   |------|-----------------|-----------------|-----------------|
   | List files | | | |
   | Read package.json | | | |
   | Count lines | | | |

### Phase 3: Byte-Level Stability Verification (Optional)

1. Write integration test for prefix stability
2. Verify FROZEN block is byte-identical across turns
3. Verify dynamic appendix doesn't break prefix

---

## Known Issues and Edge Cases

### 1. First Turn Always 0%

- **Issue:** Turn 1 will always have 0% cache hit (nothing to cache)
- **Impact:** Expected behavior, not a bug
- **Verification:** Ensure turn 1 reports `cache_creation_input_tokens > 0`

### 2. Compaction Resets Cache

- **Issue:** `/compact` or automatic compaction restructures messages
- **Impact:** Cache hit rate drops temporarily after compaction
- **Verification:** Check `/debug cache` after compaction, expect temporary degradation

### 3. Provider-Specific Behavior

- **Issue:** DeepSeek returns `prompt_cache_hit_tokens`, other providers may not
- **Impact:** Cache metrics only available for providers that support it
- **Verification:** Ensure `DEEPSEEK_CAPABILITIES.prefixCacheStrategy === 'deepseek-native'`

### 4. Cache Eviction

- **Issue:** DeepSeek may evict cached prefixes after inactivity
- **Impact:** Hit rate may drop if session is idle for hours
- **Verification:** Test with short breaks between turns (< 5 min)

### 5. Message Order Sensitivity

- **Issue:** DeepSeek caches exact byte prefixes; message order matters
- **Impact:** Reordering messages breaks cache
- **Verification:** Ensure message array is stable across turns

---

## Expected Results

Based on the ice-mirror design document (`docs/superpowers/plans/2026-05-19-ice-mirror-cache-engine.md`):

| Metric | Before Ice-Mirror | After Ice-Mirror | CC+CTCL Baseline |
|--------|-------------------|------------------|------------------|
| Turn 2 cache hit | ~5% | ~50-70% | ~70% |
| Turn 5 cache hit | ~5% | ~75-85% | ~90% |
| Turn 10 cache hit | ~5% | ~85-92% | ~95%+ |

**Success Criteria:**
- Turn 2 hit rate >= 50%
- Turn 5 hit rate >= 75%
- Turn 10 hit rate >= 85%
- No prefix drift detected in `/debug fingerprint`

---

## Commands Reference

### Interactive Verification

```bash
# Build
npm run build

# Start interactive session
npm start

# Inside session, send messages and check cache:
/debug cache
/debug fingerprint
```

### Goal Loop Verification

```bash
# Simple goal with JSON output
node dist/main.js --goal "List all TypeScript files in src/" --budget 5 --stream-json

# Parse output for cache metrics
node dist/main.js --goal "Read README.md" --budget 3 --stream-json 2>&1 | \
  grep '"type":"goal_iteration"' | \
  jq '.usage | {input: .input_tokens, output: .output_tokens, cache_read: .cache_read_input_tokens, cache_creation: .cache_creation_input_tokens}'
```

### Debug Commands

```bash
# In interactive session:
/debug cache          # Show cache hit rate and token counts
/debug fingerprint    # Show prefix fingerprint and drift detection
/debug context-payload  # Show volatile context breakdown
```

---

## Troubleshooting

### Low Hit Rate (< 50% on Turn 2+)

1. Check fingerprint drift: `/debug fingerprint`
2. Verify volatile snapshot is stable: Compare FROZEN block across turns
3. Check for compaction: `/context` shows compact events
4. Verify API returns cache metrics: Check `prompt_cache_hit_tokens` in response

### No Cache Metrics Reported

1. Verify provider is DeepSeek: `/model` shows current provider
2. Check API response includes `prompt_cache_hit_tokens`
3. Verify `mapDeepSeekUsage` is called: Add logging to `src/api/provider.ts`

### Hit Rate Drops After Turn 5

1. Check for automatic compaction
2. Verify message array stability
3. Check if tools are modifying system prompt
4. Look for prefix drift in `/debug fingerprint`

---

## Next Steps

1. **Immediate:** Run manual verification (Phase 1)
2. **Short-term:** Add goal loop verification to CI (Phase 2)
3. **Optional:** Write byte-level stability tests (Phase 3)
4. **Documentation:** Update this plan with actual results

---

## References

- Ice Mirror Design: `docs/superpowers/plans/2026-05-19-ice-mirror-cache-engine.md`
- Cache Telemetry: `src/tui/cache-telemetry.ts`
- Session Context: `src/agent/context.ts`
- API Client: `src/api/openai-client.ts`
- Provider Capabilities: `src/api/provider.ts`
- Slash Commands: `src/tui/slash-commands.ts`

---

**Status:** Ready for verification
**Owner:** [Your name]
**Last Updated:** 2026-05-20
