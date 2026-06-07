# 意图检索路由 — 背景与设计考量（设计待定）

> **状态：背景梳理，设计未定。** 本文档只记录问题定位、现状勘查、需要考虑的点。设计方案单独讨论后再补。
> **日期：** 2026-06-06
> **相关讨论：** 由 Ebook 因果解耦引擎 / 认知发散引擎的理解引出，收敛到天枢自身的一个小切面。

---

## 1. 我们要解决的问题（精确定位）

**一句话：** 用户消息进来后，在 agent 动手之前，快速判断"这个任务接下来该往哪几个信息源查"，且判断时**不被用户的第一个关键提示词锁定**。

### 不是什么

- 不是反锚定引擎的发散方案（MCTS 多路径、投影率打分）——那是重武器。
- 不是头脑风暴多个解法。
- 不是检测输出文本里关键词出现几次。

### 是什么

- 是一个轻量的 **意图 → 检索方向** 路由判断。
- 输出不是答案，是"**接下来查这几个地方**"的清单（git / 代码库 / 外部资料 / 知识库记忆）。
- 一次判断，不发散方案。价值在"按任务真实类型不漏查"，而非"多想几个解"。

### "锚定"在这个切面的确切含义

把用户的第一个词当成**已验证的任务边界**，只查这个词字面直接指向的那一个源，漏掉了这个任务**类型**本该查的其他源，然后给一个字面意义上的最小满足。

- 锚定轨迹：`用户说"重试"` → `直接写重试循环` —— 中间没有"为什么失败 / 这是不是真问题"的探查。
- 不锚定轨迹：`用户说"重试"` → 归类为"故障处理类任务" → 知道该查 git（何时引入）、代码（失败模式）、知识库（同类问题），再决定重试是否是对的解。

**关键区别不在"做得多还是少"，在"有没有先抬头确认真实任务再决定查哪些源"。** 用户的关键词是**入口**（线索），不是**边界**。

---

## 2. 任务分类 → 检索方向映射（草案，粒度待定）

这是整个东西的心脏。不同任务类型，天然该查不同的源：

| 任务类型 | git | 代码库 | 外部资料 | 知识库/记忆 |
|----------|-----|--------|----------|-------------|
| Bug 修复 | ✅ 谁改的/何时引入 | ✅ 复现路径 | ⚪ 偶尔 | ✅ 同类 bug |
| 性能诊断 | ✅ 近期改动 | ✅ 热路径 | ❌ | ✅ 历史性能记录 |
| 新功能 | ⚪ | ✅ 现有模式 | ⚪ 选型时 | ✅ 项目约定 |
| 选型/架构 | ❌ | ✅ 现状 | ✅ 必须 | ✅ 过往决策 |
| 重构 | ✅ 为什么这么写 | ✅ 影响面 | ❌ | ✅ 设计意图 |
| "怎么用 X" | ❌ | ⚪ | ✅ 必须 | ⚪ |
| 解释代码 | ⚪ | ✅ | ❌ | ⚪ |

**不被锁定的机制就藏在这张表里：** 用户说"慢"，不直接钻进"慢"这个字，而是先归类成"性能诊断"，然后查这一类该查的**所有**方向——包括用户没提到的（比如查 git 看最近改动）。

**粒度问题（待定）：** 上面列了 7 类。是否够？太细？太粗？分类的边界如何处理（一个任务可能跨类型）？

---

## 3. 天枢现状勘查（已核实，代码引用）

用户消息进来 → 模型调用之前，现有的全部"理解"动作：

| 动作 | 文件 | 输出 | 用消息内容吗 |
|------|------|------|---------------|
| `extractTaskContract` | `src/context/task-contract.ts:109` | 目标文本 + 提到的文件 + 约束 | ✅ 但只做正则提取 |
| `isActionableTurn` | `src/context/task-contract.ts:179` | bool（是不是闲聊） | ✅ 长度/问候词 |
| `selectReasoningEffort` | `src/agent/auto-reasoning.ts:10` | off/low/medium/high/max | ✅ **唯一基于内容的分类** |
| `warmupMemories` | `src/agent/loop.ts:867` | 加载跨会话记忆 | ❌ 无条件全量加载 |
| `prewarmRecentReads` | `src/agent/loop.ts:553` | 重读上次的文件 | ❌ 基于历史不是意图 |
| Sensorium / StrategyProfile | `src/agent/sensorium.ts:42,262` | 6 维运行状态 → 操作策略 | ❌ 全部来自运行时信号 |
| StarPhase / Season | `src/agent/star-event.ts`, `cognitive-season.ts` | 阶段/季节 | ❌ 基于 agent 在做什么 |
| TurnIntentController | `src/agent/turn-intent.ts:32` | continue/veto/alternative | ⚪ 停/重规划闸门，不分类任务 |

### 关键结论

1. **现有所有"分类"都不是任务类型分类：**
   - `TaskContract.status`（exploring/planning/...）是**生命周期阶段**，不是任务类型。
   - `StrategyProfile` 是 agent 的**操作状态**（该多努力），不是任务是什么。
   - `StarPhase`/`Season` 是 agent **正在做什么**，由运行时信号驱动，不读消息内容。

2. **模型调用前没有任何 LLM 级的"这是什么任务"判断**——全是正则/启发式。

3. **检索完全是反应式的：**
   - `warmupMemories` 无条件全量加载（`loop.ts:867` → `physarum.loadFromDb()` / 免疫记忆 / 错题本）。
   - `prewarmRecentReads` 基于历史（重读上次 5 个 `read_file` 目标，`loop.ts:553`）。
   - 没有任何"这类任务该查 git / 该查外部 / 该查知识库"的**主动路由**。

4. **`selectReasoningEffort` 是最接近的同类物**（`auto-reasoning.ts`）：唯一读消息内容做分类的，但只是正则关键词匹配，且只输出"思考努力度"，不输出检索方向。

### 现有可复用的检索工具（都已存在，缺的只是路由）

- 知识库/记忆：`recall` 工具、`warmupMemories`、physarum/免疫/错题本
- git：`getGitInjectedContext`、`getGitChangeRate`（`loop.ts:932,1501`，但只喂 Sensorium，不驱动检索）
- 代码搜索：grep / glob / repo-map / inspect-project / related-tests 工具
- 外部：web fetch 类工具
- prewarm：`prewarmRecentReads`、`maybePrewarm`

---

## 4. 缺口的精确定位

天枢**已有**：提取目标/文件/约束、闲聊过滤、思考努力度分类、全部检索工具、记忆加载机制。

天枢**缺**的，正好是中间这一层：

> 一个 **意图 → 检索方向** 的路由判断。输入用户消息，输出"这个任务该查哪几个源"，然后驱动**已有**的检索工具主动去查，而不是等模型在 turn 里反应式地一个个调。

- **位置：** 在 `extractTaskContract` 之后、模型首次调用之前。
- **与 `selectReasoningEffort` 同类**（都读消息内容做判断），但：
  - `selectReasoningEffort` 输出"多努力" → 本功能输出"往哪查"。
  - `selectReasoningEffort` 用正则 → 本功能可能需要 LLM（要透过措辞看真实任务类型，不被关键词锁定）。

---

## 5. 需要单独考虑的设计决策点（待定）

### 决策 1：形态

- 选项 A：扩展 `TaskContract`，加一个 `retrievalPlan` 字段。
- 选项 B：独立的 preTurn hook（参考 `blind-exploration-hook` / `mcts-planning-hook` 的模式）。
- 权衡：A 复用现有 contract 提取入口、改动集中；B 解耦、可独立开关。

### 决策 2：判断方式（最关键）

- 选项 A：正则/关键词匹配（像 `auto-reasoning.ts` 那样）。快、0 延迟、便宜、可预测；但天然被措辞骗（用户说"慢"但其实想加监控），**这恰恰违背"不被关键词锁定"的初衷**。
- 选项 B：轻量 LLM 调用。准、能透过措辞看意图；但加一次往返延迟。
- 倾向（讨论中）：LLM 做分类，但 prompt 强制"先归类任务真实类型，再列该类型该查的所有源，包括用户没提的"。这恰好把反锚定落在"检索方向"这个小切面，一次调用搞定，不需要 MCTS。

### 决策 3：输出怎么用

- 选项 A：只注入提示给主模型（"建议你查这几个源"），由主模型自己决定调哪些工具。
- 选项 B：真的**主动触发**检索工具（路由器直接 fan-out 调 git/recall/grep），结果预填进上下文。
- 权衡：A 轻、不抢主模型的决策权；B 重、但真正实现"动手前已备好料"，也更省主模型的 turn。

### 决策 4：触发条件

- 是否每个 actionable turn 都跑？还是只在首轮（turn 1）？
- 闲聊 / 微小指令（"把 x 改成 count"）显然不需要——可复用 `isActionableTurn` 做门控。
- 是否需要可配置开关 + 默认关闭（参考 `AntiAnchoringConfig` 的保守接入模式）？

### 决策 5：与反锚定引擎的关系

- 现有 `AntiAnchoringConfig`（`src/agent/anti-anchoring-config.ts`，默认关闭）是重武器（MCTS 发散方案）。
- 本功能是轻路由（一次判断检索方向）。两者**正交**：一个管"往哪查"，一个管"想几个解"。
- 是否共用 `AnchorVault` 的关键词提取？还是完全独立？

### 决策 6：检索方向的粒度与表达

- 输出是布尔开关（git: yes/no）还是带优先级/具体查询（git: "查这个文件最近 5 次改动"）？
- 是否给每个方向附"为什么查"，便于主模型/用户理解路由依据？

---

## 6. 关联文档

| 文档 | 关系 |
|------|------|
| `docs/superpowers/plans/2026-05-31-anti-anchoring-engine-integration.md` | 反锚定引擎集成（重武器，本功能的"远亲"） |
| `docs/superpowers/specs/2026-05-31-ctm-anti-anchoring-research.md` | 反锚定理论根基（CTM/COCONUT/Pause/RAP） |
| `docs/sessions/2026-05-31-anti-anchoring-config-handoff.md` | 反锚定配置接入交接（保守开关模式可借鉴） |
| `/Users/banxia/app/rebook/Ebook-v1.0/docs/skills/causal-decoupling-engine-SKILL.md` | 因果解耦引擎（问题的同源抽象，他项目） |

### 涉及的天枢源文件（实现时会碰）

- `src/context/task-contract.ts` — 现有意图提取入口
- `src/agent/auto-reasoning.ts` — 最接近的同类分类器
- `src/agent/loop.ts` — turn 生命周期，插入点（`extractTaskContract` 后、模型调用前）
- `src/agent/create-runtime-hooks.ts` — preTurn hook 注册处（若走 hook 形态）
- `src/agent/anti-anchoring-config.ts` — 保守开关模式参考
- 检索工具：`recall` / git / grep / glob / repo-map / inspect-project

---

## 7. 下一步

设计单独讨论。建议依次定：**决策 2（判断方式）→ 决策 3（输出怎么用）→ 决策 1（形态）→ 其余**。判断方式定了，其它才有意义——因为它决定了这是个"正则小工具"还是"LLM 前置 turn"，两条路的工程量和接入点完全不同。
