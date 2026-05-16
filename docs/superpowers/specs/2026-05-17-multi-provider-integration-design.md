# Multi-Provider Integration: Design (v2 — Deep Brainstorm)

## Background

### User Need
Rivet currently only works with DeepSeek. Users want to integrate:
- **Kimi Code** — Anthropic endpoint at `https://api.kimi.com/coding/`
- **GLM-4** (智谱) — Anthropic endpoint at `https://open.bigmodel.cn/api/anthropic`
- **MiniMax** — Anthropic protocol
- **Mimo** — Anthropic protocol
- **GPT (OpenAI)** — OpenAI protocol only, user has Plus subscription

### Critical Discovery
Kimi Code, GLM, MiniMax, Mimo ALL support Anthropic protocol. Only GPT requires OpenAI protocol adapter.

### Current State

**Already works:**
- Config schema supports `Record<string, ProviderConfig>` with `default` selector
- `ProviderCapabilities` interface with `thinkingFormat`, `effortFormat`, `stripParams`, `mapUsage`
- `ProviderProfile` with cache profiles for 6 providers (deepseek, anthropic, openai, google, qwen, vllm)
- `SSEParser` is fully protocol-agnostic (76 lines, zero provider coupling)
- `StreamCallbacks` (onTextDelta, onThinkingDelta, onContentBlock, onStopReason) is already a canonical streaming protocol
- CLI manager supports `addProvider`, `removeProvider`, `setDefaultProvider`

**Bottlenecks (concentrated in 2 areas):**
1. `ApiClient.stream()` hardcodes Anthropic HTTP request (endpoint `/messages`, headers `x-api-key` + `anthropic-version`) and SSE event dispatch (`content_block_start/delta/stop`, `message_delta`)
2. `createDeepSeekClient()` called in 6 places (main.tsx ×3, create-agent-config.ts ×2, tests)

---

## Architecture: StreamClient + Dual Client + Config-Driven Factory

### Core Principle

**不在一个 class 里用 if/else 处理两种协议。让两个 Client 各自完整实现。**

现有 `ApiClient` 已经是完美的 AnthropicClient — 不改它。新建 `OpenAIClient` 实现同一接口。Factory 根据 config 中的 `protocol` 字段选择。

### Architecture Diagram

```
config.json
  → ProviderConfig { protocol: 'anthropic' | 'openai', baseUrl, capabilities }
    → createProviderClient(providerConfig)  [factory.ts]
      ├── protocol === 'anthropic'
      │     → ApiClient(config)  [现有 client.ts, 几乎不改]
      └── protocol === 'openai'
            → OpenAIClient(config)  [新建 openai-client.ts]
              → 两者都实现 StreamClient 接口
                → StreamCallbacks 就是 canonical protocol
                  → TUI / agent loop / tool pipeline 零改动
```

### Design Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| 内部 streaming 格式 | 保持现有 `StreamCallbacks` | 已经是 canonical protocol，改它需要改所有消费者 |
| 协议适配方式 | 双 Client 类（非 adapter-in-client） | 隔离性最强，各自可独立测试，避免 if/else 分支 |
| Capabilities 来源 | Config-driven + well-known defaults | 新 provider 只需 config 变更，零代码 |
| `deepseek.ts` | 删除，逻辑合并到 `factory.ts` | 文件名 misleading，factory 更通用 |
| Prefix cache | `prefixCacheStrategy` 字段 | 保护 Rivet 核心优势，非 DeepSeek provider 跳过 cache fingerprint |
| Fallback | Config schema 预留 `fallback[]` | Phase 3 实现 automatic failover |

### Why Not Other Approaches

| 方案 | 灭绝原因 |
|------|---------|
| Thin Shim（只改 HTTP 层，SSE 分发不变） | OpenAI 事件"伪装"成 Anthropic 事件是 leaky abstraction，Phase 2 必须重写 |
| Middleware Pipeline（在 ApiClient 外层转换） | 双向流转换（request + response）在 middleware 中极难调试，OpenAI tool_calls 增量解析需要状态 |
| Full Adapter in ApiClient（adapter 接口在 client 内部） | 过度设计 — 5/6 provider 同协议，只有 1 个需要适配 |

---

## Component Design

### 1. StreamClient Interface

```typescript
// src/api/stream-client.ts — NEW (~15 lines)
import type { MessageRequest } from './types.js'
import type { StreamCallbacks } from './client.js'

export interface StreamClient {
  stream(request: MessageRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void>
}
```

现有 `ApiClient` 已满足此接口（duck typing），只需加 `implements StreamClient`。

### 2. Config Schema Extension

```typescript
// src/config/schema.ts — MODIFY
export const providerSchema = z.object({
  name: z.string(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url(),
  protocol: z.enum(['anthropic', 'openai']).default('anthropic'),  // NEW
  models: z.array(modelConfigSchema).min(1),
  thinking: z.enum(['enabled', 'disabled']).default('enabled'),
  maxTokens: z.number().int().positive().default(64000),
  unsupported: z.array(z.string()).default([]),
  capabilities: z.object({                                          // NEW
    cacheControl: z.boolean().default(false),
    stripParams: z.array(z.string()).default([]),
    toolJsonBug: z.boolean().default(false),
    prefixCache: z.enum(['deepseek-native', 'anthropic-cache-control', 'none']).default('none'),
  }).default({}),
  fallback: z.array(z.string()).default([]),                        // NEW (Phase 3)
})
```

### 3. Provider Factory

```typescript
// src/api/factory.ts — NEW (~40 lines)
import { ApiClient, type ClientConfig } from './client.js'
import { OpenAIClient } from './openai-client.js'
import type { StreamClient } from './stream-client.js'
import type { ProviderConfig } from '../config/schema.js'
import { resolveCapabilities } from './provider.js'

export function createProviderClient(providerConfig: ProviderConfig): StreamClient {
  const caps = resolveCapabilities(providerConfig)

  if (providerConfig.protocol === 'openai') {
    return new OpenAIClient({
      baseUrl: providerConfig.baseUrl,
      apiKey: resolveApiKey(providerConfig),
      model: providerConfig.models[0].id,
      maxTokens: providerConfig.maxTokens,
    })
  }

  return new ApiClient({
    baseUrl: providerConfig.baseUrl,
    apiKey: resolveApiKey(providerConfig),
    model: providerConfig.models[0].id,
    maxTokens: providerConfig.maxTokens,
    thinking: providerConfig.thinking,
    thinkingBudget: undefined,
    reasoningEffort: caps.effortFormat === 'none' ? undefined : 'high',
    unsupported: caps.stripParams,
    hasToolJsonInContentBug: caps.hasToolJsonInContentBug,
    mapUsage: caps.mapUsage,
  })
}

function resolveApiKey(config: ProviderConfig): string {
  if (config.apiKey) return config.apiKey
  if (config.apiKeyEnv) return process.env[config.apiKeyEnv] ?? ''
  return ''
}
```

### 4. Capabilities Resolution

```typescript
// src/api/provider.ts — MODIFY (add resolveCapabilities + well-known defaults)

const WELL_KNOWN_DEFAULTS: Record<string, Partial<ProviderCapabilities>> = {
  deepseek: {
    supportsThinking: true, thinkingFormat: 'anthropic',
    supportsCacheControl: false, hasToolJsonInContentBug: true,
    effortFormat: 'reasoning_effort',
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    prefixCacheStrategy: 'deepseek-native',
  },
  kimi: {
    supportsThinking: true, thinkingFormat: 'anthropic',
    supportsCacheControl: false, hasToolJsonInContentBug: false,
    effortFormat: 'none', stripParams: ['top_k', 'metadata'],
    prefixCacheStrategy: 'none',
  },
  glm: {
    supportsThinking: true, thinkingFormat: 'anthropic',
    supportsCacheControl: false, hasToolJsonInContentBug: false,
    effortFormat: 'none', stripParams: ['top_k', 'metadata', 'service_tier'],
    prefixCacheStrategy: 'none',
  },
  minimax: {
    supportsThinking: true, thinkingFormat: 'anthropic',
    supportsCacheControl: false, hasToolJsonInContentBug: false,
    effortFormat: 'none', stripParams: ['top_k', 'metadata'],
    prefixCacheStrategy: 'none',
  },
  openai: {
    supportsThinking: false, thinkingFormat: 'none',
    supportsCacheControl: false, hasToolJsonInContentBug: false,
    effortFormat: 'none', stripParams: [],
    prefixCacheStrategy: 'none',
  },
}

export function resolveCapabilities(providerConfig: ProviderConfig): ProviderCapabilities {
  const wellKnown = WELL_KNOWN_DEFAULTS[providerConfig.name] ?? {}
  const configCaps = providerConfig.capabilities ?? {}

  return {
    ...DEFAULT_CAPABILITIES,
    ...wellKnown,
    // Config overrides well-known defaults
    supportsCacheControl: configCaps.cacheControl ?? wellKnown.supportsCacheControl ?? false,
    stripParams: configCaps.stripParams ?? wellKnown.stripParams ?? [],
    hasToolJsonInContentBug: configCaps.toolJsonBug ?? wellKnown.hasToolJsonInContentBug ?? false,
    prefixCacheStrategy: configCaps.prefixCache ?? wellKnown.prefixCacheStrategy ?? 'none',
  }
}
```

### 5. OpenAIClient (Phase 2)

```typescript
// src/api/openai-client.ts — NEW (~200 lines, Phase 2)
import type { MessageRequest, ContentBlock } from './types.js'
import type { StreamCallbacks } from './client.js'
import type { StreamClient } from './stream-client.js'
import { SSEParser } from './sse.js'

export interface OpenAIClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
}

export class OpenAIClient implements StreamClient {
  constructor(private config: OpenAIClientConfig) {}

  async stream(request: MessageRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    const body = this.buildRequestBody(request)
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(`OpenAI API error ${response.status}: ${errorBody}`)
    }

    // Parse SSE stream → emit StreamCallbacks
    await this.parseStream(response, callbacks)
  }

  private buildRequestBody(request: MessageRequest): Record<string, unknown> {
    // Convert Anthropic MessageRequest → OpenAI ChatCompletion request
    // - ContentBlock[] messages → OpenAI message array
    // - tool_use/tool_result → tool_calls/tool role
    // - system prompt handling
    // Implementation in Phase 2
  }

  private async parseStream(response: Response, callbacks: StreamCallbacks): Promise<void> {
    // Parse OpenAI SSE format:
    // - choices[0].delta.content → callbacks.onTextDelta
    // - choices[0].delta.tool_calls → buffer → callbacks.onContentBlock (tool_use)
    // - choices[0].finish_reason → callbacks.onStopReason
    // - data: [DONE] → end
    // Implementation in Phase 2
  }
}
```

### 6. Prefix Cache Compatibility

```typescript
// src/prompt/cache-fingerprint.ts — MODIFY
// Add early return when provider doesn't support prefix cache

export function buildCacheFingerprint(
  systemPrompt: string,
  capabilities: ProviderCapabilities,
): CacheFingerprint | null {
  if (capabilities.prefixCacheStrategy === 'none') return null
  // ... existing logic for deepseek-native and anthropic-cache-control
}
```

---

## Callsite Migration

| File | Current | After |
|------|---------|-------|
| `src/main.tsx:20` | `import { createDeepSeekClient }` | `import { createProviderClient }` |
| `src/main.tsx:255` | `createDeepSeekClient({...})` | `createProviderClient(activeProvider)` |
| `src/main.tsx:495` | `createDeepSeekClient({...})` | `createProviderClient(activeProvider)` |
| `src/agent/create-agent-config.ts:1` | `import { createDeepSeekClient }` | `import { createProviderClient }` |
| `src/agent/create-agent-config.ts:35` | `createDeepSeekClient({...})` | `createProviderClient(providerConfig)` |
| `src/agent/create-agent-config.ts:53` | `createDeepSeekClient({...})` | `createProviderClient(compactProvider)` |

After migration, `src/api/deepseek.ts` is deleted. `mapDeepSeekUsage` moves to `provider.ts` as a well-known default.

---

## Example Configurations

### Minimal (DeepSeek only — current behavior)

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "name": "deepseek",
        "baseUrl": "https://api.deepseek.com/anthropic",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          { "id": "deepseek-reasoner", "contextWindow": 128000, "maxTokens": 64000 }
        ]
      }
    }
  }
}
```

### Multi-Provider (Phase 1 complete)

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "name": "deepseek",
        "baseUrl": "https://api.deepseek.com/anthropic",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          { "id": "deepseek-reasoner", "contextWindow": 128000, "maxTokens": 64000 },
          { "id": "deepseek-v4-flash", "contextWindow": 128000, "maxTokens": 16000 }
        ]
      },
      "kimi": {
        "name": "kimi",
        "baseUrl": "https://api.kimi.com/coding/",
        "apiKeyEnv": "KIMI_API_KEY",
        "models": [
          { "id": "kimi-k2", "contextWindow": 128000, "maxTokens": 64000 }
        ],
        "thinking": "enabled"
      },
      "glm": {
        "name": "glm",
        "baseUrl": "https://open.bigmodel.cn/api/anthropic",
        "apiKeyEnv": "GLM_API_KEY",
        "models": [
          { "id": "glm-4-plus", "contextWindow": 128000, "maxTokens": 32000 }
        ],
        "thinking": "enabled"
      },
      "minimax": {
        "name": "minimax",
        "baseUrl": "https://api.minimax.chat/v1/anthropic",
        "apiKeyEnv": "MINIMAX_API_KEY",
        "models": [
          { "id": "MiniMax-M1", "contextWindow": 1000000, "maxTokens": 64000 }
        ],
        "thinking": "enabled"
      }
    }
  }
}
```

### With OpenAI (Phase 2 complete)

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": { "..." : "..." },
      "kimi": { "..." : "..." },
      "openai": {
        "name": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "protocol": "openai",
        "models": [
          { "id": "gpt-4o", "contextWindow": 128000, "maxTokens": 16384 },
          { "id": "o3", "contextWindow": 200000, "maxTokens": 100000, "reasoningEffort": "high" }
        ],
        "thinking": "disabled",
        "maxTokens": 16384
      }
    }
  }
}
```

### With Fallback (Phase 3)

```json
{
  "provider": {
    "default": "deepseek",
    "fallback": ["kimi", "glm", "minimax"],
    "providers": { "..." : "..." }
  }
}
```

---

## Implementation Timeline

| Phase | Scope | Time | Deliverable |
|-------|-------|------|-------------|
| Phase 1 | Config plumbing + factory | ~2h | Kimi, GLM, MiniMax, Mimo (all Anthropic-compatible) |
| Phase 2 | OpenAIClient | ~5h | GPT-4o, o3, any OpenAI-compatible model |
| Phase 3 | Fallback + polish | ~3h | Auto-failover, `/model` runtime switch, docs |
| **Total** | | **~10h** | **6+ providers** |

### Phase 1 Detailed Steps

1. Add `protocol` and `capabilities` fields to `providerSchema`
2. Create `src/api/stream-client.ts` (interface)
3. Add `implements StreamClient` to `ApiClient`
4. Create `src/api/factory.ts` (createProviderClient)
5. Add `resolveCapabilities()` + `WELL_KNOWN_DEFAULTS` to `provider.ts`
6. Migrate 6 callsites from `createDeepSeekClient` → `createProviderClient`
7. Delete `src/api/deepseek.ts` (move `mapDeepSeekUsage` to `provider.ts`)
8. Integration test: configure Kimi, send message, verify response

### Phase 2 Detailed Steps

1. Create `src/api/openai-client.ts` implementing `StreamClient`
2. Implement `buildRequestBody()` — message format conversion (ContentBlock[] → OpenAI messages)
3. Implement `parseStream()` — OpenAI SSE → StreamCallbacks
4. Handle tool_calls incremental buffering (highest risk)
5. Integration test: configure GPT-4o, send message with tool_use, verify tool call round-trip

### Phase 3 Detailed Steps

1. Implement fallback chain in factory (retry with next provider on 429/5xx)
2. `/model` command: runtime provider+model switch without restart
3. Prefix cache compatibility: skip cache fingerprint for `prefixCacheStrategy: 'none'`
4. Error messages: provider-specific error formatting

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Anthropic-compatible providers have subtle SSE differences | Medium | Phase 1 integration test per provider; defensive parsing already exists |
| OpenAI tool_calls incremental buffering edge cases | High | Phase 2 starts with text-only; tool_use as Phase 2.5 |
| Prefix cache regression when switching providers | High | `prefixCacheStrategy` field; prompt assembly checks before inserting breakpoints |
| Config migration for existing users | Low | `protocol` defaults to `'anthropic'`; existing configs work unchanged |
| `mapDeepSeekUsage` removal breaks existing behavior | Low | Move to `WELL_KNOWN_DEFAULTS.deepseek.mapUsage`; same logic, different location |

## Strongest Adaptation Point

Phase 1 改动极小（~50 行新代码 + 6 个 callsite 替换），立即解锁 4 个 provider。现有 `ApiClient` 零改动 — 它已经是完美的 AnthropicClient。

## Fragile Point

OpenAI 消息格式转换（Phase 2）。Anthropic 用 `ContentBlock[]` 混合 text + tool_use + tool_result；OpenAI 用扁平 message 数组 + 独立 `tool` role。转换必须正确处理多轮 tool use 对话。应对：先支持 text-only 对话，tool_use 单独迭代验证。

---

## Deep Brainstorm Process (Reference)

### 方案演化记录

| 方案 | 生态位 | 结局 | 原因 |
|------|--------|------|------|
| V1: Full Protocol Adapter | 最干净架构 | 存活（特征被吸收） | adapter 精华 = "client 本身就是 adapter" |
| V2: Thin Shim | 最快交付 | 灭绝 | OpenAI 事件伪装成 Anthropic = leaky abstraction |
| V3: Dual Client | 最实用 | 存活（成为最终方案骨架） | 隔离性最强，各自完整实现 |
| V4: Middleware Pipeline | 最灵活 | 灭绝 | 双向流转换 + 有状态解析不适合无状态 middleware |

### 收敛洞察

V1 和 V3 收敛到同一核心原则：**不在一个 class 里用 if/else 处理两种协议，让两个 class 各自完整实现**。

### 调研支撑

- Vercel AI SDK v5: per-provider adapter package + canonical internal streaming protocol
- Portkey Gateway: TypeScript-native, per-provider adapter + unified response normalization
- multi-llm-ts: factory pattern `igniteModel(provider, model, config)`
- Rivet 现有 `StreamCallbacks` 已经是 canonical protocol，不需要发明新 event type
