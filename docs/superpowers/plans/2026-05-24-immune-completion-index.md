# Immune System 完成 — 拆分子计划包索引

> **阅读顺序：** 先读本索引（5 分钟），明确每包边界与依赖，然后只看当前要执行的那一包。
>
> **🛑 关键执行规则（适用所有包）：**
> 1. 每包独立交付，包间用户审查
> 2. 每包内部：subagent-driven，每任务一个新 agent，每任务结尾 STOP
> 3. TDD 红绿循环留 commit 痕迹（测试先 commit，实现后 commit）
> 4. 每任务独立 commit，不批量
> 5. typecheck 用 `npx tsc --noEmit` 的 exit code 为准，不信 IDE 诊断

**背景：** 原 `2026-05-24-immune-system-completion.md`（1389 行 × 10 任务）一次性交单 agent 必然降级（注意力衰减、集成步骤被挤出工作记忆）。基于 P1-P4 降级教训（commit `c758b8e`）和体检发现（`186b179` 的 80% 误报率），拆为 4 个子计划包。

**已并入的修复：**
- 已执行 `mistake-notebook-wire.md`：trace→notebook 写路径已 wire（commit 待生成）。原任务 8 的"MistakeNotebook 同步"扩展为**双向同步**（immune adaptive layer ↔ notebook + 跨 session 持久化），不重做已有的 trace→notebook wire。

---

## 4 个子计划包

| 包 | 范围 | 优先级 | 工作量 | 依赖 | 文档 |
|----|------|--------|--------|------|------|
| **A** | 任务 1+2：类型重构 + SQLite 持久化 | P0 前置 | 1.5h | 无 | `2026-05-24-immune-pkg-A.md`（✅ 已完成） |
| **B** | 任务 3+4+5：3 类 danger signal 接入 | P1 | 2h | 包 A 完成 | `2026-05-24-immune-pkg-B.md`（✅ 已完成） |
| **C** | ~~任务 6+7：fastRepair 策略丰富化 + Pheromone 完整化~~ | ~~P2~~ | ~~2.5h~~ | — | **🚫 取消（调查后发现已完成）** |
| **D** | 任务 8+9：MistakeNotebook 持久化 + recordRepairSuccess 接入 | P3 | 2h | 包 A 完成 | `2026-05-24-immune-pkg-D.md`（✅ 已写） |

**总工作量：** 5.5 小时（A 1.5h + B 2h + D 2h，C 跳过）

**包 C 跳过理由（2026-05-24 调查记录）：**

- **任务 6（fastRepair 策略丰富化）**：原 1389 行计划假设 fastRepair 只返回 string，需要根据 memory 类型选择不同响应策略。但**包 A 已经把 `ImmuneMemory.response` 重构成 `ImmuneResponse` 结构化对象**，fastRepair 直接 `return memory.response` 就是正确的——回放学到的具体策略（quarantine/prune_toxic/boost_healthy/deposit_warning），applyResponse 已 wire 到 physarum 的 freezeNode/forcePrune/boostEdges。任务 6 在新架构下已无内容。
- **任务 7（Pheromone 完整化）**：调查显示 StigmergyStore 已有 load/deposit/prune/query 全部方法，PheromoneSignal 类型完整，decay 公式已实现，immune-hook.ts:132-140 已 deposit `'fragile'` 信号，loop.ts 已 query 并注入 sensorium 用于 freshness 计算，pheromones 也注入到 prompt 让 intent reasoning 可见。**整条 deposit→decay→query→inject→consume 链路已闭环**。任务 7 实际是描述一个已存在的系统。

**经验教训：** 1389 行总览计划写成时（早于包 A、B 实施），假设 immune 系统状态比实际更原始。**写包 C/D 计划前应先调查现状**——这次发现 60% 工作（包 C）已完成，避免了浪费 2.5h 重复实现。
- **D 是收尾**：双向同步、可选 prompt 注入（用户可选）、跨包集成验证。

**包间审查清单（每包完成后用户检查）：**

1. 全部 commit SHA 列出
2. 是否所有任务都独立 commit
3. 是否有 TDD 红绿循环痕迹（test commit + impl commit 各一）
4. `npx tsc --noEmit` exit 0
5. `npm test` 仅 startup-memory.test.ts 失败（pre-existing）
6. 用 `grep` 验证集成点真有 production caller，不是孤儿

---

## 状态跟踪

| 包 | 状态 | Commit 范围 | 备注 |
|----|------|------------|------|
| A | 计划已写，未执行 | — | 等用户 approve 后启动 |
| B | 未写 | — | 包 A 完成后再写（基于 A 实际产出） |
| C | 未写 | — | |
| D | 未写 | — | |
| mistake-notebook-wire | 计划已写，未执行 | — | 独立小修复，可与包 A 并行 |

---

## 下一步

执行包 A（`2026-05-24-immune-pkg-A.md`），完成后审查并写包 B。
