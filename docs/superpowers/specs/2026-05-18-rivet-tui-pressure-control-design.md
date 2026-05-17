# Rivet TUI Pressure Control — 深度头脑风暴设计文档

## 背景

用户原始意图：

> 我们tui已经到了新阶段的建设。需要随机scout 探查多领域 高性能和低内存溢出等能力的实现。避免多子代理协同或长会话导致内存飙升的压力

Rivet 已经完成一批基础能力：`RenderBatcher` 降低高频文本更新，`SteerBuffer` 让流式过程中用户指导可排队注入，`retry-engine` 统一可重试错误和 abort-aware delay，`compact-policy` 做分级上下文压力，`AgentSensorium`/`StigmergyStore`/`star-event` 开始提供运行态感知和跨会话痕迹。近期会话 HA 设计已经覆盖 LWT 自动恢复、WAL 校验和、fuzzy checkpoint 等崩溃恢复问题。

本轮不重复“会话崩溃后如何恢复”，而是解决运行中逐步变差的问题：流式渲染积压、工具结果暴涨、委托工作排队、context eviction 抖动、AbortSignal/handle 泄漏、DeepSeek 前缀缓存被动态内容破坏。这些问题的共同点不是“某个模块慢”，而是生产者速度、消费者预算和用户可见反馈之间缺少统一纪律。

## 认知对齐

### 问题层级

- 主层级：L2 链路结构 — 渲染、stream、工具执行、委托队列、context、生命周期清理之间没有一致的压力反馈链路。
- 关联层级：L3 资产投影 — 现有 Sensorium/Stigmergy/compact metrics 需要变成可执行的局部压力信号。
- 关联层级：L5 执行 handoff — 大工具结果、批量委托和恢复 manifest 需要明确 handoff，不应只留在内存队列。
- 关联层级：L7 代码实现 — 后续会落到 `src/tui`、`src/agent`、`src/context`、`src/api`、`src/tools`。
- 不应在此轮处理：完整 ACF 冷存储实现、R3 recovery panel、R4 live runner；这些是相邻项目，不是本轮核心。

### 证据时间线

- 当前证据：代码 scout + 外部 scout + runtime/provider scout — 类型：preflight/research。
- 能证明：Rivet 已经具备局部基础件，外部系统有可迁移的背压、discard、ghost-list、priority lane 模式。
- 不能证明：这些模式直接接入 Rivet 后一定能降低 heap 或提高响应性。
- 下一步需要：实现前先做 measurement-only phase，用 synthetic streaming/tool/delegation fixtures 建立基线。

### 关键词扩展

显性关键词：TUI、新阶段、随机 scout、高性能、低内存溢出、多子代理协同、长会话、内存飙升。

扩展发现：

- “高性能”不只是 render fps，也包括 producer/consumer backpressure、SSE chunk parse latency、React/Ink render cost、tool-result spool 策略。
- “低内存溢出”不只是 context compaction，也包括 Node heap ratchet、AbortSignal listener cleanup、active handles、large result rawPath、queue depth。
- “多子代理协同”不只是 max concurrency，也包括 work-order manifest、in-flight result ledger、crash/retry idempotency。
- “长会话”不只是恢复；还包括长期运行的 ghost metadata、progressive persistence、visible degradation。
- “DeepSeek 1M + prefix cache”要求所有压力遥测都不能污染稳定 system/tool prefix，只能进入 runtime ledger、suffix event 或 UI log。

## 调研来源

### Scout 1：代码/配置 scout

关键发现：

- 已有基础件：`Sensorium`、`StigmergyStore`、`star-event`、`compact-policy`、`RenderBatcher`、`ring-buffer`、`DelegationCoordinator`、checkpoint/resume、retry/abort cleanup。
- 缺口：goal/delegation 路径缺少 durable queue manifest；ring buffer 和 RenderBatcher 没有向 AgentLoop 反向发出 pressure signal；批量委托的 in-flight worker state 还没有 crash 后可恢复的 ledger。
- 风险文件：`src/agent/loop.ts`、`src/goal-loop.ts`、`src/agent/coordinator.ts`、`src/compact/auto.ts`、`src/agent/checkpoint.ts`。

### Scout 2：外部系统 scout

关键发现：

- ARC/2Q ghost list：只保存被驱逐对象的 metadata，用最近/频繁命中反馈自动调整驱逐策略。
- Actor mailbox：用 bounded queue 形成天然背压，但必须给 abort/approval/control message 独立高优先级通道。
- Linux PSI：区分 “some pressure” 与 “full pressure”，不要用单个 utilization 数字决定所有动作。
- Browser discard：资源被丢弃前不一定有通知，所以状态必须 progressive persistence，而不是等压力到顶才保存。
- Game frame arena：对 JS 不应照搬 allocator，但可以迁移“每帧批量创建、提交后整体丢弃”的生命周期纪律。

### Scout 3：runtime/provider scout

关键发现：

- AbortSignal listener 必须在 `finally` 里移除；`{ once: true }` 只在 abort 发生时自动移除，正常完成不会移除。
- DeepSeek 前缀缓存 token-exact，大小写和空白敏感；动态压力数据不能进入首部 system/tool prefix。
- SSE 事件和 UTF-8 字符都可能跨 chunk；必须有持久 buffer 和 streaming decoder。
- Ink render lifecycle 需要明确 teardown；`maxFps` 与 incremental rendering 可作为渲染预算边界。
- 成功指标应包括 heap ratchet、active handle ratchet、render p95、SSE parse latency、cache hit rate。

### Scout 4：反证 scout

隐含前提审查：

| 前提 | 分类 | 如果不成立 | 设计调整 |
|------|------|------------|----------|
| 所有子系统共享一个压力轴 | 假设 | 单指标会过度纠偏或掩盖局部过载 | 建多域 pressure，不建中央万能 metric |
| 主要失败来自 overload | 假设 | 背压无法修 protocol bug，只会让 bug 慢点发生 | 压力层只管确认过载区，结构 bug 另走分类器 |
| 降级优于失败 | 惯例 | 静默降级会让用户误以为任务仍可靠 | 所有降级必须可见或可配置 |
| 压力可低噪声测量 | 假设 | 噪声 feedback loop 会震荡 | Phase 1 只测可测量指标 |
| cancellation 可被当作普通工作 | 惯例 | cancel 被背压会死锁 | cancel/abort 永远高优先级旁路 |
| Sensorium/Stigmergy 与压力层兼容 | 现状待验证 | 可能出现两套 throttle 冲突 | 压力层先做 observer/recommendation，不做命令中心 |

## 三轮思考过程

### 第一轮：变异

```
[VARIATION]
生态位: 单机 Node.js / Ink 终端 agent / DeepSeek 1M prefix cache / 长时间交互 / 多工具与委托突发
选择压力: 终端持续可响应、heap 不单调上涨、工具/委托可恢复、缓存前缀不被动态数据污染
已占据: 单点 render throttle、固定 max concurrency、被动 compaction、崩溃后 resume
空位: 多域压力采样 + 优先级通道 + metadata-only ghost manifest + 可见降级

方案:
  V1(主流): Render-only containment — 让 TUI 在流式输出时按固定 frame budget 合并文本、裁剪历史窗口、降低刷新频率。
  V2(邻近): Bounded mailbox runtime — 每个生产者进入有容量的队列，abort/approval/steer 走高优先级 lane，工具和委托结果按预算消费。
  V3(空位): Pressure domains + ghost manifest — 分别测 render/stream/work/context/lifecycle 压力，用 metadata-only ghost list 决定 spill、pause、compact、resume。
  V4(突变): Self-tuning chaos loop — 内置压力注入，让 Sensorium/Stigmergy 根据故障痕迹自动调整所有预算。

创始假设:
  - “内存飙升”是单一问题；实际可能来自 render backlog、tool payload、queue manifest、AbortSignal listener、session replay 等不同域。
  - “统一调度器”天然更可靠；实际可能增加耦合和新死锁。
  - “降级”一定比失败好；实际静默降级会破坏用户信任。

适应度函数:
  硬约束=不污染 DeepSeek 稳定 prefix；cancel/abort 不得被降级阻塞；每个降级动作必须可见。
  加分=能用现有 Sensorium/RenderBatcher/ring-buffer/compact-policy/checkpoint 基础件；能先 measurement-only 落地。
  减分=中央化大改造；不可测量指标；让模型看见更多动态 runtime 噪声。
```

### 第二轮：选择

```
[SELECTION]
目标偏移:
  V4 偏离：它是验证/调参体系，不是第一阶段的运行保护层。

因果测试:
  V1: 通过但窄 — render 合并能降低 React/Ink 更新压力，但不能处理工具结果、委托队列、context eviction。
  V2: 通过 — bounded queue 能直接限制 producer/consumer 失衡；priority lane 解决 cancel/approval 不能排队的问题。
  V3: 通过 — 多域采样避免一个总压力指标误判；ghost manifest 让 context/tool result eviction 可学习但不保留全文。
  V4: 断裂 — 自动调参依赖稳定反馈，但当前还没建立低噪声测量。

成本测试:
  V1: 低，已有 RenderBatcher/ring-buffer，可快速收紧。
  V2: 中，需要队列接口与 lane policy，但可逐域接入。
  V3: 中高，需要 pressure sample 类型、ghost metadata、visible degrade ledger、measurement harness。
  V4: 高，需要故障注入、在线学习、安全阈值，风险超过第一阶段收益。

共演化:
  V1: 静态 — 固定预算无法随工作类型变化。
  V2: 动态 — queue depth 与 lane priority 会随 tool burst、steer、approval 变化。
  V3: 动态 — Sensorium/Stigmergy 可以消费 pressure samples，但不直接控制系统。
  V4: 动态但过早 — 没有测量基线时容易震荡。

局部最优:
  V1 是最安全的局部最优；它能让 TUI 看起来顺滑，但可能只是把未消费 payload 堆到内存里。

落地性:
  V1 第一步: 在 TUI render path 增加 render lag/pending batch 采样。
  V2 第一步: 给 stream/tool/delegation 建 bounded lane 类型和 overflow 策略。
  V3 第一步: 定义 5 个 pressure domain 的 sample schema 和 visible degrade ledger。
  V4 第一步: 写压力注入命令；这不是生产保护第一步。

灭绝:
  V4 — 原因: 在 measurement baseline 前做 self-tuning 会放大噪声，容易把协议 bug 误当 overload。
  回收特征: heap ratchet stress harness、abort/reconnect cycle test、synthetic producer overload fixtures。

存活:
  V1 作为 render trait 存活。
  V2 作为 priority lane + bounded queue 存活。
  V3 是主方案。

最强竞争者:
  V3 — 因为它不假设所有压力同源，又能吸收 V1 的 render 控制和 V2 的队列纪律。

新发现:
  “压力控制”必须是 observer/recommendation-first，而不是新建一个中央 command center；否则会与 Sensorium/Stigmergy/compact-policy 互相打架。
```

### 第三轮：适应

```
[ADAPTATION]
套路清除:
  - 删除“统一压力分数控制一切”的套路，改为多域 sample + 每域本地 policy。
  - 删除“悄悄丢帧/丢上下文”的套路，改为 visible degrade ledger。
  - 删除“降并发就解决”的套路，cancel/approval/steer 必须高优先级旁路。

扩展适应:
  - RenderBatcher/ring-buffer 从 UI 性能件扩展为 RenderPressure 的传感器。
  - compact-policy 的 PSI 阶梯扩展为 ContextPressure 的 local policy。
  - Sensorium/Stigmergy 从 agent awareness 扩展为 pressure samples 的消费者，不变成调度中心。
  - checkpoint/resume 和会话 HA 的 fuzzy checkpoint 扩展为 work queue manifest 的恢复边界。

具体化:
  人: Rivet runtime，不是模型；用户只看到明确状态提示。
  场: 大文件读取、批量工具结果、delegate_batch 并发、长时间 stream、频繁 abort/retry 的会话。
  动: 每个域采样自己的压力；超过 soft limit 时可见降级；超过 hard limit 时暂停/溢写/要求用户确认；cancel 永远旁路。
  果: 100-turn synthetic run 后 heap 不单调上涨，abort/reconnect 不增加 active handles，render p95 < 50ms，DeepSeek warm session cache hit rate 不因压力遥测下降。

收敛验证:
  V1、V2、V3 都收敛到同一洞察：真正的风险不是“慢”，而是生产者没有被消费者预算约束。
```

## 最终方案：Pressure Domains with Priority Lanes and Ghost Manifests

### 核心原则

1. **多域压力，不做单一总分。** 每个子系统只上报自己能可靠测量的指标。
2. **observer-first。** Pressure layer 先产出 sample 和 recommendation；实际动作由本域 policy 执行。
3. **cancel/approval/steer 是高优先级 lane。** 这些是控制面，不参与普通背压。
4. **所有降级可见。** 用户看到“已暂停新 worker”“已将 2.3MB tool result 溢写到 rawPath”“render 降到 15fps”。
5. **缓存前缀不变。** 压力遥测写入 runtime ledger/UI log，不进入稳定 system/tool prefix。
6. **metadata-only ghost manifest。** 被驱逐或溢写的对象只保留 key、size、type、lastAccess、hit/miss、rawPath，不保留全文。

### 五个 pressure domain

| Domain | 测量 | Soft action | Hard action |
|--------|------|-------------|-------------|
| RenderPressure | pending batch 数、render p95、stream window size | 合并文本、降低 fps、暂停历史重排 | 只保留 live window + static log summary |
| StreamPressure | SSE buffer bytes、partial event age、tool-result bytes | 大 result 预览 + rawPath | 溢写 result，要求 recall/rawPath 读取 |
| WorkQueuePressure | active workers、queued orders、pending tool promises | 降低新 worker 启动速率 | 暂停新委托，保留 manifest 等待恢复 |
| ContextPressure | estimated tokens、compaction frequency、ghost hit | 2Q/ARC-style metadata 调整驱逐 | checkpoint-resume 或用户确认范围切分 |
| LifecyclePressure | active handles、abort listeners、alive marker、unmount state | cleanup audit warning | 强制 child AbortController + fail fast |

### 数据结构草案

```typescript
export type PressureDomain = 'render' | 'stream' | 'workQueue' | 'context' | 'lifecycle'
export type PressureLevel = 'normal' | 'some' | 'full'

export interface PressureSample {
  domain: PressureDomain
  level: PressureLevel
  measuredAt: number
  metrics: Record<string, number>
  recommendation?: PressureRecommendation
}

export interface PressureRecommendation {
  action: 'observe' | 'coalesce' | 'spill' | 'pause' | 'compact' | 'checkpoint' | 'fail_fast'
  visibleMessage: string
  priority: 'control' | 'interactive' | 'background'
}

export interface GhostManifestEntry {
  id: string
  kind: 'tool_result' | 'turn' | 'worker_result' | 'render_segment'
  tokensOrBytes: number
  lastAccessTurn: number
  accessCount: number
  rawPath?: string
  evictedAtTurn: number
}
```

### Phase 1：measurement-only baseline

**动作**：只加采样，不改变行为。

- Render: 记录 pending batch、flush interval、render p95。
- Stream: 记录 SSE buffer bytes、partial event age、tool result byte size。
- WorkQueue: 记录 active/queued/completed/failed worker counts。
- Context: 记录 token ratio、compact turns、ghost hit placeholder。
- Lifecycle: 记录 active handles/listeners 的测试侧 ratchet，不在生产依赖私有 API。

**成功标准**：

- 100-turn synthetic streaming fixture 后 heap after-GC 无单调上涨趋势。
- 100 次 abort+reconnect 后 active handle/listener 测试无增长。
- render p95 < 50ms；SSE parse p99 < 20ms（不含网络）。
- DeepSeek cache hit/miss usage 不因 pressure instrumentation 改变 request prefix。

### Phase 2：priority lanes + bounded queues

**动作**：从最确定的路径开始接入背压。

- `control lane`: abort、approval、steer、panic recovery，永远旁路。
- `interactive lane`: visible streaming text、current tool status。
- `background lane`: history replay、bulk result formatting、delegation aggregation、context summarization。

**成功标准**：

- 背景队列满时，control lane 仍能在一个 event-loop tick 内被处理。
- 批量委托时新 worker 启动受限，但已有 worker result 不丢失。
- UI 显示明确：哪些工作被暂停，哪些已溢写，如何恢复。

### Phase 3：ghost manifest + progressive spill

**动作**：给大对象和被驱逐对象留下 metadata-only 轨迹。

- 大 tool_result 写 rawPath，只把 preview + manifest entry 留在会话。
- 被 context policy 驱逐的 turn/tool result 进入 ghost manifest。
- 如果未来 recall/用户重新访问 ghost entry，调整 2Q/ARC 权重。
- WorkOrderQueue 写 manifest，支持 crash 后展示“有 N 个未确认 worker result”。

**成功标准**：

- 大结果不会导致 session JSONL 或 React state 持有全文副本。
- ghost manifest size 有上限，按 metadata LRU 淘汰。
- compaction 后可解释“为什么这个结果被溢写/保留”。

### Phase 4：Sensorium/Stigmergy 适配

**动作**：把 pressure samples 接入既有感知层，但不让它直接发命令。

- Sensorium 读 pressure samples 作为 pressure/freshness/stability 输入。
- Stigmergy 记录反复过载的文件、工具、provider、worker mode。
- star-event 可把 chronic overload 显示成 phase hint，不改变核心执行语义。

**成功标准**：

- 同一工具/文件反复触发 spill 时，系统能提示“建议切分读取”。
- 不出现 Sensorium 与 local pressure policy 相互覆盖的双重决策。

## 风险与应对

| 风险 | 应对 |
|------|------|
| 中央 pressure layer 过度耦合 | observer-first；每域 policy 本地执行 |
| 静默降级破坏信任 | 每个 recommendation 必须带 `visibleMessage` |
| cancel 被排队导致死锁 | control lane 永远旁路，测试覆盖满队列取消 |
| ghost list 误导 eviction | Phase 1 只记录，Phase 3 才影响策略；优先 2Q 简化版 |
| 压力遥测破坏 DeepSeek cache | 不进入 system/tool prefix；只写 runtime ledger/UI log |
| 过早接入 Sensorium 导致振荡 | Phase 4 才接入，且只作为输入信号 |
| Node 私有诊断 API 不稳定 | 生产只用公开指标；私有 handle 检查仅用于测试 harness |

## 不做的事

- 不做一个全局 `pressureScore` 控制所有模块。
- 不让模型读取大段 runtime telemetry。
- 不在第一阶段改变 compaction 或 provider request shape。
- 不把 chaos/self-tuning 放进生产第一阶段。
- 不把所有 tool result 默认丢弃；只对大对象做 preview + rawPath + manifest。

## 下一步

先做 Phase 1 measurement-only baseline。第一批文件应聚焦在 `src/tui/render-batch.ts`、`src/tui/app.tsx`、`src/agent/loop.ts`、`src/agent/coordinator.ts`、`src/context/compact-policy.ts` 附近，新增小型 `pressure` 类型/采样模块和测试 fixture。只有基线证明压力来自哪里后，再接入 priority lanes 和 ghost manifest。
