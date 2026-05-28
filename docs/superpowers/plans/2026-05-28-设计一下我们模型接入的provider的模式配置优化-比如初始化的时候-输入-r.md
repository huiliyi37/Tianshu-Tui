# Provider 配置模式优化 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `rivet config` 成为可交互、可脚本化的 provider 配置入口，内置 DeepSeek、GLM、MiMo、MiniMax、Codex 预设，并支持 API key、base URL、模型名与模型参数的重写和更新。

**架构：** 将 provider 默认值从散落的 `DEFAULT_CONFIG` 与 API capability 表中抽成 `provider-presets` 目录内的单一预设目录，`DEFAULT_CONFIG` 只消费预设，CLI 与交互向导也复用同一数据源。配置写入仍走现有 `loadConfig()` 深合并与 `configSchema` 校验链路，新增的 mutation 函数只做小颗粒更新，避免绕过现有原子写入和 schema 默认值。

**技术栈：** TypeScript strict、Zod、Node.js `node:readline/promises`、`node:test` + `node:assert/strict`、现有 `writeFileAtomicSync`

---

## 1. Scope check

### 本计划覆盖

1. `rivet config` 无子命令时：TTY 环境进入 provider 配置向导；非 TTY 环境打印帮助并正常退出，避免 CI 或 pipe 场景挂起。
2. 内置 provider 预设：`deepseek`、`glm`、`mimo`、`minimax`、`codex`。每个预设包含 `baseUrl`、认证方式、capabilities、默认模型、context window、max tokens、reasoning effort。
3. Provider 配置更新命令：
   - `rivet config setup <provider> [flags]`：按预设创建或更新 provider。
   - `rivet config set-url <provider> <base-url>`：重写 base URL。
   - `rivet config set-model <provider> <model-id> [context-window] [max-tokens] [alias]`：新增或替换模型，并将该模型置为 provider 首选模型。
   - 现有 `set-key`、`set-key-env`、`set-default` 保持可用。
4. `codex` OAuth provider 默认配置：加入默认配置、provider registry、capability defaults；不要求启动时完成 OAuth，只保证被选中时走现有 `createAuthProvider` / `CodexClient` 流程。
5. README、CLI help、onboarding 文案更新，明确推荐 `rivet config` 和脚本化命令。

### 不在本计划内，建议拆成独立计划

1. TUI `/model provider/model` 解析修复：README 已声明 `/model minimax/MiniMax-M2.7`，但当前 `handleModelSwitch()` 只按 model id/alias 全局搜索。这个问题属于运行时 model switching，不属于 provider 持久化配置；另开「TUI provider-qualified model switch」计划。
2. Provider 健康度与 worker 路由策略调优：本计划只让配置更容易写对，不改变 `DelegationCoordinator` 的评分算法。
3. 新协议接入：本计划复用现有 OpenAI-compatible 与 Codex Responses 客户端，不引入新的协议客户端。

## 2. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/config/provider-presets.ts` | 创建 | DeepSeek、GLM、MiMo、MiniMax、Codex provider 预设目录与 clone/lookup 工具函数 |
| `src/config/provider-wizard.ts` | 创建 | `rivet config` TTY 交互向导，收集 provider、key/url/model/default 选择并调用 manager mutation 函数 |
| `src/config/__tests__/provider-presets.test.ts` | 创建 | 校验预设可被 `providerSchema` 解析、必需 provider 存在、Codex OAuth 预设正确 |
| `src/config/__tests__/manager-provider.test.ts` | 创建 | 使用隔离 `RIVET_CONFIG_PATH` 验证 set-url、set-model、setup、API key/env 写入互斥 |
| `src/config/__tests__/config-cli.test.ts` | 创建 | 捕获 stdout/stderr/exit，验证 CLI 命令、非 TTY 帮助、TTY 向导入口 |
| `src/config/__tests__/provider-wizard.test.ts` | 创建 | 使用脚本化问答验证交互向导配置 API key provider 与 Codex provider |
| `src/config/default.ts:1-237` | 修改 | 复用 provider 预设构建默认配置，加入 Codex 默认 provider 与 worker 可选 profile |
| `src/config/manager.ts:1-386` | 修改 | 增加可测试的 config path 覆盖、provider setup/update mutation 函数、异步 `runConfigCLI` 与新命令 |
| `src/config/schema.ts:1-122` | 修改 | 如实现中需要显式导出 helper 类型，仅做类型导出；不放宽现有 schema 约束 |
| `src/api/provider.ts:66-133` | 修改 | `WELL_KNOWN_DEFAULTS` 增加 `codex` capability defaults |
| `src/api/provider-registry.ts:72-111` | 修改 | `PROVIDER_REGISTRY` 增加 Codex entry，registry 测试可发现 Codex |
| `src/api/__tests__/provider-registry.test.ts:56-88` | 修改 | 增加 Codex registry/cache/profile 断言 |
| `src/config/__tests__/schema.test.ts:35-82` | 修改 | 增加默认配置包含 required provider、Codex OAuth、worker profile 不指向缺失 provider 的断言 |
| `src/main.tsx:43, 618-708` | 修改 | `runConfigCLI` 改为 `await`，CLI help 展示新 provider 配置命令 |
| `src/tui/onboarding.tsx:4-49` | 修改 | onboarding 文案从只提示 `set-key` 改为推荐 `rivet config` 向导，同时保留脚本命令示例 |
| `README.md:383-548` | 修改 | 更新 CLI 配置、provider 表、Codex、API key provider、命令示例 |

## 3. Research endorsement（调研背书）

### `src/config/manager.ts` 现状与变更理由

- `loadConfig(options)` 位于 `src/config/manager.ts:55-91`，存在原因是四层配置合并：`DEFAULT_CONFIG` → `~/.rivet/config.json` → project `.rivet-config.json` → session overlay，并在返回前走 `configSchema.parse()`。本计划不改变合并优先级；只增加 `RIVET_CONFIG_PATH` 覆盖，使测试和脚本可隔离用户真实配置。
- `CONFIG_PATH` 当前是模块加载时常量（`src/config/manager.ts:8`），`loadConfig()` 与 `saveConfig()` 在 `src/config/manager.ts:64-99` 直接读写它。边缘风险：测试 provider mutation 会写真实 `~/.rivet/config.json`。变更方式是新增 `getUserConfigPath()` 并让 read/write 每次调用取路径；未设置 `RIVET_CONFIG_PATH` 时行为保持原样。
- `runConfigCLI(args)` 位于 `src/config/manager.ts:195-386`，调用者通过 grep 确认为 `src/main.tsx:707` 一处。存在原因是集中处理 `rivet config` 子命令并在参数错误时 `process.exit(1)`。本计划将其改为 `async` 并增加可注入 IO/exit 依赖，原因是交互向导需要 await，同时测试不能直接退出进程。边缘风险：`main()` 必须 `await runConfigCLI(args.slice(1))` 后 return；现有命令的 stdout 文案和 exit code 必须保持。
- 现有 API key 函数：`setApiKey()` 在 `src/config/manager.ts:142-149` 写 inline key 并清空 `apiKeyEnv`；`setApiKeyEnv()` 在 `src/config/manager.ts:151-158` 写 env var 并清空 `apiKey`。存在原因是避免同一 provider 同时有两种 key 来源。本计划复用该互斥语义；CLI/wizard 输出只显示 masked inline key，不能回显完整 secret。
- 现有 model 函数：`addModel()` 在 `src/config/manager.ts:170-176` 只 append，`removeModel()` 在 `src/config/manager.ts:178-185` 保证 provider 至少保留一个 model。存在原因是允许扩展模型列表并防止 provider 变成 schema-invalid。本计划不改变 `add-model`/`remove-model` 行为；新增 `upsertProviderModel()` 给 `set-model` 和 wizard 使用，用 id 或 alias 匹配替换，并在 `preferred: true` 时移动到 models[0]。

### `src/config/default.ts`、schema 与 provider 预设

- `DEFAULT_CONFIG.provider.providers` 当前在 `src/config/default.ts:7-179` 内联 DeepSeek、Kimi、GLM、Claude、MiMo、MiniMax；`workers.profiles` 在 `src/config/default.ts:212-218` 引用 deepseek/minimax/mimo。存在原因是无用户配置时仍能启动并展示 provider 列表。问题是 CLI setup、docs、默认配置各自维护 provider 默认值，容易漂移。本计划抽取 `provider-presets.ts`，`DEFAULT_CONFIG` 通过 clone 复用预设，减少重复。
- `providerSchema` 在 `src/config/schema.ts:22-39` 要求 `baseUrl` 是 URL、`models` 至少一个、`protocol` 当前只支持 `openai`，`auth` 支持 `{ type: 'oauth', provider: 'codex' }`。本计划不放宽 schema；Codex 预设必须满足现有 schema。
- `configSchema` 在 `src/config/schema.ts:100-108` 没有校验 default provider 是否存在。现有 integration test 在 `src/config/__tests__/config-schema-integration.test.ts:11-18` 对真实用户配置做了该断言。本计划在 schema/default 测试中补足 DEFAULT_CONFIG 层面的 default/provider 一致性检查，但不把 cross-field 校验塞进 Zod，避免破坏 deep-merge 中间层兼容性。

### API provider capability 与 Codex

- `createProviderClient()` 在 `src/api/factory.ts:43-76` 已经特殊处理 `provider.name === 'codex' && provider.auth?.type === 'oauth'`，返回 `CodexClient`；其他 provider 返回 `OpenAIClient`。本计划不改工厂分支，只让默认配置和 registry 能提供 codex provider。
- `resolveApiKey()` 在 `src/api/factory.ts:24-38` 对非 OAuth provider 解析 inline key 或 env var，缺失时报错。本计划不让 Codex 走 `resolveApiKey()`；`main.tsx:890-914` 已按 `provider.auth?.type === 'oauth'` 分流。
- `WELL_KNOWN_DEFAULTS` 在 `src/api/provider.ts:66-133` 没有 codex。存在原因是最初多 provider capability 只覆盖 OpenAI-compatible API key provider。风险：`provider-registry.ts` 用 `WELL_KNOWN_DEFAULTS[...]!` 构建 registry，加入 Codex registry 前必须先补 Codex capability defaults。
- `provider-profile.ts:14-27` 已有 `codex` cache profile，说明系统已把 Codex 当作 partial-prefix cache provider 处理。本计划新增 registry entry 时沿用该 profile，不改变 cache advisor 行为。

### `src/main.tsx` 启动与帮助

- CLI routing 在 `src/main.tsx:618-708` 读取 `process.argv`，`args[0] === 'config'` 时调用 `runConfigCLI(args.slice(1))` 并 return。变更为 `await runConfigCLI(...)` 是交互向导的必要行为变更；调用者只有这一处。
- 启动 provider 选择在 `src/main.tsx:866-924`，`--provider` 和 `--model` 只读取已加载 config，不写 config。存在原因是运行时 session overlay 与持久配置分离。本计划不改变 runtime 参数解析，避免把配置向导与会话启动耦合。
- TUI model switch 数据在 `src/main.tsx:530-599` 传入 `App`，`src/tui/slash-commands.ts:220-243` 列表/切换模型。发现 README 提供 `/model provider/model` 示例，但当前实现没有解析 provider 前缀。该问题独立于 `rivet config`，本计划只在 README 配置章节避免新增误导性示例；完整修复拆分。

## 4. Tasks

### 任务 1：抽取 provider 预设并补齐 Codex registry

- [ ] 创建：`src/config/provider-presets.ts`
- [ ] 创建：`src/config/__tests__/provider-presets.test.ts`
- [ ] 修改：`src/config/default.ts:1-179`
- [ ] 修改：`src/api/provider.ts:66-133`
- [ ] 修改：`src/api/provider-registry.ts:72-111`
- [ ] 修改：`src/api/__tests__/provider-registry.test.ts:56-88`
- [ ] 修改：`src/config/__tests__/schema.test.ts:35-82`
- [ ] 测试：`src/config/__tests__/provider-presets.test.ts`
- [ ] 测试：`src/api/__tests__/provider-registry.test.ts`
- [ ] 测试：`src/config/__tests__/schema.test.ts`

**目标：** 建立 provider 配置单一预设源，并让 DEFAULT_CONFIG、Codex registry、schema 测试全部使用同一套 provider 事实。

**调研背书：**
- `DEFAULT_CONFIG`: 当前内联 provider 重复维护，`configSchema.parse(DEFAULT_CONFIG)` 已由 `src/config/__tests__/schema.test.ts:16-21` 覆盖。抽取后必须保持 parse 成功。
- `WELL_KNOWN_DEFAULTS`: `provider-registry.ts:72-111` 使用非空断言读取 well-known defaults；新增 `codex` registry 前必须先新增 `WELL_KNOWN_DEFAULTS.codex`，否则模块初始化会抛错。
- `provider-profile.ts`: 已有 `codex` profile，不需要新增 cache profile；新增 registry entry 应被现有 `getProviderProfile('codex')` 识别。

**TDD 步骤：**

- [ ] 写失败测试：在 `src/config/__tests__/provider-presets.test.ts` 写入以下测试骨架并运行，预期因模块不存在失败。

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema } from '../schema.js'
import { PROVIDER_PRESETS, cloneProviderPreset, providerPresetKeys } from '../provider-presets.js'

describe('provider presets', () => {
  it('contains required built-in provider modes', () => {
    assert.deepEqual(providerPresetKeys.sort(), ['codex', 'deepseek', 'glm', 'mimo', 'minimax'].sort())
  })

  it('every preset parses as ProviderConfig', () => {
    for (const key of providerPresetKeys) {
      const parsed = providerSchema.safeParse(PROVIDER_PRESETS[key].provider)
      assert.equal(parsed.success, true, `${key} should parse`)
    }
  })

  it('codex preset uses OAuth and gpt-5.5', () => {
    const codex = cloneProviderPreset('codex')
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.models[0]?.id, 'gpt-5.5')
  })
})
```

运行：

```bash
npm exec -- tsx --test src/config/__tests__/provider-presets.test.ts
```

预期：失败，错误包含 `Cannot find module '../provider-presets.js'`。

- [ ] 实现最小代码：创建 `src/config/provider-presets.ts`，定义并导出以下类型与函数。所有 provider object 必须完整满足 `ProviderConfig`，不能只写局部 override。

```typescript
import type { ProviderConfig } from './schema.js'

export type ProviderPresetKey = 'deepseek' | 'glm' | 'mimo' | 'minimax' | 'codex'

export interface ProviderPreset {
  key: ProviderPresetKey
  label: string
  provider: ProviderConfig
  defaultModelId: string
}

export const PROVIDER_PRESETS: Record<ProviderPresetKey, ProviderPreset> = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    defaultModelId: 'deepseek-v4-pro',
    provider: {
      name: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: true, prefixCache: 'deepseek-native', prefixCompletion: true },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [
        { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 163_000, reasoningEffort: 'max' },
        { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000, maxTokens: 163_000, reasoningEffort: 'high' },
      ],
      unsupported: [],
    },
  },
  glm: {
    key: 'glm',
    label: 'GLM',
    defaultModelId: 'glm-5.1',
    provider: {
      name: 'glm',
      apiKeyEnv: 'ZHIPU_API_KEY',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [{ id: 'glm-5.1', alias: 'glm', contextWindow: 200_000, maxTokens: 128000, reasoningEffort: 'high' }],
      unsupported: ['stream_options'],
    },
  },
  mimo: {
    key: 'mimo',
    label: 'MiMo',
    defaultModelId: 'mimo-v2.5-pro',
    provider: {
      name: 'mimo',
      apiKeyEnv: 'MIMO_API_KEY',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'deepseek-native', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [
        { id: 'mimo-v2.5-pro', alias: 'mimo-pro', contextWindow: 1_000_000, maxTokens: 128000 },
        { id: 'mimo-v2.5', alias: 'mimo', contextWindow: 1_000_000, maxTokens: 128000 },
      ],
      unsupported: ['stream_options'],
    },
  },
  minimax: {
    key: 'minimax',
    label: 'MiniMax',
    defaultModelId: 'MiniMax-M2.7',
    provider: {
      name: 'minimax',
      apiKeyEnv: 'MINIMAX_API_KEY',
      baseUrl: 'https://api.minimaxi.com/v1',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [{ id: 'MiniMax-M2.7', alias: 'minimax', contextWindow: 204_800, maxTokens: 64000 }],
      unsupported: [],
    },
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    defaultModelId: 'gpt-5.5',
    provider: {
      name: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai',
      auth: { type: 'oauth', provider: 'codex' },
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 128000,
      models: [{ id: 'gpt-5.5', alias: 'codex', contextWindow: 1_000_000, maxTokens: 128000, reasoningEffort: 'max' }],
      unsupported: [],
    },
  },
}

export const providerPresetKeys = Object.keys(PROVIDER_PRESETS) as ProviderPresetKey[]

export function cloneProviderPreset(key: ProviderPresetKey): ProviderConfig {
  return structuredClone(PROVIDER_PRESETS[key].provider)
}

export function isProviderPresetKey(value: string): value is ProviderPresetKey {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, value)
}
```

- [ ] 修改 `src/config/default.ts:1-179`：导入 `cloneProviderPreset`，将 `deepseek`、`glm`、`mimo`、`minimax` provider object 替换为 `cloneProviderPreset('<key>')`；新增 `codex: cloneProviderPreset('codex')`；保留 `kimi` 与 `claude` 现有内联配置。

- [ ] 修改 `src/api/provider.ts:66-133`：在 `WELL_KNOWN_DEFAULTS` 增加：

```typescript
  codex: {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: true,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
  },
```

- [ ] 修改 `src/api/provider-registry.ts:72-111`：在 `PROVIDER_REGISTRY` 增加：

```typescript
  codex: buildEntry('codex', 'Codex', WELL_KNOWN_DEFAULTS['codex']!, [
    'Uses Codex Responses API with OAuth authentication',
    'Partial-prefix cache profile is provided by provider-profile.ts',
  ]),
```

- [ ] 修改测试：
  - `src/api/__tests__/provider-registry.test.ts:56-66` 的 listProviders 断言增加 `codex`。
  - 增加 `codex has OAuth-compatible registry metadata` 测试，断言 `getProviderEntry('codex')?.cacheProfile.cacheType === 'partial-prefix'`。
  - `src/config/__tests__/schema.test.ts:35-82` 增加断言：`DEFAULT_CONFIG.provider.providers.codex.auth` 等于 `{ type: 'oauth', provider: 'codex' }`，且每个 `workers.profiles[*].provider` 都存在于 `DEFAULT_CONFIG.provider.providers`。

- [ ] 运行验证：

```bash
npm exec -- tsx --test src/config/__tests__/provider-presets.test.ts src/api/__tests__/provider-registry.test.ts src/config/__tests__/schema.test.ts
```

预期：全部通过。

- [ ] 提交：

```bash
git add src/config/provider-presets.ts src/config/__tests__/provider-presets.test.ts src/config/default.ts src/api/provider.ts src/api/provider-registry.ts src/api/__tests__/provider-registry.test.ts src/config/__tests__/schema.test.ts
git commit -m "feat(config): add provider preset catalog"
```

预期：提交成功，不 amend 现有 commit。

### 任务 2：增加可测试的 provider 配置 mutation 函数

- [ ] 修改：`src/config/manager.ts:1-194`
- [ ] 创建：`src/config/__tests__/manager-provider.test.ts`
- [ ] 测试：`src/config/__tests__/manager-provider.test.ts`

**目标：** 在不触碰真实 `~/.rivet/config.json` 的前提下测试 provider 更新能力，并提供 `setupProvider()`、`updateProviderBaseUrl()`、`upsertProviderModel()` 供 CLI 和 wizard 复用。

**调研背书：**
- `CONFIG_PATH` 当前在模块加载时固定，测试 mutation 会污染真实用户配置；新增 `getUserConfigPath()` 的默认返回值与旧路径一致，只有 `RIVET_CONFIG_PATH` 设置时改变。
- 不修改 `addModel()`，避免改变已有脚本对 append 语义的依赖；新增 `upsertProviderModel()` 专门满足“模型名可以重写/更新”。

**TDD 步骤：**

- [ ] 写失败测试：创建 `src/config/__tests__/manager-provider.test.ts`。测试必须在每个 case 设置 `process.env.RIVET_CONFIG_PATH = join(tempDir, 'config.json')`，结束后删除该 env。核心测试代码如下：

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setupProvider, updateProviderBaseUrl, upsertProviderModel, setApiKey, setApiKeyEnv } from '../manager.js'

describe('provider config mutations', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets baseUrl without changing models', () => {
    updateProviderBaseUrl('deepseek', 'https://gateway.example.com/v1')
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.baseUrl, 'https://gateway.example.com/v1')
    assert.equal(provider.models[0]?.id, 'deepseek-v4-pro')
  })

  it('upserts a model and makes it preferred', () => {
    upsertProviderModel('deepseek', { id: 'deepseek-custom', alias: 'custom', contextWindow: 200000, maxTokens: 32000 }, { preferred: true })
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.models[0]?.id, 'deepseek-custom')
    upsertProviderModel('deepseek', { id: 'deepseek-custom', alias: 'custom2', contextWindow: 300000, maxTokens: 64000 }, { preferred: true })
    assert.equal(loadConfig().provider.providers.deepseek!.models.filter(m => m.id === 'deepseek-custom').length, 1)
    assert.equal(loadConfig().provider.providers.deepseek!.models[0]?.alias, 'custom2')
  })

  it('sets apiKey and apiKeyEnv as mutually exclusive sources', () => {
    setApiKey('minimax', 'sk-inline')
    assert.equal(loadConfig().provider.providers.minimax!.apiKeyEnv, undefined)
    setApiKeyEnv('minimax', 'MINIMAX_API_KEY')
    const provider = loadConfig().provider.providers.minimax!
    assert.equal(provider.apiKey, undefined)
    assert.equal(provider.apiKeyEnv, 'MINIMAX_API_KEY')
  })

  it('setupProvider creates codex from preset and makes it default', () => {
    setupProvider({ providerName: 'codex', preset: 'codex', makeDefault: true })
    const config = loadConfig()
    assert.equal(config.provider.default, 'codex')
    assert.deepEqual(config.provider.providers.codex!.auth, { type: 'oauth', provider: 'codex' })
  })
})
```

运行：

```bash
npm exec -- tsx --test src/config/__tests__/manager-provider.test.ts
```

预期：失败，错误包含缺失导出 `setupProvider`、`updateProviderBaseUrl` 或 `upsertProviderModel`。

- [ ] 实现 config path 覆盖：在 `src/config/manager.ts:8-11` 附近替换常量读取方式。

精确编辑：

```typescript
const DEFAULT_CONFIG_PATH = join(homedir(), '.rivet', 'config.json')

export function getUserConfigPath(): string {
  return process.env.RIVET_CONFIG_PATH ?? DEFAULT_CONFIG_PATH
}
```

并将 `existsSync(CONFIG_PATH)`、`readFileSync(CONFIG_PATH, ...)`、`writeFileAtomicSync(CONFIG_PATH, ...)` 替换为局部 `const configPath = getUserConfigPath()` 后使用 `configPath`。

- [ ] 在 `src/config/manager.ts:5` 增加导入：

```typescript
import { cloneProviderPreset, isProviderPresetKey, type ProviderPresetKey } from './provider-presets.js'
```

- [ ] 在 `src/config/manager.ts:116-169` provider/API key 区域后增加类型与函数：

```typescript
export interface UpsertProviderModelOptions {
  preferred?: boolean
}

export interface SetupProviderOptions {
  providerName: string
  preset?: ProviderPresetKey
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  model?: ModelConfig
  makeDefault?: boolean
}

function assertValidUrl(value: string): void {
  try { new URL(value) } catch { throw new Error(`Invalid provider baseUrl: ${value}`) }
}

export function updateProviderBaseUrl(providerName: string, baseUrl: string): void {
  assertValidUrl(baseUrl)
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.baseUrl = baseUrl
  saveConfig(cfg)
}

export function upsertProviderModel(providerName: string, model: ModelConfig, options: UpsertProviderModelOptions = {}): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  const existingIndex = provider.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
  if (existingIndex >= 0) provider.models[existingIndex] = model
  else provider.models.push(model)
  if (options.preferred) {
    const preferredIndex = provider.models.findIndex(item => item.id === model.id)
    const preferred = provider.models.splice(preferredIndex, 1)[0]
    if (preferred) provider.models.unshift(preferred)
  }
  saveConfig(cfg)
}

export function setupProvider(options: SetupProviderOptions): void {
  const cfg = loadConfig()
  const presetKey = options.preset ?? (isProviderPresetKey(options.providerName) ? options.providerName : undefined)
  const current = cfg.provider.providers[options.providerName]
  const base = presetKey ? cloneProviderPreset(presetKey) : current
  if (!base) throw new Error(`Provider "${options.providerName}" not found and no preset is available`)
  const next: ProviderConfig = { ...base, name: options.providerName }
  if (current) Object.assign(next, current)
  if (options.baseUrl) {
    assertValidUrl(options.baseUrl)
    next.baseUrl = options.baseUrl
  }
  if (options.apiKey) {
    next.apiKey = options.apiKey
    next.apiKeyEnv = undefined
  }
  if (options.apiKeyEnv) {
    next.apiKeyEnv = options.apiKeyEnv
    next.apiKey = undefined
  }
  if (options.model) {
    const existingIndex = next.models.findIndex(item => item.id === options.model!.id || (options.model!.alias !== undefined && item.alias === options.model!.alias))
    if (existingIndex >= 0) next.models[existingIndex] = options.model
    else next.models.unshift(options.model)
  }
  cfg.provider.providers[options.providerName] = next
  if (options.makeDefault) cfg.provider.default = options.providerName
  saveConfig(cfg)
}
```

- [ ] 保证 `saveConfig()` 仍通过 `writeFileAtomicSync()` 写入格式化 JSON，并确保父目录创建由现有 `writeFileAtomicSync` 处理；若 `writeFileAtomicSync` 不创建父目录，先读 `src/fs-atomic.ts`，然后在本任务中增加目录创建测试和实现。

- [ ] 运行验证：

```bash
npm exec -- tsx --test src/config/__tests__/manager-provider.test.ts src/config/__tests__/layered-config.test.ts
```

预期：全部通过；`layered-config` 证明默认路径行为未破坏。

- [ ] 提交：

```bash
git add src/config/manager.ts src/config/__tests__/manager-provider.test.ts
git commit -m "feat(config): add provider update primitives"
```

预期：提交成功。

### 任务 3：实现脚本化 provider CLI 命令

- [ ] 修改：`src/config/manager.ts:195-386`
- [ ] 创建：`src/config/__tests__/config-cli.test.ts`
- [ ] 修改：`src/main.tsx:43, 618-708`
- [ ] 测试：`src/config/__tests__/config-cli.test.ts`

**目标：** 让 CI、文档和用户能通过非交互命令创建/更新 provider，且测试可捕获输出与 exit code。

**调研背书：**
- `runConfigCLI` 只有 `src/main.tsx:707` 一个调用者；改为 async 后只需 main `await`。
- 现有错误路径直接 `process.exit(1)`；注入 `exit(code)` 后测试可断言 code，默认实现仍调用 `process.exit(code)`。
- `providers` 当前显示 baseUrl、key status、models；新增 auth 与 preset 信息不应删除原有字段，避免用户丢失可见信息。

**TDD 步骤：**

- [ ] 写失败测试：创建 `src/config/__tests__/config-cli.test.ts`，包含以下测试：

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, runConfigCLI } from '../manager.js'

function makeIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  return {
    stdout,
    stderr,
    exits,
    io: {
      isTTY: false,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      exit: (code: number) => exits.push(code),
    },
  }
}

describe('runConfigCLI provider commands', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints help instead of prompting when config has no args in non-TTY', async () => {
    const { stdout, exits, io } = makeIo()
    await runConfigCLI([], io)
    assert.equal(exits.length, 0)
    assert.match(stdout.join('\n'), /Usage: rivet config <command>/)
    assert.match(stdout.join('\n'), /setup <provider>/)
  })

  it('setup updates provider url, env key, model, and default', async () => {
    const { io } = makeIo()
    await runConfigCLI(['setup', 'minimax', '--key-env', 'MY_MINIMAX_KEY', '--url', 'https://proxy.example.com/v1', '--model', 'MiniMax-M2.8', '--alias', 'm28', '--context-window', '300000', '--max-tokens', '64000', '--default'], io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    assert.equal(provider.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'MiniMax-M2.8')
    assert.equal(provider.models[0]?.alias, 'm28')
  })

  it('set-url and set-model update existing provider', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-url', 'deepseek', 'https://deepseek-proxy.example.com/v1'], io)
    await runConfigCLI(['set-model', 'deepseek', 'deepseek-custom', '500000', '32000', 'custom'], io)
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.baseUrl, 'https://deepseek-proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'deepseek-custom')
    assert.equal(provider.models[0]?.alias, 'custom')
  })

  it('rejects invalid numeric model parameters', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-model', 'deepseek', 'bad-model', 'not-a-number', '32000'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /context-window must be a positive integer/)
  })
})
```

运行：

```bash
npm exec -- tsx --test src/config/__tests__/config-cli.test.ts
```

预期：失败，错误包含 `runConfigCLI` 参数签名或新命令缺失。

- [ ] 修改 `src/config/manager.ts`：在 CLI section 前增加类型与默认 IO：

```typescript
export interface ConfigCliIO {
  isTTY?: boolean
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  exit?: (code: number) => void
}

function cliOut(io: ConfigCliIO, line: string): void { (io.stdout ?? console.log)(line) }
function cliErr(io: ConfigCliIO, line: string): void { (io.stderr ?? console.error)(line) }
function cliExit(io: ConfigCliIO, code: number): void { (io.exit ?? process.exit)(code) }
```

- [ ] 将 `export function runConfigCLI(args: string[]): void` 改为：

```typescript
export async function runConfigCLI(args: string[], io: ConfigCliIO = {}): Promise<void> {
```

将函数内部所有 `console.log`、`console.error`、`process.exit(1)` 替换为 `cliOut(io, ...)`、`cliErr(io, ...)`、`cliExit(io, 1); return`。默认行为仍写 console 并退出。

- [ ] 增加 CLI 参数解析 helper，放在 `runConfigCLI` 前：

```typescript
function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}
```

- [ ] 在 `runConfigCLI` switch 中增加命令：

```typescript
case 'setup': {
  const providerName = args[1]
  if (!providerName) { cliErr(io, 'Usage: rivet config setup <provider> [--key KEY|--key-env ENV] [--url URL] [--model ID --context-window N --max-tokens N] [--alias NAME] [--default]'); cliExit(io, 1); return }
  const modelId = readFlag(args, '--model')
  const model = modelId ? {
    id: modelId,
    alias: readFlag(args, '--alias'),
    contextWindow: parsePositiveInt(readFlag(args, '--context-window') ?? '128000', 'context-window'),
    maxTokens: parsePositiveInt(readFlag(args, '--max-tokens') ?? '64000', 'max-tokens'),
  } : undefined
  setupProvider({
    providerName,
    apiKey: readFlag(args, '--key'),
    apiKeyEnv: readFlag(args, '--key-env'),
    baseUrl: readFlag(args, '--url'),
    model,
    makeDefault: hasFlag(args, '--default'),
  })
  cliOut(io, `Provider ${providerName} configured${hasFlag(args, '--default') ? ' and set as default' : ''}`)
  break
}

case 'set-url': {
  const providerName = args[1]
  const baseUrl = args[2]
  if (!providerName || !baseUrl) { cliErr(io, 'Usage: rivet config set-url <provider> <base-url>'); cliExit(io, 1); return }
  updateProviderBaseUrl(providerName, baseUrl)
  cliOut(io, `Base URL set for ${providerName}: ${baseUrl}`)
  break
}

case 'set-model': {
  const providerName = args[1]
  const modelId = args[2]
  if (!providerName || !modelId) { cliErr(io, 'Usage: rivet config set-model <provider> <model-id> [context-window] [max-tokens] [alias]'); cliExit(io, 1); return }
  const model: ModelConfig = {
    id: modelId,
    contextWindow: parsePositiveInt(args[3] ?? '128000', 'context-window'),
    maxTokens: parsePositiveInt(args[4] ?? '64000', 'max-tokens'),
    alias: args[5],
  }
  upsertProviderModel(providerName, model, { preferred: true })
  cliOut(io, `Preferred model for ${providerName} set to ${modelId}`)
  break
}
```

- [ ] Update help text in `runConfigCLI` default block to include `setup`, `set-url`, `set-model`, and examples for DeepSeek, GLM, MiMo, MiniMax, Codex.

- [ ] 修改 `src/main.tsx:43` import 保持同源；修改 `src/main.tsx:707` 为：

```typescript
    await runConfigCLI(args.slice(1))
```

- [ ] 运行验证：

```bash
npm exec -- tsx --test src/config/__tests__/config-cli.test.ts src/config/__tests__/manager-provider.test.ts
npx tsc --noEmit
```

预期：测试全部通过，typecheck 通过。

- [ ] 提交：

```bash
git add src/config/manager.ts src/config/__tests__/config-cli.test.ts src/main.tsx
git commit -m "feat(config): add scriptable provider setup commands"
```

预期：提交成功。

### 任务 4：实现 `rivet config` TTY provider 配置向导

- [ ] 创建：`src/config/provider-wizard.ts`
- [ ] 创建：`src/config/__tests__/provider-wizard.test.ts`
- [ ] 修改：`src/config/manager.ts:195-386`
- [ ] 修改：`src/config/__tests__/config-cli.test.ts`
- [ ] 测试：`src/config/__tests__/provider-wizard.test.ts`

**目标：** 用户输入 `rivet config` 时进入 provider 配置模式，按提示选择 provider、认证方式、URL、模型与默认 provider；非 TTY 仍显示帮助。

**调研背书：**
- `runConfigCLI([])` 当前走 default help；用户要求无子命令进入 provider 配置。为避免自动化环境挂起，只在 `io.isTTY ?? process.stdin.isTTY` 为 true 时进入向导。
- 交互实现使用 `node:readline/promises`，不新增第三方依赖，符合 package.json 当前依赖形态。

**TDD 步骤：**

- [ ] 写失败测试：创建 `src/config/__tests__/provider-wizard.test.ts`，用脚本化 `ask` 函数驱动向导。

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { runProviderConfigWizard } from '../provider-wizard.js'

function scriptedIo(answers: string[]) {
  const lines: string[] = []
  return {
    lines,
    io: {
      write: (line: string) => lines.push(line),
      ask: async () => answers.shift() ?? '',
    },
  }
}

describe('provider config wizard', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-wizard-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('configures an API-key provider with env auth and custom model', async () => {
    const { io } = scriptedIo(['minimax', 'env', 'MY_MINIMAX_KEY', 'https://proxy.example.com/v1', 'MiniMax-M2.8', 'm28', '300000', '64000', 'yes'])
    await runProviderConfigWizard(io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    assert.equal(provider.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'MiniMax-M2.8')
  })

  it('configures codex without asking for api key', async () => {
    const { lines, io } = scriptedIo(['codex', '', '', '', '', '', 'yes'])
    await runProviderConfigWizard(io)
    const provider = loadConfig().provider.providers.codex!
    assert.deepEqual(provider.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(lines.join('\n').includes('API key'), false)
  })
})
```

运行：

```bash
npm exec -- tsx --test src/config/__tests__/provider-wizard.test.ts
```

预期：失败，错误包含 `Cannot find module '../provider-wizard.js'`。

- [ ] 创建 `src/config/provider-wizard.ts`，定义：

```typescript
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { ModelConfig } from './schema.js'
import { loadConfig, setupProvider } from './manager.js'
import { PROVIDER_PRESETS, isProviderPresetKey, providerPresetKeys } from './provider-presets.js'

export interface ProviderWizardIO {
  ask?: (question: string) => Promise<string>
  write?: (line: string) => void
}
```

实现 `runProviderConfigWizard(io: ProviderWizardIO = {}): Promise<void>`：

1. `write('Rivet provider configuration')`。
2. 展示 `providerPresetKeys` 与当前配置 provider；询问 `Provider [deepseek|minimax|glm|mimo|codex]: `。
3. 如果输入为空，使用当前 `loadConfig().provider.default`；如果是预设 key，调用 `setupProvider({ providerName, preset: providerName })` 的数据路径；如果是已存在 provider，基于当前 provider 更新；其他输入报错 `Provider "x" is not configured and has no built-in preset`。
4. 对非 Codex provider 询问 auth mode：`env`、`inline`、`keep`。`env` 时问 env var 名；`inline` 时问 key；`keep` 或空字符串不改 key source。
5. 询问 base URL，空字符串使用现有或 preset URL。
6. 询问 model id，空字符串使用当前首个 model；若输入新 model，继续询问 alias、context window、max tokens。context window 空值使用当前首个 model 或 preset 首个 model值；max tokens 同理。
7. 询问 `Set as default? [y/N]: `，只有 `y` 或 `yes` 设置 default。
8. 调用 `setupProvider()` 一次完成写入。
9. 输出 `Provider <name> configured. Run "rivet config providers" to inspect.`。
10. 默认 IO 使用 `createInterface({ input, output })`，函数结束时调用 `rl.close()`。

- [ ] 修改 `src/config/manager.ts`：在 `runConfigCLI` 开头处理无子命令。

```typescript
  if (!cmd) {
    const isTTY = io.isTTY ?? process.stdin.isTTY
    if (isTTY) {
      const { runProviderConfigWizard } = await import('./provider-wizard.js')
      await runProviderConfigWizard({ write: line => cliOut(io, line) })
      return
    }
    printConfigHelp(io)
    return
  }
```

为避免 default help 文案重复，提取 `printConfigHelp(io: ConfigCliIO): void`，原 default case 调用该函数。

- [ ] 修改 `src/config/__tests__/config-cli.test.ts`：增加 TTY case，mock `runProviderConfigWizard` 不方便；因此只测试非 TTY 已存在，并在 `provider-wizard.test.ts` 覆盖向导本体。若要覆盖 TTY 分支，使用真实 wizard IO 需要签名允许 `io.wizard`；实现中可以扩展 `ConfigCliIO`：

```typescript
  runWizard?: () => Promise<void>
```

然后 TTY 测试断言 `runWizard` 被调用一次。

- [ ] 运行验证：

```bash
npm exec -- tsx --test src/config/__tests__/provider-wizard.test.ts src/config/__tests__/config-cli.test.ts
```

预期：全部通过。

- [ ] 提交：

```bash
git add src/config/provider-wizard.ts src/config/__tests__/provider-wizard.test.ts src/config/manager.ts src/config/__tests__/config-cli.test.ts
git commit -m "feat(config): add interactive provider wizard"
```

预期：提交成功。

### 任务 5：更新用户可见文案与配置文档

- [ ] 修改：`src/main.tsx:628-638`
- [ ] 修改：`src/tui/onboarding.tsx:4-49`
- [ ] 修改：`README.md:383-548`
- [ ] 测试：`src/__tests__/onboarding.test.ts`

**目标：** 让 CLI help、onboarding、README 都指向新的 provider 配置模式，减少用户继续手写 JSON 的概率。

**调研背书：**
- `src/__tests__/onboarding.test.ts:44` 现有断言包含 `rivet config set-key`；修改 onboarding 文案时必须同步测试。
- `README.md:383-548` 当前已经描述 CLI、manual config、多 provider、Codex OAuth、API key providers、worker routing，但 CLI commands 缺少 `setup`、`set-url`、`set-model` 与 `rivet config` 向导。

**TDD 步骤：**

- [ ] 先修改测试：`src/__tests__/onboarding.test.ts` 将断言从只检查 `rivet config set-key` 改为同时检查 `rivet config` 与 `rivet config setup deepseek`。

运行：

```bash
npm exec -- tsx --test src/__tests__/onboarding.test.ts
```

预期：失败，当前文案还没有 `setup deepseek`。

- [ ] 修改 `src/tui/onboarding.tsx:4-49`：
  - `onboardingText()` 第二行改为 `Configure a provider with: rivet config`。
  - 第三行增加脚本示例：`Scripted setup: rivet config setup deepseek --key-env DEEPSEEK_API_KEY`。
  - `OnboardingPanel()` 同步显示上述两行。
  - 不显示完整 API key 示例，避免诱导用户把 secret 留在终端历史。

- [ ] 修改 `src/main.tsx:628-638` help：

```text
    rivet config              Configure providers interactively
    rivet config providers    List configured providers
    rivet config setup <p>    Create/update provider from built-in preset
    rivet config set-url <p> <url>
    rivet config set-model <p> <model> [ctx] [max] [alias]
```

- [ ] 修改 `README.md:383-548`：
  - CLI recommended 首段增加 `rivet config` 交互向导。
  - 增加脚本化示例：DeepSeek env key、GLM env key、MiMo URL override、MiniMax model override、Codex OAuth setup。
  - Provider 表中协议列改为当前实现事实：DeepSeek/OpenAI-compatible、GLM/OpenAI-compatible、MiniMax/OpenAI-compatible、MiMo/OpenAI-compatible、Codex/Codex Responses。
  - Manual config 段说明 JSON 可以只写 override，因为 `DEFAULT_CONFIG` 会提供预设。
  - 删除或改写本计划 scope 外的 `/model provider/model` 示例，避免文档继续承诺当前未实现行为；保留 `/model list` 与 `/model <model-id-or-alias>`。

- [ ] 运行验证：

```bash
npm exec -- tsx --test src/__tests__/onboarding.test.ts
```

预期：通过。

- [ ] 提交：

```bash
git add src/main.tsx src/tui/onboarding.tsx src/__tests__/onboarding.test.ts README.md
git commit -m "docs(config): document provider setup workflow"
```

预期：提交成功。

### 任务 6：集成回归与边缘用例补强

- [ ] 修改：`src/config/__tests__/config-schema-integration.test.ts:11-58`
- [ ] 修改：`src/api/__tests__/factory.test.ts:1-160`
- [ ] 修改：`src/config/__tests__/schema.test.ts:35-82`
- [ ] 测试：`src/config/__tests__/config-schema-integration.test.ts`
- [ ] 测试：`src/api/__tests__/factory.test.ts`

**目标：** 覆盖 Codex OAuth 默认 provider、API key provider override、factory 不回归、用户真实 config 兼容性。

**调研背书：**
- `src/config/__tests__/config-schema-integration.test.ts` 读取真实 `~/.rivet/config.json`，有文件才执行断言；它已经覆盖 codex/minimax/mimo 用户配置。新增断言必须保持“无 provider 时跳过”的风格，不能让未配置 Codex 的用户环境失败。
- `src/api/__tests__/factory.test.ts` 当前覆盖 DeepSeek/Kimi/OpenAI provider 创建、AuthProvider、resolveApiKey。Codex branch 已由 `codex-client.test.ts` 间接覆盖，但新增默认 Codex provider 后应至少断言 `createProviderClient(codexPreset, caps, { apiKey: '', auth })` 返回对象且不调用 `resolveApiKey()`。

**TDD 步骤：**

- [ ] 修改 `src/api/__tests__/factory.test.ts`：导入 `cloneProviderPreset` 与 `ApiKeyAuth` 已存在。增加测试：

```typescript
  it('creates CodexClient for codex OAuth provider without API key', () => {
    const provider = cloneProviderPreset('codex')
    const caps = resolveCapabilities('codex')
    const client = createProviderClient(provider, caps, {
      apiKey: '',
      model: 'gpt-5.5',
      maxTokens: 4096,
      auth: new ApiKeyAuth('oauth-token-for-test'),
    })
    assert.ok(client)
  })
```

运行：

```bash
npm exec -- tsx --test src/api/__tests__/factory.test.ts
```

预期：若任务 1 已正确补 Codex capability，则通过；若未补，会失败并指向 `resolveCapabilities('codex')` 默认值或 factory 分支。

- [ ] 修改 `src/config/__tests__/config-schema-integration.test.ts:11-58`：新增“真实 config 中 provider baseUrl 必须是 URL 且 models 非空”的循环断言；对 `codex` 只在存在时断言 `auth.type === 'oauth'`，保持当前 skip 风格。

- [ ] 修改 `src/config/__tests__/schema.test.ts:35-82`：增加“DEFAULT_CONFIG provider.default 指向存在 provider”的断言；增加“每个 provider 的第一个 model 有正数 contextWindow/maxTokens”的断言。

- [ ] 运行验证：

```bash
npm exec -- tsx --test src/api/__tests__/factory.test.ts src/config/__tests__/config-schema-integration.test.ts src/config/__tests__/schema.test.ts
```

预期：全部通过；在没有 `~/.rivet/config.json` 的环境中 integration test 跳过真实 config 断言。

- [ ] 提交：

```bash
git add src/api/__tests__/factory.test.ts src/config/__tests__/config-schema-integration.test.ts src/config/__tests__/schema.test.ts
git commit -m "test(config): cover provider setup edge cases"
```

预期：提交成功。

### 任务 7：最终全量验证与交付整理

- [ ] 修改：无业务代码修改；只在失败时修复前述任务涉及的文件
- [ ] 测试：所有本计划涉及测试文件

**目标：** 在提交序列完成后执行最小必需验证与相关回归，确认配置向导、脚本命令、默认配置、provider registry、factory、文档测试一致。

**调研背书：**
- `.rivet.md` 要求任意代码变更后至少运行 typecheck + tests。
- 共享 worktree 中已有外部 dirty 文件，本计划执行时只应提交本任务文件，不能 `git add .`。

**步骤：**

- [ ] 运行 focused tests：

```bash
npm exec -- tsx --test src/config/__tests__/provider-presets.test.ts src/config/__tests__/manager-provider.test.ts src/config/__tests__/config-cli.test.ts src/config/__tests__/provider-wizard.test.ts src/config/__tests__/schema.test.ts src/config/__tests__/layered-config.test.ts src/api/__tests__/provider-registry.test.ts src/api/__tests__/factory.test.ts src/__tests__/onboarding.test.ts
```

预期：全部 PASS。

- [ ] 运行全量 typecheck：

```bash
npx tsc --noEmit
```

预期：退出码 0，无 TypeScript error。

- [ ] 运行项目测试：

```bash
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

预期：退出码 0；若失败，按 B1 归属判定区分本计划文件失败与外部既有失败。本计划文件失败必须修复。

- [ ] 检查计划文件与代码中 secret 安全：

```bash
git diff --name-only
```

预期：只列出本计划涉及文件与共享 worktree 外部文件；提交时只 stage 本计划文件。命令输出不得包含真实 API key。

- [ ] 提交最终验证记录所需的小修复；若无修复，不创建空 commit。

## 5. Verification

实现完成后执行以下命令：

```bash
npm exec -- tsx --test src/config/__tests__/provider-presets.test.ts src/config/__tests__/manager-provider.test.ts src/config/__tests__/config-cli.test.ts src/config/__tests__/provider-wizard.test.ts src/config/__tests__/schema.test.ts src/config/__tests__/layered-config.test.ts src/api/__tests__/provider-registry.test.ts src/api/__tests__/factory.test.ts src/__tests__/onboarding.test.ts
```

预期：所有 listed tests PASS。

```bash
npx tsc --noEmit
```

预期：退出码 0，无 TypeScript error。

```bash
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

预期：退出码 0；若出现失败，执行者必须记录失败归属。属于本计划修改文件的失败需要修复；属于外部已存在 dirty 文件或环境依赖的失败可作为交付 caveat。

```bash
node dist/main.js --help
```

预期：build 后输出包含 `rivet config              Configure providers interactively`、`config setup <p>`、`config set-url <p> <url>`、`config set-model <p> <model>`。如果未 build，先运行 `npm run build`，预期 build 成功。

## 6. Self-check

### 6.1 Spec coverage

| 需求 | 覆盖任务 |
|------|----------|
| “初始化的时候，输入 rivet config，可以进入 provider 配置” | 任务 4：`runConfigCLI([])` TTY 进入 `runProviderConfigWizard()`；任务 3 保证非 TTY 不挂起 |
| “配 minimax glm mimo deepseek codex 的配置” | 任务 1：`provider-presets.ts` 五个 required presets；任务 6：默认配置与 schema 回归 |
| “apikey 可以重写/更新” | 任务 2：`setApiKey`/`setApiKeyEnv` 互斥测试；任务 3：`setup --key/--key-env`；任务 4：wizard auth mode |
| “url 可以重写/更新” | 任务 2：`updateProviderBaseUrl()`；任务 3：`set-url` 与 `setup --url`；任务 4：wizard base URL prompt |
| “模型名可以重写/更新” | 任务 2：`upsertProviderModel()`；任务 3：`set-model` 与 `setup --model`；任务 4：wizard model prompt |
| “Do not write implementation code yet” | 当前仅保存计划文档；实现任务均为未勾选 |
| “Read relevant code deeply before proposing tasks” | Research endorsement 列出 manager/default/schema/factory/main/provider registry 的存在原因、调用者、边缘风险 |
| “Tasks independently meaningful and testable with exact files” | 任务 1-7 每个任务列出创建/修改/测试文件和验证命令 |
| “TDD shape” | 任务 1-6 都包含写失败测试、运行失败、实现、运行通过、提交步骤 |
| “Conventional commits” | 每个任务提交命令使用 `feat`、`docs`、`test` 格式 |

### 6.2 Placeholder scan

已检查并移除所有禁止占位表达；计划中所有错误行为均指定了具体 message、exit code 或测试断言。

### 6.3 Type/signature consistency

| 名称 | 定义位置 | 使用位置 | 一致性 |
|------|----------|----------|--------|
| `ProviderPresetKey` | 任务 1 `src/config/provider-presets.ts` | 任务 2 `SetupProviderOptions.preset` | union 值与 `providerPresetKeys` 一致 |
| `ProviderPreset` | 任务 1 `src/config/provider-presets.ts` | 任务 1 tests | `provider: ProviderConfig`，不使用局部 override |
| `cloneProviderPreset(key)` | 任务 1 | 任务 1 default、任务 2 setup、任务 6 factory test | 返回 `ProviderConfig` |
| `isProviderPresetKey(value)` | 任务 1 | 任务 2 setup | type guard 返回 `value is ProviderPresetKey` |
| `SetupProviderOptions` | 任务 2 `src/config/manager.ts` | 任务 3 CLI、任务 4 wizard | 字段名 `providerName/apiKey/apiKeyEnv/baseUrl/model/makeDefault` 一致 |
| `upsertProviderModel(providerName, model, { preferred })` | 任务 2 | 任务 3 `set-model` | `preferred` 选项名称一致 |
| `ConfigCliIO` | 任务 3 | 任务 3 tests、任务 4 TTY branch | `stdout/stderr/exit/isTTY/runWizard` 均为可选 |
| `ProviderWizardIO` | 任务 4 | 任务 4 tests、manager TTY branch | `ask/write` 均为可选，默认用 readline |
| `runConfigCLI(args, io?)` | 任务 3 | `src/main.tsx` 与 tests | 返回 `Promise<void>`，main 使用 `await` |
| `runProviderConfigWizard(io?)` | 任务 4 | manager TTY branch、wizard tests | 返回 `Promise<void>` |

### 6.4 Research endorsement completeness

没有计划删除现有函数。所有行为变更均已背书：

- `runConfigCLI`：调用者 grep 为 `src/main.tsx:707`；变更为 async + TTY wizard；非 TTY 保持帮助输出。
- `CONFIG_PATH` 读取方式：只新增 env 覆盖；默认路径保持 `~/.rivet/config.json`。
- `DEFAULT_CONFIG` provider 来源：抽取预设但保持现有 provider 字段；新增 Codex 不改变默认 provider。
- `WELL_KNOWN_DEFAULTS` / `PROVIDER_REGISTRY`：新增 Codex 前确认 factory 与 provider-profile 已有 Codex runtime/cache 支持。
- `addModel` 行为不改；新增 upsert 函数满足更新语义，避免破坏 append 使用者。

## 7. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-28-设计一下我们模型接入的provider的模式配置优化-比如初始化的时候-输入-r.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
