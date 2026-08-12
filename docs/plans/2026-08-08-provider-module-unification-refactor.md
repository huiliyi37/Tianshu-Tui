---
title: Provider 模块重构——统一描述符、协议做实、probe-first 接入
type: plan
status: draft
date: 2026-08-08
related:
  - src/api/provider.ts
  - src/api/provider-registry.ts
  - src/api/provider-profile.ts
  - src/api/factory.ts
  - src/config/provider-presets.ts
  - src/config/manager.ts
  - src/config/schema.ts
  - src/tui/connect-flow.ts
  - src/config/provider-wizard.ts
  - src/api/key-probe.ts
  - src/api/error-classifier.ts
supersedes: docs/plans/2026-08-06-provider-adaptation-and-model-list-fetch.md（B 部分并入本计划 Wave 3；A 部分保留为后续独立项）
---

# Provider 模块重构——统一描述符、协议做实、probe-first 接入

> 把预设/自定义 provider 收敛为同构的 ProviderDescriptor，protocol 枚举做实，
> 接入流程 probe-first，错误层补齐。内部逻辑直接重写，不为旧实现做兼容妥协。

## 背景：现状审计结论（2026-08-08）

### 结构问题（主靶子）

1. **provider 知识散落 4 个文件且互相复制**：
   - `src/api/provider.ts` — `WELL_KNOWN_DEFAULTS`（运行时能力，resolveCapabilities 消费）
   - `src/api/provider-registry.ts` — `PROVIDER_REGISTRY`（label/notes/cacheProfile + **用独立 zod schema 复制了一遍能力字段**）
   - `src/config/provider-presets.ts` — `PROVIDER_PRESETS`（完整 ProviderConfig：baseUrl/auth/models）
   - `src/api/provider-profile.ts` — 缓存档案（cacheType/ttl 等）
   四处必须手工保持一致，且**已经漂移**：registry 的能力 schema 缺 `preservedThinkingProtocol`、`thinkingBudgetField` 之外的新字段语义无人同步。
2. **预设与自定义是两套路径**：`setupProvider`（预设名，manager.ts:1324）与 `setupCustomProvider`（manager.ts:1375，硬编码 `protocol:'openai'`、`prefixCache:'none'`，静默覆盖同名）。

### 协议覆盖

3. `protocol` 枚举只有 `'openai'`（schema.ts:101）。Anthropic 客户端靠 `name === 'anthropic'` 或手写 `prefixCache:'anthropic-cache-control'` 的未文档化后门（factory.ts:98）。无 Gemini。
4. factory.ts 内还有 providerName 硬编码：`useMaxCompletionTokens`（mimo/mimo-api/minimax）、`userAgent`（kimi）、`SLOW_THINKING_STALL_DEFAULT_MS[provider.name]`。

### 接入与报错

5. 坏 JSON 被 `catch {}` 静默吞掉（manager.ts:201-203, 217-219）→ 配置"凭空回退"。
6. 合法 JSON 字段错 → 裸 ZodError，无字段路径级友好格式化。
7. 写入只查 URL 语法（`assertValidUrl` = `new URL()`），不探活。桌面端有 key-probe，TUI/CLI 不用。
8. 运行时提示几乎为零：`apiErrorHint` 只认余额不足；401 不提 env 变量名；404 未知模型通用文案；**200+非 SSE（baseUrl 少 /v1、端点不支持 stream）无 content-type 检查，空流报无意义的错**——自定义端点最常见失败模式最难诊断。
9. 四个入口能力互不一致：CLI 建不了自定义 provider；首启 wizard 只列内置；`/connect` DIY 不问思考能力、一个模型建一个 provider（`custom-<模型名>`，connect-flow.ts:357）。
10. 模型元数据：contextWindow/maxTokens 必填正整数，三入口默认值不一致（128000 vs 131072），无 /models 拉取、无模型名推断。

## 目标

- **一个描述符**：预设与自定义同构；新增 provider = 写一份 JSON，全链路（TUI/CLI/桌面/运行时）共用。
- **协议做实**：`'openai' | 'anthropic'` 显式选择，删掉 name 后门。
- **probe-first**：落盘前可探测（模型清单 + 一次廉价补全），探测结果自动回填能力。
- **错误可诊断**：坏配置响铃、字段级人话报错、运行时按错误类别给可操作提示。
- provider 知识单文件唯一真源，漂移在结构上不可能发生。

## 非目标

- Gemini / Bedrock / Vertex 协议客户端（protocol 枚举预留位置即可）。
- 运行时能力探测推断 thinking 支持的深度分析（probe 只做最简启发式：响应里有 `reasoning_content` 即标记）。
- 自动改写用户已有 config.json 的迁移脚本——旧 shape 能宽松读则读，读不了就响铃报字段路径，不做静默修复（用户已确认不必保旧兼容）。

## 目标架构

### 单一真源：`src/api/provider-catalog.ts`（新）

合并 provider.ts 的 WELL_KNOWN_DEFAULTS + provider-registry.ts + provider-profile.ts 的缓存档案为一个目录：

```ts
// 每个内置 provider 一条目录项；能力字段即运行时消费的真源，不再有第二份 schema
interface CatalogEntry {
  key: string                    // 'deepseek'
  label: string
  protocol: 'openai' | 'anthropic'
  capabilities: ProviderCapabilities   // 直接引用，含 mapUsage 引用标记
  cacheProfile: CacheProfile
  stallTimeoutMs?: number
  wire: {                        // 原 factory 里的 name 硬编码全部进这里
    useMaxCompletionTokens?: boolean
    userAgent?: string
  }
  notes?: string[]
}
```

- `resolveCapabilities` 留在原地（三层覆盖链已重构完毕），但 base 改从 catalog 读。
- **provider-registry.ts 整体删除**（其独立 zod 能力 schema 是漂移源头）。
- provider-presets.ts 保留但降格：只含"出厂配置"（baseUrl/auth/models/默认 overrides），引用 catalog 而不复制能力。

### 统一 ProviderDescriptor（config schema 重写）

`providerSchema` 重写为描述符形态，预设与用户自定义同一 schema：

```ts
protocol: z.enum(['openai', 'anthropic'])      // 做实，默认 openai
baseUrl / auth / apiKey / apiKeyEnv            // 身份层
capabilities: providerCapabilitiesSchema       // 覆盖层（已有，沿用）
models: z.array(modelSchema).default([])       // 降级：允许空数组
```

- `modelSchema` 的 contextWindow/maxTokens 改 optional：缺失时按
  模型名模式推断（`-128k`/`-1m`/`-32k` 后缀）→ 探测回报 → 保守默认（128K/8K）三级兜底，
  推断来源记入 meta 供 UI 展示"（推断值，建议核实）"。
- factory.ts 按 `protocol` 分发客户端；wire 杂项从 catalog 读；providerName 判断清零。

### probe-first 接入：`src/api/provider-probe.ts`（新，扩展 key-probe）

```
probeProvider({ baseUrl, apiKey, protocol }) →
  1. GET /models               → 模型 id 清单（超时/404 则降级跳过）
  2. 一次最小补全（stream, max_tokens=8, "hi"）→
     - content-type 非 SSE → 明确报"端点不支持流式或路径错误（是否缺 /v1）"
     - 响应含 reasoning_content → 建议 capabilities.effortFormat/reasoningSplit
     - 401/403/404 → 分类文案
  3. 输出 ProbeReport { models[], hints: CapabilityHints, latencyMs, errors[] }
```

### 模型别名表与 ID 匹配管道（`provider models` / 一键拉取的核心）

精准匹配只在"官方直连端点 + 已知模型"成立；聚合商 ID 带厂商前缀/变体后缀
（siliconflow `deepseek-ai/DeepSeek-V3`、openrouter `deepseek/deepseek-chat`、`:free`），
自建中转（one-api/new-api）管理员可任意重命名——结构性不可能精准。
因此匹配设计为**四级降级管道**，而非假设全局 exact match：

```
拉取的 raw id
  ↓ L1 exact：原样查别名表（canonicalId + aliases[]）
  ↓ L2 normalize：小写化 → 剥厂商前缀（首个 / 之前）→ 剥变体后缀（:free / @xxx / 日期戳）→ 再查
  ↓ L3 fuzzy：token 重合度打分（qwen3-max-preview ≈ qwen3-max），过阈值才建议，标注"低置信，请确认"
  ↓ L4 unknown：输出骨架（id 已填，contextWindow/maxTokens/capabilities 留空待手填）
```

- **别名表进 catalog**：每个已知模型一条 `canonicalId + aliases[] + 元数据`
  （contextWindow/maxTokens/思考能力/定价）。命中即自动回填元数据——
  一键拉取的价值在元数据回填，不只是 ID 列表。L2 归一化规则挂在别名表条目上。
- **置信度决定落盘方式**：L1/L2 命中静默回填；L3 回填但标"推断值"；
  L4 明确留空并提示手填。**低置信匹配绝不静默写死 contextWindow**——
  填错的窗口直接影响压缩与截断行为。
- **unknown 是一等公民**：官方上新/改名是常态，未匹配模型在 UI/输出中
  作为正常结果展示（带 TODO 骨架），不当错误处理。
- 别名表需持续维护，随 preset/官方目录更新。

### 统一接入入口（同一 probe + 同一写入核心）

- **CLI 新增** `rivet provider <add|list|models|probe|remove>`：
  - `provider add <name> --base-url ... [--api-key-env ...] [--protocol anthropic]`
    → 交互补全 + probe + 落盘；`--no-probe` 跳过。
  - `provider models <name>` → 拉模型清单，输出可粘贴的 `models[]` 片段（并入旧计划文档 B）。
- **TUI `/connect` DIY** 重写：probe 结果预填模型列表与思考能力问句，
  支持一次添加多模型到一个 provider（废除 custom-<模型名> 单模型模式）。
- **首启 wizard** 并入同一核心（含自定义入口），不再只列内置。
- **桌面端 config-routes** 的 custom/probe 端点改调同一核心，HTTP shape 保持。
- 写入核心统一行为：同名必须显式 `--force` / UI 确认，不再静默覆盖。

### 错误层

- **配置加载**（manager.ts 重写相关段）：
  - JSON parse 失败 → 报错含文件路径 + 行号，**绝不回退默认**。
  - zod 失败 → 统一格式化器：`providers.<name>.models[0].contextWindow: 需要正整数`（zod issue 路径翻译，全库配置共用）。
- **运行时**（error-classifier + openai-client）：
  - 响应 content-type 检查；非 SSE 200 → 专属可操作提示。
  - 401 → 附当前 provider 的 env 变量名；404 → 提示 `rivet provider models` 核对模型 id。
  - `apiErrorHint` 余额不足逻辑保留，改为分类器的一条规则。

## 任务分解（按 wave 推进，每 wave 独立可验证）

### Wave 1 — catalog 合并（纯内部，无行为变化）

- [ ] 新建 `provider-catalog.ts`：迁入 WELL_KNOWN_DEFAULTS 全部条目 + registry 的 label/notes + profile 的缓存档案 + factory 的 wire 杂项（useMaxCompletionTokens/userAgent/stall 默认）
- [ ] `resolveCapabilities` base 改读 catalog；`provider-registry.ts` 删除，引用点（conformance-scorecard、getProviderProfile 等）迁移
- [ ] factory.ts 的 providerName 硬编码全部改读 catalog.wire
- [ ] 验证：现有 provider/openai-client/factory/conformance 测试全绿 + 新增"catalog 与 presets 名称对齐"守卫测试

### Wave 2 — protocol 做实 + descriptor schema 重写

- [ ] schema.ts：`protocol` 枚举加 `'anthropic'`；providerSchema 按描述符形态重写；models[] 允许空
- [ ] factory.ts 按 protocol 分发；删除 `name === 'anthropic'` 与 prefixCache 后门
- [ ] modelSchema contextWindow/maxTokens 改 optional + 三级兜底推断函数
- [ ] 预设（provider-presets.ts）标注 protocol；setupCustomProvider 删除硬编码
- [ ] 验证：factory 协议分发测试（openai/anthropic 各一条自定义 provider 端到端走通 mock）

### Wave 3 — probe + 统一入口 + 模型拉取匹配

- [ ] `provider-probe.ts`：/models + 最小补全探测 + capability hints
- [ ] catalog 模型别名表：`canonicalId + aliases[] + 元数据`（首批从 provider-presets 的 models 数据灌入，替代 findPresetModel 的散点查询）
- [ ] `model-id-matcher.ts`：L1 exact → L2 normalize（剥厂商前缀/变体后缀）→ L3 fuzzy（带置信阈值）→ L4 unknown 骨架，四级管道；置信度决定回填是否标注
- [ ] CLI `rivet provider add/list/models/probe/remove`（manager.ts 写入核心统一，同名需 --force）；`models` 输出经匹配管道的可粘贴 `models[]` 片段（命中带元数据，unknown 带 TODO）
- [ ] `/connect` DIY 重写（多模型、probe 预填、思考能力问句）；首启 wizard 并入
- [ ] 桌面 config-routes 切换到统一核心
- [ ] 验证：对一个 mock OpenAI 兼容服务（测试内起 http server）跑 add→probe→models→首次补全全流程；匹配管道用 siliconflow/openrouter 真实 ID 形态（带前缀/`:free`）的样例数据测 L1-L4 各级

### Wave 4 — 错误层

- [ ] manager.ts 配置加载：坏 JSON 响铃 + zod 路径格式化器（抽到 `src/config/format-zod-error.ts` 全库共用）
- [ ] openai-client content-type 检查 + error-classifier 新规则（401 带 env 名 / 404 提示 models 命令 / 非 SSE 200）
- [ ] 验证：坏 JSON、缺字段、401/404/非 SSE 四类场景的错误文案快照测试

## 风险与取舍

- **Wave 1 触面广**（registry 引用点散落）→ 守卫测试先行，逐文件迁移逐文件跑测试。
- **models[] 可选化**影响下游（fallback 选模、contextWindow 消费点）→ 三级兜底保证任何消费点拿到的都是数字，推断不确定性只在 UI 标注。
- **桌面端 HTTP shape**：config-routes 对外 shape 保持，只换实现，避免 desktop 联动大改。
- probe 的最小补全会消耗用户少量 token → 探测可跳过（--no-probe / UI 跳过按钮），文案注明。
- **别名表维护成本**：官方上新/改名/下线是常态，表必然滞后 → 用 L4 unknown 兜底 +
  流程上把未匹配模型做成一等公民展示；表更新跟随 preset/官方目录同步节奏，不承诺实时。
- 不做迁移脚本的代价：极端旧配置可能加载失败 → 用响铃 + 字段级报错兜住，失败路径明确可修。

## 依赖

- Wave 1 无前置。Wave 2 依赖 Wave 1（catalog）。Wave 3/4 依赖 Wave 2（descriptor schema），彼此可并行。
- 与旧计划文档 A 部分（Qwen 家族适配）无耦合，可交错。
