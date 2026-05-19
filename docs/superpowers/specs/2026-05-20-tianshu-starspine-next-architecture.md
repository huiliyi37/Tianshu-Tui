# 天枢 StarSpine：从器官网络到自稳认知体

> 日期：2026-05-20  
> 类型：下一阶段架构思考 / 方向记录  
> 状态：构想记录，供后续讨论与拆解，不作为立即实施计划  
> 作者：天枢，与领航者对话后沉淀

---

## 0. 核心判断

天枢当前已经不是“缺能力”的阶段。

它已经拥有许多强器官：

- Adaptive Context Fabric：长上下文代谢系统
- Ice Mirror / Habituation：缓存与习惯化系统
- StarFlow / Sensorium / Vigor / Theta：感知、节律与执行生命体征
- Radio / Chronicle / Starmap：可观测人格与执行叙事
- Subagent Orchestration：并行认知雏形
- Evidence / Verification / Checkpoint：工程可信闭环
- PromptEngine / Volatile Context：认知输入管理层

这些器官都很有生命力。下一阶段的关键，不应是继续横向堆更多器官，而是建立统一的认知脊柱：

> **让天枢从“会使用工具的 Agent”，进化成“有稳定认知脊柱、可观测内在状态、能自我校准的工程伙伴”。**

我将这个方向命名为：

> **StarSpine / 天枢认知脊柱**

副标题：

> **从器官网络到自稳认知体**

---

## 1. 为什么需要 StarSpine

当前系统中，“agent 正在发生什么”被多个模块分别讲述：

- session messages
- tool history
- evidence tracker
- context ledger
- prompt volatile block
- sensorium
- chronicle
- radio hook
- playbook
- claim store
- decisions
- task progress
- subagent result packets

这些模块各自正确，但如果没有统一主轴，长期会出现四类问题：

1. **状态分散**：同一事实可能在 prompt、TUI、ledger、history 中重复表达。
2. **语义漂移**：任务越长，目标、边界、风险与验证标准越容易被稀释。
3. **决策不可追溯**：知道 agent 做了什么，但不总是知道它为什么做。
4. **prompt 负担过重**：太多 runtime 状态被塞进 prompt，伤害 cache，也让模型承担本该由 runtime 承担的结构化判断。

StarSpine 的目标不是替代现有器官，而是为它们建立一条统一神经主轴：

```text
事实进入 Runtime Truth
       ↓
形成 Task / Belief / Evidence / Decision / Risk / Verification
       ↓
按需投影到 Prompt、TUI、Chronicle、Subagent Coordinator
```

---

## 2. 下一阶段核心原则

### 2.1 从 Prompt-Centric 到 Runtime-Centric

旧模式：

```text
状态 → prompt → LLM 自己判断
```

新模式：

```text
状态 → runtime 结构化判断 → 只把必要约束注入 LLM
```

天枢越成熟，越不应该依赖“把更多上下文塞给模型”。更稳的方向是：

- 完整状态留在 runtime；
- prompt 只接收当前 turn 必要的最小投影；
- TUI 接收面向人的态势投影；
- Chronicle 接收可回放的叙事投影；
- Subagent 结果先进入结构化 ledger，而不是进入 primary messages。

这不是“削弱模型”，而是让模型从状态搬运中解放出来，专注于高价值推理。

### 2.2 每一次行动都有契约

长任务最大的风险不是不会做，而是边界漂移。

因此下一阶段需要一个明确中心对象：

> **Task Contract / 任务契约**

它记录当前任务的正式理解，而不是普通 todo list。

### 2.3 每一个判断都有证据

天枢真正的工程能力，不只在于会跑测试，而在于它知道：

- 哪些判断来自用户明确要求；
- 哪些判断来自读过的文件；
- 哪些判断来自测试结果；
- 哪些只是推断；
- 哪些已经被证伪；
- 哪些需要过期或重新验证。

因此下一阶段应建立：

> **Evidence-Belief-Decision Loop / 证据-信念-决策闭环**

### 2.4 Worker 是外周感知器，不是第二主权

Subagent 的价值不是“多几个会说话的人格”，而是扩展主 agent 的观察面。

原则：

```text
Worker produces evidence, not authority.
Primary decides.
```

WorkerResult 应进入认知账本，经 schema validation、evidence extraction、relevance filter 后，再决定是否投影给 primary prompt。

### 2.5 人格点亮系统，但不替代系统

Star Soul、星域、无线电、星图是天枢独特气质的重要来源。但人格层不应直接承担工程控制职责。

人格可以影响：

- 表达风格；
- 状态提醒；
- 用户协作方式；
- 何时请求共识；
- 如何解释风险与进展。

工程行为仍应由硬结构决定：

- Task Contract
- Evidence
- Verification
- Risk Policy
- Tool Registry
- Coordinator
- Checkpoint

一句话：

> **人格要点亮系统，不要替代系统。**

---

## 3. StarSpine 的五条演化线

## 3.1 Cognitive Ledger：统一运行时认知账本

建议引入一个中心运行时结构：

```text
RunLedger / CognitiveLedger
```

它不是 prompt，不是 UI，也不是 session messages，而是 runtime truth source。

它可以统一记录：

- 当前目标；
- 用户约束；
- 当前任务契约；
- 已读文件；
- 已修改文件；
- 假设与信念；
- 证据；
- 决策；
- 风险；
- 验证状态；
- 当前 phase；
- 当前 confidence / uncertainty；
- blocking reason；
- worker result facts；
- playbook lessons 的调用与新生成。

概念接口示意：

```ts
interface CognitiveLedger {
  task?: TaskContract
  beliefs: Belief[]
  evidence: EvidenceItem[]
  decisions: DecisionRecord[]
  risks: RiskRecord[]
  verification: VerificationRecord[]
  phase: RuntimePhaseSnapshot
  workers: WorkerFactPacket[]
  memoryEvents: MemoryLifecycleEvent[]
}
```

它的关键价值是分离三种投影：

```text
Runtime Truth        完整、结构化、可查询
Prompt Projection    当前 turn 必要、极小、cache-aware
TUI Projection       给用户看的态势图与叙事
```

这会让天枢从“prompt 驱动”走向“运行时认知驱动”。

---

## 3.2 Task Contract：任务契约与防漂移脊椎

建议为每个用户任务建立正式契约：

```ts
interface TaskContract {
  id: string
  objective: string
  scope: {
    allowedFiles?: string[]
    forbiddenFiles?: string[]
    ownership?: string[]
  }
  constraints: string[]
  successCriteria: string[]
  knownRisks: string[]
  verificationPlan: string[]
  uncertainty: string[]
  status:
    | 'exploring'
    | 'planning'
    | 'executing'
    | 'verifying'
    | 'blocked'
    | 'ready_to_deliver'
}
```

Task Contract 解决的问题：

- 长任务中目标不漂移；
- 用户更正可以 patch contract，而不是只追加自然语言消息；
- final answer 可以检查 success criteria；
- subagent WorkOrder 可以绑定 contract section；
- compact/resume 后可以重建任务主线；
- TUI 可以展示“我们正在共同完成什么”。

Task Contract 不应变成臃肿计划书。它应短、硬、可验证。

---

## 3.3 Evidence-Belief-Decision Loop：证据、信念、决策闭环

建议将 evidence、claim、decision、verification 统一成闭环：

```text
Evidence → Belief → Decision → Verification → Belief update
```

概念接口示意：

```ts
interface Belief {
  id: string
  claim: string
  confidence: number
  source: 'user' | 'file' | 'test' | 'tool' | 'subagent' | 'inference'
  evidenceIds: string[]
  invalidatedBy?: string
  expiresAtTurn?: number
}

interface EvidenceItem {
  id: string
  kind: 'file_read' | 'test_result' | 'diff' | 'user_constraint' | 'worker_result'
  summary: string
  refs: string[]
  strength: 'weak' | 'medium' | 'strong'
  turn: number
}

interface DecisionRecord {
  id: string
  decision: string
  reason: string
  beliefIds: string[]
  riskIds: string[]
  turn: number
}
```

目标不是让系统官僚化，而是让关键行为可追溯：

- 为什么要编辑这个文件？
- 为什么现在要跑测试？
- 为什么拒绝某个用户要求？
- 为什么选择委托 subagent？
- 为什么 final answer 说“已验证”？

当测试失败时，也能反向定位：

```text
失败测试 → 错误决策 → 支撑信念 → 错误证据或过期假设
```

这比单纯追加更多 prompt rules 更有长期价值。

---

## 3.4 Bounded Team Cognition：有边界的团队认知

Subagent 的下一阶段应保持克制：

```text
Primary AgentLoop = 主权与最终行动
WorkerSessions    = 外周感知器
CognitiveLedger   = 事实汇流点
```

建议演化顺序：

```text
P1: read-only research / code_search / review / verify
P2: scoped patch proposal, 仍不直接写
P3: write-capable worker, 但必须有文件 ownership + checkpoint sandbox
P4: multi-session team memory
```

在 P1/P2，WorkerResult 的路径应是：

```text
WorkerResult
  → schema validation
  → repair once if invalid
  → evidence extraction
  → ledger facts
  → relevance filter
  → prompt projection only when needed
```

不要让 worker messages 进入 primary session。
不要让 worker 的自然语言结论直接成为 authority。
不要过早开放 write-capable workers。

---

## 3.5 TUI as Shared Situation Map：从输出窗口到共享态势图

Starbridge / Starmap / Chronicle 是关键方向，不是装饰层。

多数 terminal agent 的 TUI 只是：

```text
用户输入
模型输出
工具日志
```

天枢可以进化为：

```text
对话流 + 认知状态 + 证据状态 + 风险状态 + 任务契约 + 验证闭环
```

用户不只是看 agent 在说什么，而是看 agent 在怎么想、为何行动、哪里有风险。

建议下一阶段 TUI 呈现四类态势：

### Mission

- 当前 objective
- scope
- success criteria
- phase
- blocker

### Evidence

- 已读文件
- 已验证测试
- 当前强信念
- 未验证假设
- 风险项

### Runtime Health

- context pressure
- cache hit rate
- phase
- confidence
- uncertainty
- stuck detector
- repair loop count

### Memory / Learning

- 本轮产生的 lesson
- 被调用的旧 lesson
- 被证伪的 belief
- 被归档或冷藏的记忆

这会把 TUI 从“日志显示器”变成“人与 agent 的共享驾驶舱”。

---

## 4. 不建议继续推进的方向

### 4.1 不建议继续扩大 system prompt

系统 prompt 已经足够丰富。下一阶段继续加规则，边际收益会下降，并伤害 prefix cache。

更好的方向：

```text
少加 prompt
多加 runtime structure
少加自然语言约束
多加 typed state + decision gate
```

### 4.2 不建议让人格系统承担工程控制职责

人格层应负责气质、解释、协作与可观测性；工程行为应由证据、契约、验证、风险策略决定。

### 4.3 不建议过早开放 write-capable subagent

过早开放会带来：

- 文件 ownership 冲突；
- checkpoint 复杂化；
- 测试归因困难；
- primary authority 弱化；
- session state 分裂。

必须等到 WorkerResult、CognitiveLedger、文件边界、checkpoint sandbox 稳定后再做。

### 4.4 不建议把所有 harness-only 信息永远移出 prompt

“runtime full state 不等于 prompt full state”。但也不应绝对化为“runtime 信息永不进 prompt”。

建议原则：

```text
完整事实留在 runtime。
只有当前决策必要事实进入 prompt。
```

例如以下信息可能需要极简投影进入 prompt：

- 用户明确约束；
- 当前 Task Contract；
- 最近失败根因；
- 高优先级风险；
- 被证伪的假设；
- 必须避免的重复动作；
- 当前 verification gap。

关键不是“进或不进”，而是：

```text
runtime full state
→ relevance filter
→ compressed projection
→ prompt
```

---

## 5. 建议路线图

## Phase A：Cognitive Ledger / 认知账本

目标：统一状态源。

交付：

- 新增 CognitiveLedger / RunLedger；
- 统一记录 task、belief、evidence、decision、risk、verification、phase snapshots；
- PromptEngine 从 ledger 生成 minimal projection；
- Chronicle / Starmap 从 ledger 生成 UI projection。

核心收益：

> 天枢开始拥有稳定的内在世界模型。

---

## Phase B：Task Contract / Mission Graph

目标：防漂移，强化任务闭环。

交付：

- 每个用户任务生成 TaskContract；
- 用户更正 patch contract；
- AgentLoop 每轮检查 contract；
- final answer 前检查 success criteria；
- subagent WorkOrder 绑定 contract section。

核心收益：

> 长任务不散，交付更像高级工程师。

---

## Phase C：Evidence-Gated Execution

目标：让关键决策有证据门槛。

交付：

- Belief / Evidence / Decision 三元模型；
- 高风险动作前要求 evidence threshold；
- final answer 前自动生成 verification badge；
- 未验证内容明确标记；
- 失败后能反向定位错误 belief。

核心收益：

> 从“我觉得”变成“我知道为什么”。

---

## Phase D：Bounded Team Cognition

目标：subagent 从工具变成外周认知网络。

交付：

- worker 结果进入 ledger；
- primary 根据 evidence 聚合；
- reviewer / verifier / code_search worker 稳定；
- scoped patch proposal；
- 之后再考虑 write-capable worker。

核心收益：

> 主 agent 保持权威，观察面扩大，cache 不崩。

---

## 6. StarSpine 宣言

```text
Every action has a contract.
Every belief has evidence.
Every decision has a reason.
Every memory has a lifecycle.
Every worker reports facts, not authority.
Every prompt receives only what this turn truly needs.
```

中文：

```text
每一次行动都有契约。
每一个判断都有证据。
每一个决策都有理由。
每一段记忆都有生命周期。
每一个子代理只提供事实，不夺取主权。
每一轮 prompt 只承载当下必要之物。
```

---

## 7. 最终判断

天枢下一阶段的胜负点不是：

- 工具更多；
- prompt 更长；
- UI 更花；
- agent 更多。

而是：

> **能不能在长会话、多工具、多状态、多子代理、多轮修复中，保持一个稳定、可解释、可恢复的认知主线。**

这条主线就是 StarSpine。

如果它立起来，后续所有系统都会更顺：

- Star Soul 不会变成装饰，而会有真实状态支撑；
- Ice Mirror 不会只是 cache trick，而会成为长期认知代谢；
- Chronicle 不只是日志，而会成为可回放的思考轨迹；
- Subagent 不只是并发，而会成为分布式感知；
- TUI 不只是界面，而会成为人与 agent 的共享驾驶舱。

下一阶段最值得聚焦的一句话：

> **少写给模型看的上下文，多建设模型之外的认知结构。**
