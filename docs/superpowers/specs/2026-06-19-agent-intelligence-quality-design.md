# Agent 智能质量优化 — 深度头脑风暴

> 日期：2026-06-19
> 方法：deep-brainstorm 三轮（变异→选择→适应）+ 4 scout（代码审计 / 竞品调研 / 数据分析 / 反证审查）
> 状态：设计已定稿，待执行

---

## 背景

用户需求：Rivet agent 在实际编程任务中的智能质量优化——更准确的工具选择、更少的空转循环、更好的上下文管理。

项目上下文：Rivet 是终端 AI 编程代理，支持 DeepSeek V4/GLM 5.2，1M 上下文窗口，前缀缓存是核心成本优势。已有 20+ runtime hooks 做各种检测（vigor、convergence、kick、doom loop 等），但 agent 在长任务中仍频繁空转。

---

## Scout 调研摘要

### Scout 1：代码架构审计

| 子系统 | 状态 | 一句话 |
|--------|------|--------|
| 工具选择与调用 | 存在问题 + 有优化空间 | 执行层防护强，但工具选型引导偏静态、纠错偏事后 |
| 上下文管理 | 工作良好 + 有优化空间 | 前缀缓存设计成熟，但多层压缩 + 多通道注入信噪比难控 |
| 循环控制与收敛 | 工作良好 + 有优化空间 | 检测机制丰富且互相兜底，但干预多为软提示，模型可忽略 |
| 决策质量辅助 | 有优化空间 | Sensorium/Vigor 对 harness 参数有效，对模型行为间接且易被淹没 |
| 提示词工程 | 工作良好 | 前缀缓存友好度是项目强项；动态 appendix 槽位过多 |

Top 5 瓶颈：
1. 上下文信噪比：多通道注入 vs 有限 advisory 预算
2. 工具选型缺乏 proactive routing，纠错偏事后
3. 多层压缩导致 read→edit 工作流断裂
4. 软收敛干预对强模型仍 weak compliance
5. 认知子系统过多、有效链路过少

高有效性机制（应保留并强化）：doom loop blocked、cerebellar read-before-edit gate、RepairPipeline、convergence no-tool abort、PromptEngine prefix cache、Advisory Bus Top-3。

噪声/shadow 机制：`<search-breadth>`、effort bandit shadow、anchor-break/physarum shadow、virtue encouragement、songline/constellation/dream。

### Scout 2：竞品与前沿调研

Top 10 发现（按影响面排序）：

| # | 来源 | 核心机制 | 关系 | 复杂度 |
|---|------|----------|------|--------|
| 1 | Anthropic 上下文工程 | Write/Select/Compress/Isolate 四正交操作 | 可参考 | 中 |
| 2 | LoopGain | 控制论收敛检测 E(n)/E(n-1) | 可复用 | 低 |
| 3 | Aider 架构师模式 | 推理与编辑双阶段分离 | 需适配 | 中 |
| 4 | CacheWise | 编程代理专属 KV cache 管理 | 仅参考 | 高 |
| 5 | 三层循环检测 | Edit-count / Doom-loop / Iteration cap | 可复用 | 低 |
| 6 | Anthropic 工具设计 | "Do NOT use for" 负向描述显著减少误选 | 可直接复用 | 低 |
| 7 | SPIRAL | 三角色 MCTS 规划框架 | 仅参考 | 高 |
| 8 | ERL | 跨会话 trigger→action 启发式积累 | 可复用 | 中 |
| 9 | SWE-agent ACI | state_command 每步自动注入状态 | 需适配 | 中 |
| 10 | PreFlect | 执行前匹配已知错误模式修正 plan | 需适配 | 中 |

低挂果实：工具负向描述（#6）、checkpoint 注入、LoopGain 收敛检测（#2）。

### Scout 3：实际数据分析

真实会话异常模式：
- read→analyze 空转是实证高频痛点（convergence productiveRatio 修复 commit f3ecf591）
- 前缀缓存断裂与空转混淆（用户体感 stall 常与 cache miss 混淆）
- 多 hook 注入源去重不统一是已知痛点
- memory.jsonl ~201 条，信号与噪声并存

测试缺口：turn-orchestrator 无独立单测、memory-learning-hook 零测试、cross-session-hook 未接入 runtime。

### Scout 4：假设反证（隐含前提审查）

对原始假设"应把干预从建议升级为约束"的 8 个隐含前提：

| # | 前提 | 依赖度 | 如果不成立 |
|---|------|--------|-----------|
| 1 | 软干预失效主因是"模型不服从" | 高 | 实际是习惯化+截断+互斥——应修信号生命周期而非加硬约束 |
| 2 | "检测→行动转化率低"是主瓶颈 | 高 | 可能是检测精度/时机/模态选错——应先量化 |
| 3 | doom loop 成功可外推 | 高 | doom loop 是高度特化的——外推会导致误杀合法路径 |
| 4 | 限制工具子集提升能力 | 中 | 可能截断必要探索路径 |
| 5 | 20+ hooks 注入仍是噪声主因 | 中 | Bus 已半完成，剩余噪声在 Bus 管不到的平面 |
| 6 | 干预应在 runtime 做 | 中 | prompt 层路由已存在且可能已足够 |
| 7 | 目标漂移因缺 checkpoint | 中 | task-anchor / contract 已有 |
| 8 | 硬约束比软提示更可靠 | 高 | 非 LLM 行动链（mode switch/compact/vigor）可能更有效 |

关键纠偏：瓶颈不在"软→硬"，而在信号生命周期管理 + 非提示干预模态 + 度量闭环。

---

## 三轮思考过程

### 第一轮：变异

**生态位**：终端 AI 编程代理，1M 上下文窗口，前缀缓存核心优势，单用户工具循环。

**选择压力**：更少 turn 完成任务、不空转、不被注入噪声淹没。

| 方案 | 生态位 | 核心选择 |
|------|--------|----------|
| V1（主流）| 信号生命周期治理 | 不加新检测器，修现有信号的生命周期：抗习惯化、预算升级、注入去重统一 |
| V2（邻近）| 非提示干预升级 | 不靠"说话"，用结构性行动：auto mode switch / compact / effort 调制 / session split |
| V3（空位）| 干预效果度量闭环 | 不做新干预，只加度量：tag 每个干预，追踪后续行为变化 |
| V4（突变）| 工具 affordance 硬路由 | 根据阶段/sensorium 裁剪 tools schema 到 8-12 个，模型看不到不该用的工具 |

**创始假设检查**：原始假设隐含"问题出在运行时层"。实际上 static prompt 已有详尽工具规则、affordance 已做 Top-3 排序——prompt 层路由已存在但效果未量化。

**适应度函数**：
- 硬约束：不破前缀缓存、不增 LLM 调用、不误杀合法路径
- 加分：可量化、增量可交付、复利效应
- 减分：新增互斥逻辑、增加 hook 数、per-provider 适配

### 第二轮：选择

**目标重注入**：agent 在实际编程任务中用更少 turn 完成目标、减少空转和错误工具选择。

**因果压力测试**：

| 方案 | 因果链 | 结论 |
|------|--------|------|
| V1 | 信号习惯化/截断→模型看不到→行为不变→空转。FieldHabituation ~4 轮衰减有代码证据 | 通过 |
| V2 | 检测到空转→改变环境→模型自然调整。doom/plan mode/reliability 已验证 | 通过（需精确阶段检测） |
| V3 | 打 tag→统计→数据驱动。本身不直接改善质量 | 通过但收益延迟 |
| V4 | 裁剪 schema→选择空间缩小。阶段检测误判=截断能力 | 条件性成立 |

**灭绝**：
- V4 — 阶段检测精度未验证，误杀代价远大于空转。**灭绝特征回收**：工具负向描述（不裁剪 schema 但加 "Do NOT use for"）
- V3 单独实施 — 纯度量短期无交付物。**灭绝特征回收**：intervention tag + outcome tracking 嵌入 V1

**存活**：
- V1（信号生命周期）— 最强竞争者。成本最低、因果链最硬
- V2（非提示干预）— 存活但需 V1 先行

### 第三轮：适应

**套路清除**："统一到 Advisory Bus" 只管文本注入通道。真正要统一的是干预决策的优先级仲裁。

**扩展适应**：
- FieldHabituation → "信号旋转"：同语义换措辞延缓习惯化
- Advisory Top-3 → "干预预算统一"：kick/convergence/courage 也计入
- V4 灭绝特征 → 工具 "Do NOT use for" 负向描述
- V3 灭绝特征 → Advisory Bus schedule 时写遥测

**收敛验证**：V1 和 V2 收敛到同一洞察——干预的"到达率"比"数量"重要。一条高优先级、抗习惯化、非文本的干预，比五条同质 SR 注入有效得多。

**具体化**：
- 人：Rivet agent（DeepSeek V4 / GLM 5.2），在长编程任务中
- 场：agent 进入第 10+ 轮后空转，现有 kick/convergence 注入被习惯化或被 Top-3 截掉
- 动：迁移 inject 到 Bus + priority tier + 工具负向描述 + convergence L2 降 effort/收窄 breadth + 度量 tag
- 果：注入信噪比提升、空转检测后有结构性响应、工具误选率可追踪

---

## 最终方案

### Phase 1: Advisory Bus 统一收编 + Priority Tier (1-2 天)

**目标**：所有运行时注入走同一优先级仲裁，不再有"绕过 Bus 的特权通道"。

**改动 1 — 迁移 inject 到 Bus**

将以下 hook 的 `injectUserMessage` / `appendSystemReminder` 改为 `advisoryBus.schedule()`：
- `src/agent/hooks/kick-hook.ts` — 当前直接 `deps.injectUserMessage`
- `src/agent/hooks/courage-hook.ts` — 当前直接 `deps.appendSystemReminder`
- `src/agent/hooks/signal-consumer-hook.ts` — `<search-breadth>` / task decompose / dead-end 等

**改动 2 — Advisory Bus 加 priority tier**

`src/agent/advisory-bus.ts` 现有 `category` 限流（每类最多 2），加 `priority` 字段：
- `constitutional`（courage/cerebellar 类）— 永不被截断
- `operational`（convergence/kick/dead-end 类）— 正常参与 Top-3
- `informational`（virtue/playbook/skill 类）— 填充剩余槽位

Top-3 渲染规则改为："constitutional 全渲 + operational 按 freshness Top-N + informational 填空"

**改动 3 — convergence SR 也走 Bus**

`src/agent/loop.ts` 中 convergence L1/L2 的 `appendSystemReminder` 改为 `advisoryBus.schedule({ priority: 'operational', category: 'convergence', ... })`

**验收**：现有 advisory-bus 测试绿 + 新增 priority tier 表驱动测试 + typecheck

### Phase 2: 工具描述优化 + 非提示干预 (1-2 天)

**改动 4 — 工具 "Do NOT use for" 负向描述**

为 `src/tools/` 下 15+ 工具定义补充负向描述。重点：
- `grep` — "Do NOT use for reading entire files (use read_file instead)"
- `bash` — "Do NOT use for git operations (use git tool), file reading (use read_file), or file searching (use grep/glob)"
- `read_file` — "Do NOT use for searching keywords across files (use grep instead)"
- `glob` — "Do NOT use for reading file contents (use read_file)"
- `inspect_project` — "Do NOT use when you already know the file structure"

影响：tools schema 变化会影响前缀缓存——但 tools 定义在 system prompt 中 frozen，只在 session 首轮 miss 一次。

**改动 5 — convergence L2 触发非文本干预**

当 convergence-detector 返回 L2 时，除了 SR 注入，额外执行：
- `modulateStrategy` 降 reasoningEffort 一档（已有 vigor 先例）
- 连续 2 次 L2 时，降级 `explorationBreadth` 并收窄 `commitThreshold`，引导模型从探索转向收敛

**不触发 requestCompaction** — compact 会打碎整段前缀缓存（`shouldDelayCompact` 注释："compaction is expensive because it invalidates the entire prefix"），convergence L2 的触发时机远早于 86% 压力阈值，强制压缩在缓存热时得不偿失。

在 `src/agent/turn-orchestrator.ts` 或 `src/agent/loop.ts` 的 convergence 响应分支中实现。

**验收**：convergence 测试覆盖 L2 → strategy 调制路径 + typecheck

### Phase 3: 干预度量闭环 (1 天)

**改动 6 — Advisory Bus 写遥测**

`advisoryBus.schedule()` 时记录 `{ turn, category, priority, textHash }` 到 trace-store 或 session telemetry。

**改动 7 — postTool 行为变化追踪**

新增 lightweight postTool 检查：intervention 后 1-3 轮内的 tool name sequence 是否偏离 pre-intervention pattern（简单 Jaccard 相似度，不需 LLM）。结果写入 `.rivet/sessions/{id}/` 遥测目录。

**验收**：遥测写入测试 + 开销基准 < 1ms/turn

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| 前缀缓存命中率：Phase 2 改 tools schema 导致首次 miss | tools 在 frozen 区，只 miss 一次 |
| Advisory Bus 迁移副作用：inject 有隐式顺序依赖 | 先迁通道再改内容，保持同样文本 |
| convergence L2 降 effort 过早：合法长思考被抑制 | 仅降一档 + 连续 2 次才收窄 breadth，单次 L2 不改 breadth |
| 工具负向描述降低灵活性 | "Do NOT use for" 是建议不是硬限，模型仍可在必要时调用 |

---

## 下一步

Phase 1 第一个具体动作：把 `kick-hook.ts` 的 `deps.injectUserMessage(dissipativeKick)` 改为 `deps.advisoryBus.schedule({ category: 'kick', priority: 'operational', text: dissipativeKick })`。
