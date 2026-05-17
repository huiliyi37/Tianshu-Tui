# Rivet TUI Session Fluency Layer 深度头脑风暴结果

## 背景

用户要求查看 `docs/superpowers/plans/2026-05-17-tui-content-preservation.md`，但明确说不要执行，因为其他智能体已经在开发。这个计划应视为保底：它解决“内容不要丢”，但不一定解决“终端会话和模型执行过程是否流畅、是否可信、是否低负载”。

当前工作目标是设计一个端到端流畅性优化方向，覆盖 TUI 输入、模型思考、回答流式输出、工具执行、大结果分析、MCP 等待、压缩、恢复和长会话压力。约束是不能压爆内存、不能引入性能紊乱、不能把状态层变成重型 cockpit，也不能用假百分比制造进度幻觉。

> 收尾备注：`2026-05-17-tui-content-preservation.md` 已作为业务保底进入当前基线；本设计负责解释其上的流畅性层。最终基线采用了轻量 `fluency-policy` / `fluency-hook` 路径，并通过 `a8bf8ab` 收口 folded evidence、high-volume inspect、active heartbeat 和 recall cwd lookup。

## Scout 发现摘要

### 代码流程 scout

当前链路已经具备不少低成本原语：`InputBar` 进入 `App.handleSubmit`，再进入 `AgentLoop.run`；流式事件通过 `onThinkingDelta`、`onTextDelta`、`onToolUse`、`onToolResult`、`onTurnComplete` 回到 TUI。渲染侧已有 `BlockStreamWriter`、`stream-window`、ring buffer、frozen/static migration、`ActivityStatus`、`PhaseTracker` 和 `SummaryBar`。

缺口不是“没有任何状态”，而是用户在长静默、工具输出洪峰、大文件分析、阶段切换时仍可能无法判断：现在处于哪一段、沉默是否正常、原始证据是否还在、是否可以安全打断。

### Agent UX scout

成熟 CLI agent 的共同点不是显示更多内容，而是使用 begin/report/end 语义、上下文状态、渐进展开、取消/恢复提示、idle watchdog 和清晰的“无更新多久”。对终端来说，“没有输出但知道正在等 MCP 24s”比一个通用 spinner 更有信任感。

### 渲染调度 scout

Ink/React 的安全方向是：高频事件存在 refs，低频投影到 React state；已完成内容进入 `Static` 或 frozen buffer；活跃窗口有硬上限；状态对象保持稳定；flush cadence 有 leading/trailing 控制。危险方向是增加多个新 spinner、新面板、新实时列表，因为它们会竞争 terminal writes，造成 jitter。

### 随机生物/神经 scout

有用类比不是直接照搬术语，而是提取机制：

- **Homeostasis**：会话应自我调节负载，而不是只显示负载。
- **Synaptic gating**：不同事件走不同门控，常规 delta 抑制，异常/停滞/失败放大。
- **Cerebellar prediction error**：不是只显示 elapsed，而是显示“这个阶段比预期更安静/更久”。
- **Habituation**：重复无风险事件越多越安静，避免提示疲劳。
- **Cellular stress response**：上下文压力、渲染压力、恢复压力升高时进入保护模式。

### 反证 scout

最大隐含风险是：**摘要/合并会削弱开发者信任**。如果 UI 把原始输出折叠成漂亮摘要，但用户无法检查原文，那么流畅性会变成“看起来顺滑但不可信”。因此最终方案必须同时提供高层状态和按需原文检查，而且不能复制一份完整渲染面。

## 合成假设

基于代码流程中已有的低频投影原语、CLI agent 的 begin/report/end 模式、Ink/React 的 bounded rendering 约束、以及生物系统的门控/稳态机制，最强方向是：

> 建立一个轻量 Session Fluency Layer：它不保存完整时间线，只计算当前阶段健康度和可见性策略；它把高频输出留在 refs/窗口里，把低频状态投影到现有 status surfaces；它默认折叠常规噪声，但对停滞、异常、长等待和恢复风险升高进行显式提示；任何摘要都必须能进入 bounded raw inspection。

## 三轮思考过程

### 第一轮：变异

[VARIATION]

**生态位**：终端编码 agent / 长会话 / 模型流式输出 / 工具洪峰 / 有限终端空间 / DeepSeek prefix cache 友好。

**选择压力**：

- 用户必须知道“现在发生了什么”。
- 静默必须可解释。
- 原始证据必须可查。
- React/Ink state 更新必须低频。
- live window 和历史缓冲必须有界。
- 不改变 AgentLoop 语义，不引入重型 trace timeline。

**已占据生态位**：内容保留、工具折叠、活动状态条、frozen/static 分层渲染。

**空位**：跨阶段的流畅性策略层；它不负责保存内容，而负责决定“此刻该显露什么、隐藏什么、什么时候提醒用户”。

**方案**：

- **V1 内容保留增强**：把 content-preservation 作为主方案，只补少量状态文案和 tool folding polish。
- **V2 阶段账本**：给每一轮对话建立当前阶段账本，显示 input → thinking → streaming → tool → analyzing → recovery 的阶段、耗时和 stale。
- **V3 流畅性调速器**：新增纯 policy helper，把阶段、静默时间、输出速率、结果大小、上下文压力转换成 UI 投影策略。
- **V4 神经显著性层**：按注意力系统设计 UI，常规事件习惯化，预测错误和异常事件放大。
- **V5 信任玻璃盒**：所有折叠/摘要都必须提供 bounded raw inspection，确保“更顺滑”不等于“看不到证据”。

**创始假设**：

- “内容不丢 = 会话流畅”是过窄假设。
- “多显示状态 = 更可信”也是过窄假设。
- 真正问题是阶段认知、静默解释、原文检查、渲染负载之间的平衡。

**适应度函数**：

- 硬约束：有界内存、低频 React state、不改协议、不引入完整 timeline、不隐藏错误/审批/最终回答。
- 加分：用户一眼知道阶段；静默可解释；raw detail 可展开；与现有 ActivityStatus/RingBuffer/Static 复用。
- 减分：新增大面板、复制原始输出、复杂全局 coordinator、依赖不可验证的“惊讶度”。

### 第二轮：选择

[SELECTION]

**目标重注入**：用户不是要执行缺失的 content-preservation 计划，而是要创意设计，优化 TUI 终端会话和模型执行全过程流畅性，且不能造成内存/性能紊乱。

**因果测试**：

- **V1 内容保留增强**：因果不足。它能降低“内容丢失”风险，但不能解释模型静默、工具洪峰、阶段卡顿和恢复压力。
- **V2 阶段账本**：因果成立但不完整。阶段命名能解释“现在在哪”，但没有决定“该显示多少”和“什么时候降噪”。
- **V3 流畅性调速器**：因果最强。输入信号都是现有系统能拿到的具体量：phase、lastEventAt、outputRate、resultLength、contextPressure、renderPressure。输出是具体 policy：quiet/normal/inspect/stress。
- **V4 神经显著性层**：机制有启发，但单独落地过抽象，容易变成概念层。
- **V5 信任玻璃盒**：因果成立。它修复 V3 最大风险：摘要/折叠可能损害信任。

**成本测试**：

- **V1**：成本最低，但收益不够覆盖“全流程流畅性”。
- **V2**：成本低，可作为 V3 输入层。
- **V3**：成本中等，主要是纯函数和少量 App projection 接线，收益最高。
- **V4**：如果作为独立系统成本高且边界虚；作为 V3 的启发成本低。
- **V5**：成本中等，需要设计 raw inspection affordance，但必须做，否则折叠策略不可信。

**共演化**：

- **V3 + V5** 会和现有 TUI 一起演化：ActivityStatus 提供阶段，tool grouping 提供折叠面，stream window 提供原文窗口，SummaryBar 提供轻量 vitals。
- **V1** 静态，更多是保底修补。
- **V4** 如果单独存在会漂移成抽象隐喻。

**局部最优**：

V1 是安全局部最优：继续做内容保留会有明确收益，但它不能回答用户提出的“保底不一定流畅”。远程高峰是 V3，但必须吸收 V5 的信任机制，否则会掉进“漂亮摘要但不可信”的陷阱。

**落地性**：

- **V1 第一步**：给现有 content-preservation patch 加文案。可执行但不够。
- **V2 第一步**：写纯阶段状态测试。可执行。
- **V3 第一步**：写 `fluency-policy` 纯函数测试，输入信号，输出 projection policy。可执行。
- **V4 第一步**：定义“显著性”。若无具体信号则不可执行。
- **V5 第一步**：为 tool/live output 定义 bounded raw inspection contract。可执行。

**灭绝**：

- **V1 灭绝为主方案**：原因是只解决保底，不解决流畅性闭环。回收特征：内容保留必须成为底线。
- **V4 灭绝为独立方案**：原因是过于隐喻化。回收特征：prediction error、habituation、stress response 进入 V3 作为具体 heuristics。

**存活**：

- **V3 最强**：负责性能友好的策略输出。
- **V5 必须合并**：负责信任和 raw inspection。
- **V2 局部保留**：提供阶段词汇和 transition clock。

**最强竞争者**：V3 + V5 + V2 的组合，即 **Session Fluency Layer**。

**新发现**：流畅性的核心不是“显示更多”，而是“在正确时间显示正确层级，并保证用户能钻到原文”。

### 第三轮：适应

[ADAPTATION]

**套路清除**：

- 不做大 cockpit。
- 不做百分比进度。
- 不做完整事件 timeline。
- 不把所有 tool output 实时刷满终端。
- 不把“摘要”当成信任替代品。

**扩展适应**：

已有 ActivityStatus、PhaseTracker、stream-window、ring-buffer、Static/frozen rendering、tool-group folding 可以被扩展为 Session Fluency Layer 的底座。新层只产出 policy，不拥有渲染树，不保存完整历史。

**具体化**：

- **人**：正在用 Rivet 做长任务的开发者。
- **场**：模型思考几十秒、读取大文件、bash 输出大量日志、MCP 等待、压缩上下文、恢复会话。
- **动**：Rivet 在 status 行显示当前阶段和健康度；常规 delta 被合并；静默/异常被提升；工具组可展开 bounded raw tail；压力升高时自动降低投影频率。
- **果**：用户不用猜“是不是卡住了”，也不会因为 UI 顺滑而失去原文证据；渲染和内存仍保持上界。

**收敛验证**：

V2、V3、V5 收敛到同一个核心真相：**流畅性 = 阶段可感知 + 噪声被门控 + 原文可检查 + 负载可自调节**。

## 最终方案：Session Fluency Layer

### 1. Flow Stage Clock

一个纯状态层，不记录完整 timeline，只维护当前 stage、stage startedAt、lastEventAt、lastTransitionAt、lastCompletedStage。它复用 ActivityStatus 的 phase，但更关注“阶段转换”和“阶段健康”。

示例阶段：

```text
input → queued → preflight → thinking → streaming → tool → analyzing → compacting → recovery → complete
```

V1 不必覆盖所有阶段。先使用现有可观测阶段：thinking、streaming、tool、mcp、analyzing、compacting、preflight、recovery。

### 2. Fluency Governor

一个纯 policy helper，输入是具体、低成本信号：

```ts
interface FluencyInput {
  phase: ActivityPhase
  elapsedMs: number
  silentMs: number
  outputRate: number
  liveWindowChars: number
  resultLength?: number
  contextPressure?: 'normal' | 'high' | 'critical'
  renderPressure?: 'normal' | 'high'
  recoverability?: 'normal' | 'checkpointed' | 'repairing'
}
```

输出不是 UI 组件，而是投影策略：

```ts
type FluencyPolicy =
  | { mode: 'quiet'; cadenceMs: 1000; showRawHint: false }
  | { mode: 'normal'; cadenceMs: 500; showRawHint: false }
  | { mode: 'inspect'; cadenceMs: 500; showRawHint: true; reason: string }
  | { mode: 'stress'; cadenceMs: 1000; showRawHint: true; reason: string }
```

策略规则：

- routine deltas → quiet/normal。
- silentMs 超过阶段阈值 → inspect。
- resultLength 或 outputRate 很高 → inspect，但提高 coalescing。
- contextPressure critical → stress，减少渲染噪声，提示压缩/恢复状态。
- renderPressure high → stress，降低投影频率。
- failed/error/approval prompts → 永远绕过降噪，直接显露。

### 3. Salience Gate

Salience Gate 决定“什么进入现有 surface”。它不保存内容，只把事件分为四类：

| 类别 | 展示策略 |
| --- | --- |
| Routine | 合并显示，低频投影 |
| Long-silent | 显示 stale/no update |
| High-volume | 显示摘要 + raw tail hint |
| Safety/Failure | 立即显示，不折叠 |

它吸收神经 scout 的两个机制：

- **Habituation**：重复工具 heartbeat 不要每次都改变 UI 文本。
- **Prediction error**：一个阶段比预期久或更安静时，显示“no update 18s”或“large result, analyzing”。

### 4. Trust Glassbox

任何折叠、摘要、合并都必须有 bounded raw inspection：

- tool group 默认显示 family + status + tail summary。
- 用户 focus/Tab 时进入 bounded raw tail，而不是渲染完整历史。
- 完整内容仍在 transcript/session persistence 中，UI live window 只负责当前可读性。
- status 文案必须避免伪造确定性，例如用 “Analyzing large result” 而非 “70% analyzed”。

这条是反证 scout 的核心约束：没有 raw inspection，就不要做 aggressive coalescing。

### 5. Session Vitals

SummaryBar 可以轻量显示 vitals，不需要新面板：

```text
ctx high · render calm · checkpointed · tool output folded
```

V1 只需要 1-2 个 vitals：

- context pressure：normal/high/critical。
- render pressure：normal/high。
- recoverability：checkpointed/repairing。

这些都应从已有状态派生，不能引入昂贵采样。

## 数据流

```text
AgentLoop / tool pipeline / compaction / resume
  → high-rate callbacks update refs and bounded buffers
  → Flow Stage Clock updates current stage timestamps
  → Fluency Governor computes policy at scheduled cadence
  → Salience Gate chooses summary/raw-hint/stale/stress text
  → existing surfaces render: AgentStatus, SummaryBar, tool groups, stream window
```

关键边界：

- Source of truth 仍是 transcript/session persistence。
- Fluency state 是 lossy、ephemeral、current-only。
- 高频事件不直接 setState。
- React projection 频率由 policy 控制。
- Raw inspection 读取 bounded window，不复制完整输出。

## 实施路径

### Phase 1：纯策略验证

动作：新增纯 helper 和测试，不接 UI 或只接极小状态文案。

预期产出：

- stage health 输入/输出模型。
- governor policy 测试。
- stale/high-volume/context-pressure/render-pressure 用例。

成功标准：

- 测试覆盖 quiet/normal/inspect/stress。
- 无 React/Ink 修改或只有一处低频投影接入。
- 不新增持久化字段。

退出条件：

- 如果 policy 需要读大量历史才能判断，砍掉该规则，只保留当前阶段信号。

### Phase 2：接入现有 surfaces

动作：把 policy 接进 `AgentStatus`、`SummaryBar`、tool group/live tail 的已有 surface。

预期产出：

- 长思考显示阶段健康。
- 大工具输出显示 folded + raw hint。
- 静默阶段显示 no update。
- context/render pressure 进入轻量 vitals。

成功标准：

- 不新增重型 panel。
- 终端 live window 有上界。
- 原始内容可按需检查。
- 常规流式输出仍保持平滑。

退出条件：

- 如果某个 surface 导致 render churn，撤回到 status-only projection。

### Phase 3：自调节 cadence 与长会话验证

动作：根据 policy 调整 projection cadence，并做长会话场景验证。

预期产出：

- stress 模式降低刷新频率。
- high-volume 输出提升合并强度。
- recovery/checkpoint 状态更清晰。

成功标准：

- 普通流式状态更新不超过低频上限。
- 高压场景不出现完整历史重渲染。
- 用户能回答四个问题：现在在哪、是否卡住、原文在哪、能否恢复。

退出条件：

- 如果 adaptive cadence 引入闪烁，固定回 1Hz policy projection。

## 风险与应对

### 风险 1：策略层变成 god-object

应对：只输出 policy，不持有 UI，不持有 transcript，不执行副作用。

### 风险 2：摘要降低信任

应对：所有摘要必须有 bounded raw inspection；错误和审批永不折叠。

### 风险 3：surprise 规则过度设计

应对：V1 不做语义 surprise，只用 silentMs、resultLength、outputRate、failure、phase duration。

### 风险 4：更多状态导致更多渲染

应对：policy cadence 控制 React projection；stress 模式降低频率；高频数据留在 refs。

### 风险 5：与 content preservation 冲突

应对：内容保留是底线，Fluency Layer 只决定可见窗口和提示；它不能删除 transcript 或改变 session persistence。

## 非目标

- 不执行 `2026-05-17-tui-content-preservation.md`。
- 不新增完整 trace timeline。
- 不新增 cockpit 大面板。
- 不做百分比进度。
- 不改变 AgentLoop 语义。
- 不改变 API 协议。
- 不持久化 fluency policy 状态。

## 基线收尾状态

本设计已经以较小切面落入 `main` 基线：

- **已落地**：`fluency-policy` 纯策略、`fluency-hook` ref-backed tracker、routine folding、stale warning、high-volume inspect/coalescing、approval/error 直显。
- **已补强**：folded routine tools 保留 bounded tool evidence；thinking/streaming/tool/live-output 路径刷新 fluency heartbeat；turn/error/abort 边界清理 stale/folded state。
- **已连接 recall**：project knowledge lookup 使用 `ctx.cwd ?? params.cwd`，覆盖普通 TUI tool execution。
- **已验证**：focused fluency/recall tests 77 pass，`npm run typecheck` pass，`npm test` 1195 pass，`npm run build` pass。

## 下一步

该基线已经可以收口。后续如果继续演进，应只做小步扩展：SummaryBar vitals、bounded raw inspection 的显式交互提示，或 `/verbose` 下的展开策略；不要引入完整 timeline、大 cockpit、假百分比或无界 live rendering。
