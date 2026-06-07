# 意图检索路由实现计划

> **面向 AI 代理：** 本计划只做轻量「意图 → 检索方向」路由，不实现重型反锚定引擎，不让外部方案替代天枢现有运行时结构。

**目标：** 在用户消息进入后、主模型首次行动前，先判断任务真实类型，并把「应该先查哪些信息源」以结构化方式注入上下文，降低被用户第一个关键词锁死的概率。

**架构：** 采用「一次轻量分类 + 动态上下文注入」而不是自动工具 fan-out。分类器输出 RetrievalRoute，PromptEngine 把它放进 `<context-update>`，主模型仍通过现有工具链执行检索，避免绕过权限、证据、ownership、tool history 与 prefix-cache 纪律。LLM 分类可选、默认关闭；启用后有确定性 fallback，失败不阻塞 turn。

**技术栈：** TypeScript strict、node:test + assert/strict；不新增外部依赖。

---

## 关联背景文档

| 文档 | 用途 |
|------|------|
| `docs/superpowers/specs/2026-06-06-intent-retrieval-routing-design-notes.md` | 背景与外部 Claude 草案；作为问题定位输入，不直接照搬实现 |
| `docs/superpowers/plans/2026-05-31-anti-anchoring-engine-integration.md` | 重型反锚定引擎参考；本计划明确不走 MCTS 多路径 |
| `docs/sessions/2026-05-31-anti-anchoring-config-handoff.md` | 默认关闭、显式 opt-in 的接入策略参考 |
| `docs/superpowers/plans/PLAN-TEMPLATE.md` | 本计划格式参考 |

> 核验备注：`docs/sessions/2026-05-31-anti-anchoring-config-handoff.md` 当前会被工具判定为 gitignored，实施时不要把它作为唯一证据来源；默认关闭 / 显式 opt-in 的可核验模式以 `src/agent/anti-anchoring-config.ts`、`src/config/schema.ts`、`src/config/default.ts` 为准。

---

## Scope Check

本计划跨 `src/agent/`、`src/prompt/`、`src/config/`，但只服务一个闭环：**用户意图分类 → 检索方向提示 → 主模型按提示使用现有工具**。

### 明确不做

- 不自动调用 grep / git / recall / web_fetch；预检索会绕开现有工具展示、权限、证据与任务归属链，先不做。
- 不新增 MCTS、分支搜索、投影率过滤；这些属于 `antiAnchoring` 重武器。
- 不把路由结果写进 stable volatile / system prompt；必须保持 prefix cache 友好。
- 不改变 `read_file` / `grep` / `recall` / `git` 等工具实现。
- 不把外部 Claude 文档作为实现真相；它只是背景材料。

---

## 设计裁定

### 1. 先做 guide-only，不做 active-prefetch

真正的收益不是「替模型把工具先跑一遍」，而是「让模型动手前抬头确认任务类型」。自动 fan-out 的风险更大：

- 工具调用不出现在正常 assistant tool-call 序列里，用户可见性差。
- 容易绕过 approval / evidence / ownership ledger。
- pre-turn 批量 grep / git 会拖慢每个任务，并可能污染上下文。
- 对外部资料的自动抓取尤其不适合默认开启。

因此第一版只注入 `<intent-retrieval-route>`，主模型仍按现有工具规则执行。

### 2. LLM 分类可选，启用后必须有 deterministic fallback

纯正则会被措辞锚定；纯 LLM 会增加延迟和失败面。最终形态：

- `enabled: false` 默认关闭。
- `classifier: 'heuristic' | 'llm'`，默认 `llm` 但只有 enabled 后生效。
- LLM 调用限制：`tool_choice: 'none'`、低 token、低温、超时、只输出 JSON。
- LLM 失败 / JSON 不合法 / 超时 → 回退到 heuristic route，不阻塞主 turn。

### 3. 路由结果进 dynamic appendix，不注入额外 user message

现有 preTurn hook 的 `injectUserMessage` 会把指导文本作为用户消息写入会话历史，适合反锚定种子，但不适合每个任务的检索路由。检索路由是运行时上下文，应走 `PromptEngine` 的动态 appendix：

- cache-safe：不进入 stable volatile。
- 可被 GWT Top-K 预算管理。
- 不污染用户消息历史。
- 与 `affordanceHint` / `policyGuidance` / `repairHint` 同类。

---

## 调研背书

| 位置 | 当前行为 | 改后行为 | 为什么安全 |
|------|----------|----------|------------|
| `src/context/task-contract.ts` | `extractTaskContract` 只提取 objective / mentionedFiles / constraints / actionable | 保持不变；RetrievalRoute 独立存在 | 避免把任务生命周期 contract 变成大杂烩 |
| `src/agent/auto-reasoning.ts` | `selectReasoningEffort` 根据消息内容输出 off/low/medium/high/max | 保持不变；路由器与它并列，输出「查哪里」 | 单一职责清晰：努力度 ≠ 检索方向 |
| `src/agent/loop.ts` `initializeRun` | `session.addUserMessage` 后判断 actionable 并创建 TaskContract；模型请求构建前还有空间 | actionable 且配置开启时运行 router，并调用 PromptEngine 注入 route | 插入点在主模型首次请求前，符合目标；失败可吞掉不影响 turn |
| `src/agent/turn-perception.ts` | preTurn hook 可注入 user message | 本功能不走 preTurn hook 主路径 | 避免路由提示被当作用户消息持久化 |
| `src/prompt/engine.ts` | 有 `setAffordanceHint` / `setPolicyGuidance` / `setRepairHint` 等动态提示 setter | 新增 `setIntentRetrievalRoute`，只进入 dynamic appendix | 沿用现有 cache-safe 动态注入模式 |
| `src/prompt/volatile.ts` | `buildDynamicAppendix` 渲染 per-turn 动态块并按 salience 控预算 | 新增 `<intent-retrieval-route>` 块与 salience | 不影响 stable prefix；预算机制已有 |
| `src/agent/anti-anchoring-config.ts` | 反锚定默认关闭，显式 opt-in | 新增 `IntentRetrievalRouterConfig` 默认关闭 | 保守接入，避免默认增加延迟 |
| `src/agent/create-agent-config.ts` / `src/config/default.ts` | agent config 已透传 `antiAnchoring` / `songlineEnabled` 等开关 | 透传 `intentRetrievalRouter` | 沿用配置分层模式 |

### 代码核验补充（2026-06-06）

以下为对真实代码的补充核验，实施时按这些约束落点，避免计划与代码脱节：

- `src/context/task-contract.ts:109` 已有 `extractTaskContract(userMessage, turn)`，`src/context/task-contract.ts:179` 已有 `isActionableTurn(userMessage)`；路由器应以 `TaskContract` 为输入之一，不扩展 / 复用 `TaskContract` 字段，避免生命周期 contract 被检索策略污染。
- `src/agent/loop.ts:953-959` 当前顺序是 `session.addUserMessage(userInput)` → `isActionableTurn` → `promptEngine.setActionableTurn` → `extractTaskContract`。路由接线应放在 task contract 更新后、`autoReasoning` 和首次 `buildOaiRequest` 前；disabled / non-actionable 必须同步清空旧 route。
- `src/agent/loop.ts:518-537` 已有 `callAntiAnchoringSeedModel` 模式：构造 `OaiChatRequest`，`tool_choice: 'none'`，走当前 `AbortSignal`。LLM 路由调用可复用该模式，但必须使用更低 token / 温度 / 超时，并且不能注入额外 user message。
- `src/api/stream-client.ts:21` 只有 `stream(request, callbacks, signal)`，没有 completion API。LLM 分类器需要从 stream callbacks 收集文本；注意 `AnthropicClient` 会在结束时额外触发 text `onContentBlock`（`src/api/anthropic-client.ts:459-461`），若同时拼接 `onTextDelta` 和 text block 会重复内容。实现应选择一种收集路径，推荐只拼 `onTextDelta`，忽略 text `onContentBlock`。
- `src/prompt/engine.ts:190` 手工组装 `dynamicCtx`；新增字段必须在这里、`getVolatilePayloadReport` 和 setter 中同时接入。`setAffordanceHint` / `setPolicyGuidance`（`src/prompt/engine.ts:489-494`）是最近似模式；route setter 需要调用 `invalidateFreshCache`（`src/prompt/engine.ts:548`），因为它应在新用户消息的 fresh appendix 里立即生效。
- `src/prompt/volatile.ts:129` / `src/prompt/volatile.ts:183` / `src/prompt/volatile.ts:330` 分别是 stable block、dynamic appendix、salience 入口。`intentRetrievalRoute` 必须只进入 dynamic appendix，且 `assignSalience` 要给显式分值，避免 GWT Top-K 预算下被默认 0.5 错排。
- `src/config/schema.ts:71-82` 是分层配置 schema 的 `agent` 入口；任务 4 不能只改 `src/config/default.ts`，还必须加 schema 和 schema 测试，否则 `.rivet-config.json` / session overlay 中的开关无法解析。
- `src/agent/create-agent-config.ts:54-67` / `src/agent/create-agent-config.ts:74-116` 是配置透传入口；`createMainAgentConfigInput` 和 `createAgentConfig` 的 Pick 返回类型都要补 `intentRetrievalRouter`。

---

## 数据模型

### RetrievalRoute

核心字段建议：

- `taskKinds`: 任务类型数组，允许多标签但限制最多 2 个主类。
- `directions`: 检索方向数组，每项包含：
  - `source`: `codebase | git | memory | docs | external | tests`
  - `priority`: `must | should | optional | avoid`
  - `query`: 给主模型的具体检索建议。
  - `reason`: 为什么这个任务类型需要查该源。
- `antiAnchorNote`: 一句话提醒「用户关键词只是入口，不是边界」。
- `confidence`: 0-1。
- `fallbackUsed`: boolean。

### 字段约束与归一化

实现中固定这些上限，避免 LLM 输出把动态上下文撑爆：

- `taskKinds`: 最多 2 个；未知类型丢弃，空则回退到 heuristic 推断。
- `directions`: 最多 6 条；按 `must → should → optional → avoid` 排序后截断。
- `query` / `reason`: 单项建议不超过 160 字符；超长截断并 XML escape。
- `antiAnchorNote`: 不超过 180 字符；默认句式：`用户关键词是入口，不是任务边界；先按任务类型补齐必查源。`
- `confidence`: clamp 到 `[0, 1]`；LLM 成功但归一化后无有效方向时视为失败并 fallback。
- `fallbackUsed`: heuristic 直接生成或 LLM fallback 时为 `true`；合法 LLM route 为 `false`。

建议维护一个 `TASK_KIND_BASELINES` 常量表：每个 `IntentTaskKind` 映射默认 directions。`buildHeuristicRetrievalRoute` 直接从表生成；`normalizeRetrievalRoute` 在 LLM 输出缺少该类型 must/should 基线时补齐，防止 LLM 正好漏掉本功能要防的检索源。

### 任务类型初版

| 类型 | 典型触发 | 必查源 |
|------|----------|--------|
| `bug_fix` | 修复、报错、失败、异常、回归 | codebase + tests + memory；涉及近期引入时 git |
| `performance_diagnosis` | 慢、卡顿、OOM、延迟、吞吐 | codebase + git + memory |
| `new_feature` | 新增、支持、实现功能 | codebase + docs；必要时 memory |
| `architecture_design` | 设计、方案、架构、选型 | codebase + memory + external/docs |
| `refactor` | 重构、迁移、拆分、整理 | codebase + git + tests + memory |
| `usage_question` | 怎么用、配置、命令、API | docs/external + codebase optional |
| `code_explanation` | 解释、看一下、分析某文件 | codebase；memory optional |
| `review_audit` | 审查、风险、P0/P1、blast radius | codebase + tests + git + memory |
| `verification` | 验证、跑测试、确认是否完成 | tests + git/status + codebase optional |
| `security_safety` | 权限、token、路径穿越、命令执行 | codebase + git + tests + memory |

---

## 任务

### 任务 1：定义纯路由数据模型与 heuristic fallback

**文件：**
- `src/agent/intent-retrieval-route.ts`
- `src/agent/__tests__/intent-retrieval-route.test.ts`

**做什么：** 新增纯函数层，不触碰 AgentLoop。它负责类型定义、默认任务类型表、启发式 fallback、route 校验与 XML 渲染。

- [ ] 定义 `RetrievalSource` / `RetrievalPriority` / `IntentTaskKind` / `RetrievalDirection` / `RetrievalRoute`。
- [ ] 实现 `buildHeuristicRetrievalRoute(input)`：输入 user message + TaskContract，输出保守 route。
- [ ] 实现 `normalizeRetrievalRoute(raw)`：限制 source 白名单、priority 白名单、方向数量、字符串长度。
- [ ] 实现 `renderIntentRetrievalRoute(route)`：输出 `<intent-retrieval-route>`，不包含用户原文全文，只保留必要短摘要。
- [ ] 测试覆盖 bug/perf/architecture/refactor/usage/review/security 等代表消息。

**实现细则：**

- heuristic 必须同时覆盖中文和英文关键词：如 `修复/报错/失败/异常/回归`，`慢/卡顿/OOM/延迟/吞吐`，`设计/架构/方案/选型`，`重构/迁移/拆分`，`怎么用/配置/命令/API`，`审查/风险/P0/P1/blast radius`，`权限/token/路径穿越/命令执行`。
- 多标签只保留前 2 个主类；优先级建议：`security_safety > bug_fix > performance_diagnosis > review_audit > refactor > new_feature > architecture_design > verification > usage_question > code_explanation`。
- 如果 `TaskContract.scope.mentionedFiles` 非空，codebase/tests 方向的 `query` 应包含“先查提到文件及调用方/相关测试”，但不要把全部用户消息复制进 XML。
- `renderIntentRetrievalRoute` 只接收已经 normalized 的 route；渲染前仍做 XML escape 作为最后防线。

### 任务 2：实现可选 LLM 分类器

**文件：**
- `src/agent/intent-retrieval-router.ts`
- `src/agent/__tests__/intent-retrieval-router.test.ts`

**做什么：** 新增 orchestrator：根据配置选择 heuristic 或 LLM。LLM 只负责分类和路由，不回答用户任务，不调用工具。

- [ ] 定义 `IntentRetrievalRouterConfig` 与 `DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG`。
- [ ] 实现 `normalizeIntentRetrievalRouterConfig`，支持 boolean / partial config。
- [ ] 实现 `buildIntentRouterPrompt`，明确要求：先归类任务真实类型，再列该类型应查源；用户关键词是线索不是边界；只输出 JSON。
- [ ] 实现 `classifyIntentRetrievalRoute`：LLM 成功则 parse + normalize；失败、超时、abort 则 fallback。
- [ ] 测试：LLM 返回合法 JSON、非法 JSON、超时/throw、disabled、heuristic 模式。

**建议配置字段：**

```typescript
export interface IntentRetrievalRouterConfig {
  enabled: boolean
  classifier: 'heuristic' | 'llm'
  timeoutMs: number
  maxTokens: number
  temperature: number
}

export const DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG: IntentRetrievalRouterConfig = {
  enabled: false,
  classifier: 'llm',
  timeoutMs: 4_000,
  maxTokens: 600,
  temperature: 0,
}
```

**LLM 调用细则：**

- 使用当前主 `StreamClient`，请求形态：`stream: true`、`tool_choice: 'none'`、`max_tokens: config.maxTokens`、`temperature: config.temperature`。
- signal 用 `AbortSignal.any([runSignal, AbortSignal.timeout(config.timeoutMs)])`；timeout / abort / throw 都返回 heuristic fallback，不抛给主 loop。
- 只从 `onTextDelta` 收集 JSON 文本，忽略 `onContentBlock` 的 text，避免 Anthropic 适配层重复拼接。
- JSON 解析支持裸 JSON 和 fenced code block；解析后必须走 `normalizeRetrievalRoute`，不能直接信任 LLM 输出。
- prompt 中明确禁止回答用户任务、禁止调用工具、禁止引入事实性结论；只能输出 route JSON。

### 任务 3：PromptEngine 动态注入

**文件：**
- `src/prompt/volatile.ts`
- `src/prompt/engine.ts`
- `src/prompt/__tests__/volatile.test.ts`
- `src/prompt/__tests__/engine-cache-stability.test.ts` 或新增 `src/prompt/__tests__/intent-retrieval-route.test.ts`

**做什么：** 把 route 注入 dynamic appendix，不进入 stable volatile，不改变历史消息 prefix。

- [ ] `VolatileContext` 增加 `intentRetrievalRoute?: string | null`。
- [ ] `buildStableVolatileBlock` 显式剔除该字段。
- [ ] `buildDynamicAppendix` 在 `affordanceHint` / `policyGuidance` 前后渲染该块；salience 建议 0.7。
- [ ] `PromptEngine` 增加 `setIntentRetrievalRoute(route: string | null)`，调用后 invalidate fresh cache。
- [ ] `PromptEngine.getVolatilePayloadReport` 的 latest context 补该字段，方便 payload diagnostic 与测试覆盖。
- [ ] 测试：stable block 不含 route；dynamic appendix 含 route；重复 tool-call turn 不重复重建 stable prefix。

**接入细节：**

- `buildStableVolatileBlock` 中显式置空 `intentRetrievalRoute`，即使当前内部 renderer 不会读取，也要把缓存边界写清楚。
- `buildDynamicAppendix` 建议把 route 放在 git/status 之后、affordance/policy 之前：它比认知状态更贴近当前任务，但不应压过 star-domain / historical-lessons / repair-hint。
- `assignSalience('<intent-retrieval-route')` 返回 `0.7`，与 task-progress / decisions 同级。
- setter 必须清空 fresh cache，但不能调用 `rebuildFrozenBase()`，否则会破坏 stable volatile prefix。

### 任务 4：AgentLoop 接线与配置透传

**文件：**
- `src/agent/loop-types.ts`
- `src/agent/create-agent-config.ts`
- `src/agent/loop.ts`
- `src/config/schema.ts`
- `src/config/default.ts`
- `src/__tests__/create-agent-config.test.ts`
- `src/config/__tests__/schema.test.ts`
- `src/agent/__tests__/loop-intent-retrieval-router.test.ts`

**做什么：** 把 router 插到 `initializeRun` 的 task contract 之后、主模型请求之前。默认关闭；开启后只影响 actionable turn。

- [ ] `AgentConfig` 增加 `intentRetrievalRouter?: IntentRetrievalRouterConfigInput`。
- [ ] 分层配置增加 `agent.intentRetrievalRouter`，默认 `{ enabled: false }`。
- [ ] `createAgentConfig` 透传配置。
- [ ] `AgentLoop.initializeRun`：actionable 且 enabled 时调用 router，并 `promptEngine.setIntentRetrievalRoute(rendered)`；非 actionable 或 disabled 时清空。
- [ ] 使用当前 abort signal + timeout；router 失败只记录 debug，不抛出。
- [ ] 测试：disabled 不注入；enabled heuristic 注入；router throw 不阻断 run；非 actionable turn 清空 route。

**配置 schema 细节：**

- `agent.intentRetrievalRouter` 需要和 `antiAnchoring` 一样默认 `{ enabled: false }`。
- 若要支持计划中的 boolean shorthand，`src/config/schema.ts` 不能只写 `z.object(...)`；需要用 `z.preprocess` 或 union 接受 `true/false/object/undefined`，再归一化到完整对象。
- `createMainAgentConfigInput` 从 `params.config.agent.intentRetrievalRouter` 透传；`createAgentConfig` 返回 Pick 增加 `intentRetrievalRouter`。

**AgentLoop 接线细节：**

- 在 `initializeRun` 中，`this.taskContract = extractTaskContract(...)` 后立即计算 route；失败 catch 后用 heuristic fallback 或清空，不能让主 run 失败。
- 建议抽私有 helper：`buildIntentRetrievalRouteForTurn(userInput, contract, signal)`，避免把 LLM streaming 细节塞进 `initializeRun`。
- disabled / non-actionable / 无 active contract 时都调用 `promptEngine.setIntentRetrievalRoute(null)`，避免上一轮 route 残留到闲聊或确认类消息。
- 如果 `classifier: 'heuristic'`，不得触发任何 LLM stream；测试要用 mock client 断言 stream 调用次数为 0。

### 任务 5：路由提示质量与反锚定边界测试

**文件：**
- `src/agent/__tests__/intent-retrieval-anti-anchor.test.ts`

**做什么：** 用具体例子验证「不被第一个关键词锁死」这个真实意图，而不是只测字段存在。

- [ ] 用「重试一下这个失败」断言 route 至少包含 codebase/tests/memory，且不只给 retry 建议。
- [ ] 用「慢」类性能请求断言包含 git + codebase + memory。
- [ ] 用「怎么用 X」断言 external/docs 为 must 或 should，git 为 avoid/optional。
- [ ] 用「审查 P0」断言包含 codebase + tests + git + memory。
- [ ] LLM 合法 JSON 如果遗漏该任务类型的 baseline `must` 源，normalize 后仍应补回；否则 LLM 分类器本身会重新制造“漏查源”的问题。
- [ ] 用「慢慢解释这个函数」断言不要误判为 `performance_diagnosis`；`慢/slow` 只有与性能、延迟、卡顿、吞吐等语义同现时才触发性能路由。
- [ ] 用「token refresh API 怎么用」断言不要误判为 `security_safety`；只有泄露、权限、secret、路径穿越、命令执行等安全语义同现时才触发安全路由。
- [ ] 用「最近升级后 X 怎么用失败」断言允许 `usage_question + bug_fix` 多标签，并补 codebase/tests/git，而不是被“怎么用”单词锁死。

---

## 天璇复核补充：跨域收敛出的增量约束

按天璇方法，从医疗分诊、搜索查询规划、空管/事故指挥、编译器前端四个无关领域类比，收敛出 5 条必须补进实现约束的模式；这些约束不改变 guide-only 架构，只防止轻路由自己变成新锚点。

1. **Route 是 advisory，不是 authority**  
   像医疗分诊只给下一步检查方向，不替代医生诊断。`renderIntentRetrievalRoute` 建议带 `advisory="true" scope="current-turn"`，并在块内写明：项目规则、工具权限、实际证据优先于 route；route 不能禁止模型查其它必要来源。

2. **先处理“字面诱饵”负例，再做关键词命中**  
   搜索查询规划不会把每个词都当主题词。heuristic 需要负例护栏：`慢慢解释/慢一点说` 不等于性能问题，`token refresh` 不等于安全问题，`P0` 单独出现不等于 review/audit。任务 5 的 anti-anchor 测试必须覆盖这些词面陷阱。

3. **Route 必须有 turn 级有效期**  
   空管 clearance 有时效，不能无限期沿用。PromptEngine 每个新 user turn 先清空 route，再按当前 turn 设置；历史消息里冻结的旧 route 即使仍在上下文中，也必须通过 `scope="current-turn"` 提醒模型不要把它当作最新路由。

4. **Source 是工具族契约，不是自动命令**  
   编译器前端输出 AST，不直接执行后端优化。`source: external/docs/git/...` 只表示“该信息源值得主模型考虑”，不是要求 router 自动调用工具；`external` 仍受现有 approval / web_fetch 规则约束，`docs` 优先项目内文档而非网络。

5. **需要轻量观测，不记录用户全文**  
   搜索路由要看召回质量。实现可 debug 记录 `taskKinds`、sources、classifier、fallbackUsed、latencyMs、directionCount；禁止记录完整 user message 和 LLM 原文，避免把隐私或 prompt injection 持久化。

---

## 实施风险与硬性防线

1. **prefix cache 风险**：route 只能存在于 latest user message 的 dynamic appendix；不能写入 stable volatile、system prompt、历史 user message 注入 hook。
2. **流式文本重复风险**：通用 `StreamClient` 在不同 provider 下 callback 行为不完全一致；LLM 分类器不要同时拼接 `onTextDelta` 和 text `onContentBlock`。
3. **配置解析风险**：默认对象在 `DEFAULT_CONFIG` 里不够，必须同步 schema，否则用户配置和 overlay 会丢字段或 parse fail。
4. **LLM 漏源风险**：LLM 输出只是候选，normalize 必须用 `TASK_KIND_BASELINES` 兜底补必查源。
5. **历史污染风险**：不要使用 `turn-perception` 的 `injectUserMessage` 主路径；本功能是运行时上下文，不是用户指令。
6. **权限 / ownership 风险**：第一版禁止自动 prefetch，不能在 router 内调用 grep / git / recall / web_fetch。

---

## 验证

```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/intent-retrieval-route.test.ts
node --import tsx --test src/agent/__tests__/intent-retrieval-router.test.ts
node --import tsx --test src/agent/__tests__/intent-retrieval-anti-anchor.test.ts
node --import tsx --test src/__tests__/create-agent-config.test.ts
node --import tsx --test src/config/__tests__/schema.test.ts
node --import tsx --test src/prompt/__tests__/volatile.test.ts
node --import tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
```

若改动触及 `AgentLoop.initializeRun`，再补跑最小 loop 相关测试：

```bash
node --import tsx --test src/agent/__tests__/loop-*.test.ts
```

---

## 自检

- 「用户关键词是入口不是边界」→ 任务 1/5 覆盖。
- 「模型动手前知道该查哪些源」→ 任务 3/4 覆盖。
- 「不引入重型反锚定」→ Scope Check 明确不做 MCTS / fan-out。
- 「不污染 prefix cache」→ 任务 3 覆盖 stable/dynamic 分层。
- 「外部 Claude 文档只作背景」→ 关联背景文档与设计裁定已说明。
- 「失败不阻塞主 turn」→ 任务 2/4 覆盖 fallback 与异常吞吐。

---

## 实现状态（2026-06-07 审查核验）

提交 `389304c feat(agent): wire intent retrieval router`（15 文件，+457/−12）。独立复核结论：

- ✅ **遵守边界**：router 内零 `grep/git/recall/web_fetch` 调用（风险6）；route 仅进 dynamic appendix，不入 stable/system/fingerprint（风险1）；非 `injectUserMessage`（风险5）。
- ✅ **默认关闭**：`config/default.ts` `intentRetrievalRouter.enabled = false`。
- ✅ **测试强制**：`engine-cache-stability`（缓存不炸）、`intent-retrieval-anti-anchor`（+110）、`loop-intent-retrieval-router`（+165）、`schema`（+14）全绿；`tsc --noEmit` 通过。
- ⚠️ ~~未逐行核验项~~：风险2（LLM 流式文本重复）、风险4（`TASK_KIND_BASELINES` 兜底 normalize）——**已复验通过（2026-06-07）。**

### 🚦 opt-in Gate — 启用 LLM 分类器（`classifier: 'llm'` + `enabled: true`）前必须先做

将 `intentRetrievalRouter.enabled` 切为 `true` 之前，必须先核验默认关闭期间未被覆盖的两条 LLM 路径风险，否则不得启用：

- [x] **风险2 复验**：用 mock `StreamClient` 断言 LLM 分类器不同时消费 `onTextDelta` 与 text `onContentBlock`，确认无文本重复拼接。→ `intent-retrieval-router.test.ts:79` `assert.ok(!route.directions.some(... 'duplicated'))` ✅
- [x] **风险4 复验**：构造「LLM 合法 JSON 但遗漏该任务类型 baseline `must` 源」用例，断言 `normalizeRetrievalRoute` 用 `TASK_KIND_BASELINES` 补回，LLM 不能重新制造漏查源。→ `intent-retrieval-route.test.ts:89` `assert.equal(priorityFor(route, 'tests'), 'must')` ✅
- [x] 两条均绿后，方可在配置中开启 `enabled: true`。→ **opt-in gate 已清，可安全启用 LLM 分类器。**

> 默认 heuristic 路径已由现有测试覆盖；本 gate 只约束 LLM 路径的首次启用。
