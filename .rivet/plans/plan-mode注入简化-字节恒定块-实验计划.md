# Plan Mode 注入简化 — 字节恒定块 + delta 抑制（实验计划）

> **Model: claude (cursor session)** · 2026-07-05
> 关联提交：`a3eee256` refactor(plan-mode): remove injection cadence
> 状态：代码已落地，待实验验证

## 背景

7/4 引入的 plan-mode 注入节律（full/sparse/reentry，每 5 边界刷 full）借自无 delta 机制的
harness。本仓库 `appendixDelta` 默认开启（`create-agent-config.ts:159`），delta 对字节恒定
块的行为是**入场付一次、之后每边界零重发**。节律强制变体轮换 → 块内容每 5 边界变两次 →
delta 永不安静，稳态每 5 边界重发 ~3.7K 字符（~900 token）。这是 6/23 稳定基线之后
插进 appendix 的真 churn 源之一。

## 目标形态（方案 2）

| 时机 | 行为 | 实现方式 |
|------|------|----------|
| 入场 | 发一次 full（~3.3K 字符） | 块首次出现 → delta 视为新块全量发 |
| 稳态每边界 | **零字节** | 块字节恒定 → delta 抑制（absent = unchanged） |
| 压缩/历史重写后 | 随 baseline 全量重发一次 full | `resetAppendixBaseline()` → 下次 `<context-update>` 全量 |
| 退出 | 一次性 `<plan-mode-exit>` 提醒 | 原有机制不变 |

实现是**声明式**的：`renderPlanModeBlock` 恒定输出 full 模板（只随 `activePlanFilePath`
变化），不需要 emit-once 状态机——delta 机制天然给出上表的线上字节行为。

### 与方案 2 字面描述的两处偏差（有意接受）

1. **reentry 短头删除**：驳回后重进 plan mode 时重发一次 full（~3.3K）而非短头（~0.4K）。
   一次性成本 +3K，换整个状态机（`planInjectionVariantFor`/`planEnterTurn`/`planReentry`/
   `PLAN_FULL_REFRESH_TURNS`）归零。重进是低频事件，接受。
2. **`RIVET_APPENDIX_DELTA=0` 时无抑制**：delta 关闭的会话每边界重发 full。这是 opt-out
   逃生门的固有代价，不为它加状态。

## 已完成（a3eee256）

- `src/agent/plan-mode.ts`：删 `PlanInjectionVariant` + `planInjectionVariantFor`
- `src/prompt/volatile.ts`：`renderPlanModeBlock` 去 variant 参数，只剩 full 模板
- `src/agent/loop.ts`：删 cadence 状态机与 `computePlanInjectionVariant`
- `src/prompt/engine.ts`：删 variant 字段/setter/dynamicCtx 传递
- 测试：删 cadence 测试；新增 delta 抑制契约测试（同输入两次渲染字节相同）
- 验证：plan-mode + volatile 102 项、engine-cache-stability 48 项全过

### baseline 重置触发点（已逐一核实，"压缩后补课"依赖这些）

- `compaction-controller.ts:650/1053/1203` — 压缩三档（LLM 压缩/分层/局部）
- `loop-factory.ts:559`、`serve.ts:691-692` — replaceMessages/rewind 统一接线
- `slash-commands.ts:692/2132` — `/compact`、会话恢复
- `main.ts:759`、`session-manager.ts:2201` — TUI/服务端 rewind

## 实验协议

### 实验 A：稳态零重发（核心断言）

1. 新会话进入 plan mode（给一个多模块任务触发，或显式 `/plan`），让它自主规划 ≥6 个用户边界（含 kick/续推注入的边界）。
2. 观察 cache-log 的 `appendixChars`：入场边界应有一次 +3.3K 跳变，之后各边界的变化量
   应只来自其他块（tool-history 等），**不再出现 ~3.4K 或 ~0.4K 的 plan-mode 周期性波动**。
3. 对照指标：plan 会话稳态边界的 miss token 均值，相比改动前（7/4-7/5 的 plan 会话
   cache-log）应下降 ~200 token/边界（900 token / 5 边界的摊销消失）。

### 实验 B：压缩补课

1. 在 plan mode 会话中触发压缩（长规划自然触发，或 `/compact`）。
2. 断言：压缩后第一个边界的 `<context-update>` 是全量 baseline（无 `mode="delta"`），
   其中包含完整 `<plan-mode>` 块——模型不丢只读约束和质量标准。
3. 断言：压缩后第二个边界起恢复 delta 抑制，plan-mode 块再次静默。

### 实验 C：行为无回归（漂移担忧的证伪）

用户判断模型幻觉极低、无需防漂移——用数据确认：

1. 长规划会话（≥10 边界、无 full 刷新）中统计 `checkPlanMode` 拒绝次数：
   模型尝试白名单外写操作的频率应与改动前持平（≈0）。
2. 提交的计划仍满足质量门：Mermaid 图 ≥1、事实锚点、无占位符（submit 守卫会拦，
   看被拦率是否上升）。
3. 驳回→重进（reentry 场景）：修订轮模型行为正常，不因缺"恢复规划"短头而迷失。

### 观测手段

- cache-log：`appendixChars` 逐调用变化 + usage 的 hit/miss token（本次调查用过的同一管道）。
- 会话 JSONL（`~/.rivet/sessions/<slug>/<id>.jsonl`）：注意 trailer 合并发生在请求构建时，
  JSONL 里看不到线上字节；线上行为以 cache-log 为准。
- 另一会话正在做的 prefix-divergence 探针（engine.ts 未提交改动）落地后，可直接确认
  plan 会话稳态边界无 `prefixDiverged` 事件。

### 成功标准

- A：稳态边界 plan-mode 零重发；plan 会话边界 miss 均值下降可测量。
- B：压缩后 full 块恰好重发一次，随后恢复静默。
- C：门禁拒绝率、submit 被拦率与改动前持平。

### 回滚

`git revert a3eee256` 一步回滚（纯删除性改动，无数据迁移）。若实验 C 发现长会话
真实漂移，优先方案是**只在压缩事件挂一次重发**（已天然具备）而非恢复 %5 节律。
