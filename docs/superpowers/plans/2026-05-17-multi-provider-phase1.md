# Multi-Provider Integration Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Rivet 支持多个 Anthropic-compatible provider（Kimi、GLM、MiniMax、Mimo），通过 config 切换，零代码变更即可添加新 provider。

**架构：** StreamClient 接口 + config-driven factory + well-known capabilities defaults。现有 ApiClient 不改（它就是 AnthropicClient），factory 根据 config.protocol 选择 client 实现。

**技术栈：** TypeScript, node:test, Zod schema, existing ApiClient/SSEParser infrastructure.

**前置条件：** 设计文档 `docs/superpowers/specs/2026-05-17-multi-provider-integration-design.md` 已审批 ✅

**验收标准：**
| 标准 | 验证方法 |
|------|---------|
| Config schema 支持 `protocol` 和 `capabilities` 字段 | `npm run typecheck` 通过 |
| `createProviderClient()` factory 根据 config 创建正确 client | 单元测试 |
| 6 个 callsite 迁移到 factory | grep 确认无 `createDeepSeekClient` 引用 |
| `deepseek.ts` 删除，`mapDeepSeekUsage` 迁移 | 文件不存在 + typecheck 通过 |
| Well-known defaults 覆盖 deepseek/kimi/glm/minimax/openai | 单元测试 |
| 现有测试全部通过 | `npm test`: 890+ pass, 0 fail |
| Kimi 配置可用（如有 API key） | 手动测试或 mock 验证 |

---

## Scope

### 本计划包含

- `StreamClient` 接口定义
- Config schema 扩展（`protocol`, `capabilities`, `fallback`）
- `createProviderClient()` factory
- `resolveCapabilities()` + `WELL_KNOWN_DEFAULTS`
- 6 个 callsite 迁移
- `deepseek.ts` 删除 + `mapDeepSeekUsage` 迁移
- 单元测试覆盖

### 本计划不包含

- `OpenAIClient` 实现（Phase 2）
- Fallback chain 逻辑（Phase 3）
- `/model` 运行时切换（Phase 3）
- Prefix cache 条件跳过（Phase 3）

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/api/stream-client.ts` | StreamClient 接口定义 |
| `src/api/factory.ts` | createProviderClient factory + resolveApiKey |
| `src/api/__tests__/factory.test.ts` | Factory 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/api/provider.ts` | 添加 `prefixCacheStrategy` 到 ProviderCapabilities + `WELL_KNOWN_DEFAULTS` + `resolveCapabilities()` |
| `src/api/client.ts` | 添加 `implements StreamClient` + export StreamCallbacks 类型 |
| `src/config/schema.ts` | providerSchema 添加 `protocol`, `capabilities`, `fallback` 字段 |
| `src/config/default.ts` | 默认 config 添加 `protocol: 'anthropic'` |
| `src/main.tsx` | 3 个 callsite 迁移 |
| `src/agent/create-agent-config.ts` | 2 个 callsite 迁移 |

### 删除文件

| 文件 | 原因 |
|------|------|
| `src/api/deepseek.ts` | 逻辑合并到 factory.ts + provider.ts |

---

## 任务 1：StreamClient 接口 + ApiClient implements

**文件：**
- 创建：`src/api/stream-client.ts`
- 修改：`src/api/client.ts`

- [ ] **步骤 1：创建 StreamClient 接口**

创建 `src/api/stream-client.ts`：

```typescript
import type { MessageRequest } from './types.js'
import type { StreamCallbacks } from './client.js'

export interface StreamClient {
  stream(request: MessageRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void>
}
```

- [ ] **步骤 2：导出 StreamCallbacks 类型**

在 `src/api/client.ts` 中，确认 `StreamCallbacks` 接口已 export（当前在 line 30 附近）。如果未 export，添加 `export`。

- [ ] **步骤 3：ApiClient 添加 implements**

在 `src/api/client.ts` 中修改 class 声明：

```typescript
import type { StreamClient } from './stream-client.js'

export class ApiClient implements StreamClient {
```

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 5：Commit**

```bash
git add src/api/stream-client.ts src/api/client.ts
git commit -m "feat(api): add StreamClient interface, ApiClient implements it"
```

---

## 任务 2：Config Schema 扩展

**文件：**
- 修改：`src/config/schema.ts`
- 修改：`src/config/default.ts`

- [ ] **步骤 1：扩展 providerSchema**

在 `src/config/schema.ts` 中修改 `providerSchema`，在 `baseUrl` 之后添加：

```typescript
export const providerCapabilitiesSchema = z.object({
  cacheControl: z.boolean().default(false),
  stripParams: z.array(z.string()).default([]),
  toolJsonBug: z.boolean().default(false),
  prefixCache: z.enum(['deepseek-native', 'anthropic-cache-control', 'none']).default('none'),
}).default({})

export const providerSchema = z.object({
  name: z.string(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url(),
  protocol: z.enum(['anthropic', 'openai']).default('anthropic'),
  models: z.array(modelConfigSchema).min(1),
  thinking: z.enum(['enabled', 'disabled']).default('enabled'),
  maxTokens: z.number().int().positive().default(64000),
  unsupported: z.array(z.string()).default([]),
  capabilities: providerCapabilitiesSchema,
  fallback: z.array(z.string()).default([]),
})
```

- [ ] **步骤 2：更新默认配置**

在 `src/config/default.ts` 中，给默认 deepseek provider 添加 `protocol: 'anthropic'`。不需要添加 `capabilities`（schema default 会处理）。

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误（可能有类型推断变化需要修复）

- [ ] **步骤 4：运行测试**

运行：`npm test`
预期：全部通过（schema 变更向后兼容，所有新字段有 default）

- [ ] **步骤 5：Commit**

```bash
git add src/config/schema.ts src/config/default.ts
git commit -m "feat(config): add protocol, capabilities, fallback fields to provider schema"
```

---

## 任务 3：ProviderCapabilities 扩展 + resolveCapabilities

**文件：**
- 修改：`src/api/provider.ts`

- [ ] **步骤 1：扩展 ProviderCapabilities 接口**

在 `src/api/provider.ts` 中，给 `ProviderCapabilities` 接口添加：

```typescript
export interface ProviderCapabilities {
  supportsThinking: boolean
  thinkingFormat: 'anthropic' | 'openai' | 'none'
  supportsCacheControl: boolean
  stripParams: string[]
  hasToolJsonInContentBug: boolean
  effortFormat: 'reasoning_effort' | 'output_config' | 'none'
  mapUsage?: (raw: Record<string, unknown>) => Partial<Usage>
  prefixCacheStrategy: 'deepseek-native' | 'anthropic-cache-control' | 'none'  // NEW
  protocol: 'anthropic' | 'openai'  // NEW
}
```

更新 `DEEPSEEK_CAPABILITIES` 和 `DEFAULT_CAPABILITIES` 添加新字段。

- [ ] **步骤 2：添加 WELL_KNOWN_DEFAULTS**

在 `src/api/provider.ts` 末尾添加：

```typescript
import type { Usage } from './types.js'

export function mapDeepSeekUsage(raw: Record<string, unknown>): Partial<Usage> {
  return {
    input_tokens: (raw.prompt_tokens ?? raw.input_tokens ?? 0) as number,
    output_tokens: (raw.completion_tokens ?? raw.output_tokens ?? 0) as number,
    cache_read_input_tokens: (raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? 0) as number,
    cache_creation_input_tokens: (raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0) as number,
  }
}

const WELL_KNOWN_DEFAULTS: Record<string, Partial<ProviderCapabilities>> = {
  deepseek: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    hasToolJsonInContentBug: true,
    effortFormat: 'reasoning_effort',
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    prefixCacheStrategy: 'deepseek-native',
    protocol: 'anthropic',
    mapUsage: mapDeepSeekUsage,
  },
  kimi: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    stripParams: ['top_k', 'metadata'],
    prefixCacheStrategy: 'none',
    protocol: 'anthropic',
  },
  glm: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    stripParams: ['top_k', 'metadata', 'service_tier'],
    prefixCacheStrategy: 'none',
    protocol: 'anthropic',
  },
  minimax: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    stripParams: ['top_k', 'metadata'],
    prefixCacheStrategy: 'none',
    protocol: 'anthropic',
  },
  mimo: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    stripParams: ['top_k', 'metadata'],
    prefixCacheStrategy: 'none',
    protocol: 'anthropic',
  },
  openai: {
    supportsThinking: false,
    thinkingFormat: 'none',
    supportsCacheControl: false,
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    stripParams: [],
    prefixCacheStrategy: 'none',
    protocol: 'openai',
  },
}
```

- [ ] **步骤 3：添加 resolveCapabilities 函数**

```typescript
import type { ProviderConfig } from '../config/schema.js'

export function resolveCapabilities(providerConfig: ProviderConfig): ProviderCapabilities {
  const wellKnown = WELL_KNOWN_DEFAULTS[providerConfig.name] ?? {}
  const configCaps = providerConfig.capabilities ?? {}

  return {
    ...DEFAULT_CAPABILITIES,
    ...wellKnown,
    supportsCacheControl: configCaps.cacheControl ?? (wellKnown.supportsCacheControl ?? false),
    stripParams: configCaps.stripParams.length > 0 ? configCaps.stripParams : (wellKnown.stripParams ?? []),
    hasToolJsonInContentBug: configCaps.toolJsonBug ?? (wellKnown.hasToolJsonInContentBug ?? false),
    prefixCacheStrategy: configCaps.prefixCache ?? (wellKnown.prefixCacheStrategy ?? 'none'),
    protocol: providerConfig.protocol ?? (wellKnown.protocol ?? 'anthropic'),
  }
}
```

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 5：Commit**

```bash
git add src/api/provider.ts
git commit -m "feat(api): add WELL_KNOWN_DEFAULTS + resolveCapabilities + mapDeepSeekUsage migration"
```

---

## 任务 4：Provider Factory

**文件：**
- 创建：`src/api/factory.ts`
- 创建：`src/api/__tests__/factory.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/api/__tests__/factory.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProviderClient } from '../factory.js'
import { ApiClient } from '../client.js'

describe('createProviderClient', () => {
  it('creates ApiClient for anthropic protocol', () => {
    const client = createProviderClient({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      protocol: 'anthropic',
      models: [{ id: 'deepseek-reasoner', contextWindow: 128000, maxTokens: 64000 }],
      thinking: 'enabled',
      maxTokens: 64000,
      unsupported: [],
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' },
      fallback: [],
    })

    assert.ok(client instanceof ApiClient)
  })

  it('resolves API key from environment variable', () => {
    process.env.TEST_PROVIDER_KEY = 'test-key-123'
    try {
      const client = createProviderClient({
        name: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/',
        apiKeyEnv: 'TEST_PROVIDER_KEY',
        protocol: 'anthropic',
        models: [{ id: 'kimi-k2', contextWindow: 128000, maxTokens: 64000 }],
        thinking: 'enabled',
        maxTokens: 64000,
        unsupported: [],
        capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' },
        fallback: [],
      })

      assert.ok(client instanceof ApiClient)
    } finally {
      delete process.env.TEST_PROVIDER_KEY
    }
  })

  it('uses well-known defaults for known providers', () => {
    const client = createProviderClient({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test',
      protocol: 'anthropic',
      models: [{ id: 'deepseek-reasoner', contextWindow: 128000, maxTokens: 64000 }],
      thinking: 'enabled',
      maxTokens: 64000,
      unsupported: [],
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' },
      fallback: [],
    })

    assert.ok(client instanceof ApiClient)
  })

  it('throws for openai protocol (not yet implemented)', () => {
    assert.throws(() => {
      createProviderClient({
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        protocol: 'openai',
        models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 }],
        thinking: 'disabled',
        maxTokens: 16384,
        unsupported: [],
        capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' },
        fallback: [],
      })
    }, /OpenAI protocol not yet supported/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/api/__tests__/factory.test.ts`
预期：FAIL（`factory.ts` 不存在）

- [ ] **步骤 3：实现 factory**

创建 `src/api/factory.ts`：

```typescript
import { ApiClient } from './client.js'
import type { StreamClient } from './stream-client.js'
import type { ProviderConfig } from '../config/schema.js'
import { resolveCapabilities } from './provider.js'

export function createProviderClient(providerConfig: ProviderConfig): StreamClient {
  const caps = resolveCapabilities(providerConfig)

  if (caps.protocol === 'openai') {
    throw new Error('OpenAI protocol not yet supported. Coming in Phase 2.')
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

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/api/__tests__/factory.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/api/factory.ts src/api/__tests__/factory.test.ts
git commit -m "feat(api): add createProviderClient factory with well-known defaults"
```

---

## 任务 5：Callsite 迁移

**文件：**
- 修改：`src/main.tsx`
- 修改：`src/agent/create-agent-config.ts`

- [ ] **步骤 1：读取当前 callsite**

读取 `src/main.tsx` 和 `src/agent/create-agent-config.ts`，找到所有 `createDeepSeekClient` 调用。记录每个调用的参数，理解它们如何获取 apiKey、model、maxTokens 等。

- [ ] **步骤 2：迁移 main.tsx**

将 `src/main.tsx` 中的：
```typescript
import { createDeepSeekClient } from './api/deepseek.js'
```
替换为：
```typescript
import { createProviderClient } from './api/factory.js'
```

将每个 `createDeepSeekClient({...})` 调用替换为 `createProviderClient(activeProvider)`，其中 `activeProvider` 是从 config 中解析出的当前 provider 配置：

```typescript
const activeProvider = config.provider.providers[config.provider.default]
```

注意：`createDeepSeekClient` 接受 `{ apiKey, model, maxTokens, ... }`，而 `createProviderClient` 接受完整的 `ProviderConfig`。需要确保 `activeProvider` 包含正确的 model 选择（可能需要根据上下文选择不同 model，如 compact 用 flash model）。

对于 compact client（如果使用不同 model），需要构造一个临时 ProviderConfig 覆盖 model：

```typescript
const compactProvider = { ...activeProvider, models: [compactModel] }
const compactClient = createProviderClient(compactProvider)
```

- [ ] **步骤 3：迁移 create-agent-config.ts**

同样替换 `src/agent/create-agent-config.ts` 中的 2 个 callsite。这里的 client 创建逻辑应该接受 `ProviderConfig` 参数而非自己构造。

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 5：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 6：验证无残留引用**

运行：`grep -rn "createDeepSeekClient" src/ --include="*.ts" --include="*.tsx"`
预期：零结果（测试文件中的引用也应迁移或删除）

- [ ] **步骤 7：Commit**

```bash
git add src/main.tsx src/agent/create-agent-config.ts
git commit -m "refactor(api): migrate all callsites from createDeepSeekClient to createProviderClient"
```

---

## 任务 6：删除 deepseek.ts

**文件：**
- 删除：`src/api/deepseek.ts`
- 修改：任何仍引用 `deepseek.ts` 的文件

- [ ] **步骤 1：确认 mapDeepSeekUsage 已迁移**

确认 `src/api/provider.ts` 中已有 `mapDeepSeekUsage` 函数（任务 3 步骤 2 中迁移）。

- [ ] **步骤 2：查找残留引用**

运行：`grep -rn "from.*deepseek" src/ --include="*.ts" --include="*.tsx"`
修复所有引用，改为从 `provider.ts` 或 `factory.ts` 导入。

- [ ] **步骤 3：删除文件**

```bash
git rm src/api/deepseek.ts
```

- [ ] **步骤 4：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "refactor(api): remove deepseek.ts, logic merged into provider.ts + factory.ts"
```

---

## 任务 7：集成验证

**文件：** 无新文件

- [ ] **步骤 1：运行完整测试套件**

运行：`npm test`
预期：890+ pass, 0 fail

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：验证 config 向后兼容**

确认现有 `config.json`（无 `protocol` 字段）仍然正常工作。Zod schema 的 `.default('anthropic')` 应该处理缺失字段。

- [ ] **步骤 4：验证 well-known defaults 生效**

在测试中验证：配置 `name: 'deepseek'` 的 provider 自动获得 `hasToolJsonInContentBug: true` 和 `mapDeepSeekUsage`。

- [ ] **步骤 5：手动验证（如有 API key）**

如果有 Kimi API key，在 config.json 中添加 kimi provider 配置，运行 rivet 发送一条消息验证响应正常。

- [ ] **步骤 6：最终 Commit（如有修复）**

```bash
git add -A
git commit -m "fix(api): integration fixes for multi-provider Phase 1"
```

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| main.tsx 中 model 选择逻辑复杂（不同场景用不同 model） | 仔细读取现有逻辑，factory 接受完整 ProviderConfig，model 选择在调用方完成 |
| 测试中直接 import deepseek.ts | 迁移测试引用到 factory.ts |
| config.json 向后兼容 | 所有新字段有 Zod default，旧 config 自动补全 |
| resolveCapabilities 的 config 覆盖逻辑 | 单元测试覆盖：config 值优先于 well-known default |
| create-agent-config.ts 的 compact client 用不同 model | 构造临时 ProviderConfig 覆盖 models 字段 |

---

## 任务复杂度评估（作为 Rivet 长链路测试样本）

| 维度 | 评分 | 说明 |
|------|------|------|
| 文件跨度 | ★★★☆ | 8+ 文件修改/创建/删除 |
| 架构理解 | ★★★★ | 需要理解 ApiClient、config、provider 三层关系 |
| 接口设计 | ★★★☆ | StreamClient 接口 + factory pattern |
| 迁移风险 | ★★★☆ | 6 个 callsite 各有不同参数模式 |
| 测试覆盖 | ★★☆☆ | 主要是 factory 单元测试 + 集成验证 |
| 链路长度 | ★★★★ | 7 个任务，每个 4-6 步，总计 ~35 步 |
| 判断力要求 | ★★★☆ | callsite 迁移需要理解上下文决定参数映射 |

**适合测试的能力维度：**
1. 多文件协调修改（不能只改一个文件就 commit）
2. 接口提取 + 实现（从现有代码中提取抽象）
3. 安全删除（确认所有引用迁移后才删除）
4. 向后兼容（新 schema 不破坏旧 config）
5. 长链路记忆（任务 3 的 mapDeepSeekUsage 迁移在任务 6 中被验证）
