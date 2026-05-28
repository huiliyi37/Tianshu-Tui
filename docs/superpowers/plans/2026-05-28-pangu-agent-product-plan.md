# Plan: 盘古 Agent — 多模型协作编码智能体

> Status: **deferred / not in current scope** | Priority: none | Est. complexity: high
> Date: 2026-05-28 | Domain: 天枢 (演化测试设想)
> 实验模型: MiMo-v2.5-Pro (大量 token 可用)
> Decision: 仅作为天枢演化测试与概念压力测试材料保留；当前不处理、不启动实现、不进入执行队列。

## 当前处理结论

盘古 Agent 设计先标记为**不处理 / 暂缓**。

这是天枢随手拿来做演化、产品化想象与测试校准的设想材料；即使后续被证明有潜力，也**不是当前阶段要做的工作**。除非后续另有明确任务指令，本文件不得被当作 P0 执行计划、不得据此创建 `/Users/banxia/app/pangu-agent/`，也不得启动模块提取或产品化实现。

同类概念型探索（如伏羲、夸父等）默认也按“演化设想 / 测试材料”处理：可用于讨论、对照、压力测试与方法论校准，但不自动进入实现队列。

## 背景

天枢已验证：多模型异步协作（GPT plan → GLM fix → GPT execute）在共享 worktree 上零冲突完成复杂工程任务。现在要把这个能力产品化为一个独立的开源编码 agent，定位：

**第一个让多个开源模型在各自认知域协作完成编码任务的终端产品。**

与 Hermes Agent (170K stars, 全能助手) 和 OpenClaw (375K stars, 个人助手) 的区别：
- 它们是"什么都能做"，我们是"编码领域深度优化"
- 它们是单模型 + 多渠道，我们是多模型 + 认知运行时
- 它们的差异化在工具/渠道数量，我们的差异化在运行时质量

## 核心差异化（三个已验证能力）

1. **多模型异构协作** — 不同模型做不同认知任务（plan/implement/review/test）
2. **认知运行时防退化** — RuntimeHookPipeline + prefix cache 让长会话不降级
3. **成本优势** — prefix cache 90%+ hit rate，比 Claude Code 便宜 6x

## 实验策略：MiMo-v2.5-Pro 作为主力

MiMo 在天枢中已完全集成：
- Provider: `mimo`, model: `mimo-v2.5-pro`
- Context: 1M, thinking: enabled, prefix cache: deepseek-native
- 大量 token 可用 → 用于验证产品化过程中的所有构建和测试

MiMo 的角色：
- Phase 1: 作为单模型验证 agent loop 的完整性
- Phase 2: 作为多模型协作中的"破军"角色（先锋探路 + 代码实现）
- 持续: 评估 MiMo 在不同 WorkerProfile 下的 capability card 数据

---

## Phase 1: 单模型编码 Agent MVP (2 周)

### 目标
从天枢代码中提取核心模块，构建一个可独立运行的终端编码 agent。
用 MiMo-v2.5-Pro 作为默认模型验证全链路。

### T1.1: 项目脚手架 (Day 1-2)

**动作**：
- 在 `/Users/banxia/app/` 下创建新 repo `pangu-agent`
- 初始化 Node.js 22 + TypeScript strict + ESM
- 从天枢复制核心模块（不是 fork，是选择性提取）

**提取清单**（按依赖顺序）：

| 模块 | 源路径 | 改动 |
|------|--------|------|
| API types | `src/api/types.ts` | 原样 |
| StreamClient interface | `src/api/stream-client.ts` | 原样 |
| OpenAIClient | `src/api/openai-client.ts` | 删除 codex 特殊逻辑 |
| Error classifier | `src/api/error-classifier.ts` | 原样 |
| Tool types | `src/tools/types.ts` | 简化 |
| Tool registry | `src/tools/registry.ts` | 原样 |
| Core tools | `src/tools/{bash,read-file,edit-file,write-file,grep,glob}.ts` | 剥离 TUI 依赖 |
| RuntimeHookPipeline | `src/agent/runtime-hooks.ts` | 原样 |
| Provider profile | `src/api/provider-profile.ts` | 原样 |
| Config schema | `src/config/schema.ts` | 简化为最小集 |

**不提取**：
- TUI (Ink 6) — 用简单的 readline 或 stdin/stdout
- Star domain 文档 — 产品不需要哲学内容
- Sensorium/Stigmergy — Phase 2 再考虑
- Ownership ledger — Phase 2 多模型时才需要

**成功标准**：`npm run typecheck` 通过，0 个天枢特有依赖

### T1.2: 最小 Agent Loop (Day 3-5)

**动作**：
- 实现简化版 agent loop：`user input → build messages → call API → parse tool calls → execute → loop`
- 3 个核心 hook 接入：perception（检测退化）、vigor（控制节奏）、dream（会话结束总结）
- System prompt 设计：简洁、cache-friendly、无星域内容

**关键设计决策**：
- Message 结构保持 prefix cache 友好（system prompt 不变 + 前 2 条 anchor 不变）
- Tool result 格式与 OpenAI function calling 兼容
- 错误重试走 error-classifier 的结构化策略

**成功标准**：
```bash
echo "list files in src/" | pangu --model mimo-pro
# → 调用 bash tool → 返回文件列表 → 正确显示
```

### T1.3: CLI 入口 + 交互模式 (Day 6-7)

**动作**：
- `pangu` CLI 入口（单文件，用 `node:readline`）
- 支持：`pangu "one-shot task"` 和 `pangu` (交互模式)
- `--model` 参数切换模型（默认 mimo-pro）
- `--verbose` 显示 tool calls 和 token usage

**成功标准**：
```bash
pangu --model mimo-pro "explain the architecture of this project"
# → 读取关键文件 → 输出架构说明
```

### T1.4: Prefix Cache 验证 (Day 8-9)

**动作**：
- 接入 MiMo 的 prefix cache（已有 `deepseek-native` 配置）
- 在 5 轮对话后检查 cache hit rate
- 对比：有 cache vs 无 cache 的 token 成本

**成功标准**：5 轮对话后 cache hit rate > 70%

### T1.5: 认知运行时基线验证 (Day 10-14)

**动作**：
- 设计一个"退化检测实验"：让 MiMo 在 pangu 中完成一个 10 轮的编码任务
- 对比：有 perception hook（检测退化并注入提醒）vs 无 hook
- 记录：每轮的 tool call 成功率、代码质量（typecheck pass/fail）、重复行为

**成功标准**：
- 有 hook 时 10 轮后 tool call 成功率 > 90%
- 无 hook 时观察到可测量的退化（成功率下降 > 15%）
- 这就是"80 to 200"的第一个量化证据

**MiMo 能力评估输出**：
- MiMo-v2.5-Pro 的 ModelCapabilityCard 实测数据
- toolUseReliability / jsonStability / editSuccessRate / testRepairRate 各项分数

---

## Phase 2: 多模型协作 MVP (2 周)

### 前置条件
- Phase 1 完成，单模型 agent 可用
- MiMo capability card 数据已收集

### T2.1: Coordinator 提取 + 简化 (Day 1-3)

**动作**：
- 从天枢提取 coordinator.ts + work-order.ts + capability.ts
- 简化 WorkOrderKind 为 3 种：`plan` / `implement` / `review`
- 简化 WorkerProfile 为 3 种：`planner` / `coder` / `reviewer`
- 暂不提取 worktree isolation（Phase 2.3 再加）

**成功标准**：coordinator 能接收 DelegationRequest 并路由到正确模型

### T2.2: 多模型路由配置 (Day 4-5)

**动作**：
- 配置文件支持多模型：
```yaml
models:
  planner: mimo-pro      # MiMo 做规划（thinking 能力强）
  coder: mimo-pro        # MiMo 做实现（大量 token 可用）
  reviewer: mimo-pro     # 先用同一模型验证流程
routing:
  plan: planner
  implement: coder
  review: reviewer
```
- 先用 MiMo 填充所有角色验证流程正确性
- 后续加入 DeepSeek V4 / GLM 做异构对比

**成功标准**：`pangu team "fix bug X"` 能自动拆分为 plan → implement → review 三步

### T2.3: Worktree 隔离 (Day 6-8)

**动作**：
- 提取 WorktreeCoordinator
- 每个 write worker 在独立 worktree 中执行
- 完成后自动 merge 回主分支

**成功标准**：两个 worker 同时写不同文件，无冲突合并

### T2.4: 多模型异构实验 (Day 9-12)

**动作**：
- 引入第二个模型（DeepSeek V4 或 GLM，取决于可用 token）
- 实验设计：
  - 任务：修复一个真实 bug（从天枢的 issue 中选）
  - A 组：MiMo 单模型完成全部
  - B 组：MiMo plan + MiMo implement + MiMo review（同模型多角色）
  - C 组：Model-A plan + MiMo implement + Model-B review（异构）
- 记录：完成时间、token 成本、代码质量（测试通过率）

**成功标准**：B 组或 C 组在质量或成本上优于 A 组

### T2.5: 用户体验打磨 (Day 13-14)

**动作**：
- `pangu team` 命令的输出格式：显示每个 worker 的进度和结果
- 错误恢复：某个 worker 失败时自动重试或降级
- 最终 demo：录制一个 3 分钟的 asciinema 演示

**成功标准**：一个完整的 `pangu team "task"` 从开始到 commit 的流畅演示

---

## Phase 3: 开源发布 + 量化验证 (持续)

### T3.1: 开源准备
- README.md（英文为主，中文简介）
- MIT 协议
- 安装：`npm install -g pangu-agent`
- 最小配置：只需要一个 API key

### T3.2: SWE-bench 子集验证
- 选 20 个 SWE-bench-lite 任务
- 对比：pangu+MiMo vs Aider+MiMo vs 裸 MiMo API
- 发布结果

### T3.3: 社区增长
- 目标：发布后 1 个月 500+ stars
- 策略：在 DeepSeek 社区、MiMo 社区发布（"让你的开源模型更强"）

---

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| MiMo tool calling 不稳定 | 中 | 高 | 收集 capability card 数据，如果 toolUseReliability < 0.7 则降级为 planner-only |
| 提取天枢代码耦合太深 | 中 | 中 | 设置 2 天 deadline，超时则从头写 minimal loop |
| 多模型协调 overhead > 收益 | 低 | 高 | Phase 2 实验设计包含 A/B 对比，数据说话 |
| prefix cache 在 MiMo 上 hit rate 低 | 低 | 中 | MiMo 用 deepseek-native cache，理论上应该高；如果低则调整 prompt 结构 |

---

## MiMo 能力评估矩阵（Phase 1 产出）

在 Phase 1 结束时，填充以下数据：

```typescript
const mimoCapabilityCard: ModelCapabilityCard = {
  model: 'mimo-v2.5-pro',
  toolUseReliability: ?, // 10 轮任务中 tool call 格式正确率
  jsonStability: ?,      // JSON 输出格式一致性
  editSuccessRate: ?,    // edit_file 操作后 typecheck 通过率
  testRepairRate: ?,     // 给定失败测试，修复成功率
  contextWindow: 1_000_000,
  cacheEconomics: 'strong', // deepseek-native prefix cache
  recommendedTasks: [],  // 根据实测数据填充
}
```

这个数据直接决定 Phase 2 中 MiMo 被分配到哪些 WorkerProfile。

---

## 执行顺序

```
Week 1: T1.1 → T1.2 → T1.3 (可用的单模型 CLI)
Week 2: T1.4 → T1.5 (cache 验证 + 认知运行时基线)
Week 3: T2.1 → T2.2 → T2.3 (多模型基础设施)
Week 4: T2.4 → T2.5 (异构实验 + demo)
```

## 用 MiMo 构建 MiMo 的 Agent

关键洞察：**用 MiMo 来构建这个 agent 本身就是最好的能力评估。**

- 如果 MiMo 能在天枢中完成 T1.1-T1.3（提取模块、构建 loop、实现 CLI），那它的 capability card 就在过程中自然产生了
- 每个 task 的完成质量直接填充 toolUseReliability / editSuccessRate / testRepairRate
- 失败和修复记录填充 .wolf/buglog.json，成为后续优化的数据
- 这是递归验证：**产品在构建自己的过程中验证了自己的核心假设**

执行方式：
- 给 MiMo 一个天枢 session，让它执行 T1.1 的提取工作
- 观察：tool call 成功率、代码质量、是否需要人工干预
- 如果 MiMo 能独立完成 T1.1-T1.2，说明它至少是合格的 `coder` profile
- 如果需要大量干预，调整为 `planner` 或 `code_scout` profile

## 第一步

创建 `/Users/banxia/app/pangu-agent/` 目录，初始化项目，从天枢提取第一批核心模块。用 MiMo-v2.5-Pro 在天枢中执行这个任务。
