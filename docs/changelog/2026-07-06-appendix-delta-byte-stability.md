# 2026-07-06 — Appendix Delta 字节稳定化：让 delta 机制真正安静下来

## 背景

7/5 的缓存成本调查（账单：单次全量缓存重建 ≈ 30× 缓存命中，可覆盖整个会话支出）定位到
用户边界的 ~6.5K token 固定 miss 中，appendix churn 占约 25%。`appendixDelta` 机制
（2026-06-19 引入）本该让未变化的块静默，但三类"字节变了、信息没变"的噪音源使
`<context-update seq="N"/>` 自闭合路径从未触发。审计基线：6/23 之后新加入 prompt
链路的内容属未经缓存审视的增量风险。

## 改动（4 个提交）

### `a3eee256` — plan-mode 注入节律移除

7/4 引入的 full/sparse/reentry 节律（每 5 边界刷 full）借自无 delta 机制的 harness，
在本仓库反而强制块内容轮换 → delta 每 5 边界重发 ~3.7K 字符永不安静。删除整个
cadence 状态机（`PlanInjectionVariant`/`planEnterTurn`/`planReentry`/`PLAN_FULL_REFRESH_TURNS`），
`renderPlanModeBlock` 恒定输出 full 模板。线上字节行为：入场付一次 ~3.3K，稳态零重发，
压缩后随 `resetAppendixBaseline()` 的全量 baseline 自动补课。硬约束不依赖提醒：
`checkPlanMode` 工具门禁 + plan submit 占位符守卫兜底。

### `f3ab9785` — 删除 tool-history 块

与消息历史完全冗余（assistant tool_calls + tool results 本就可见，最近 8 个工具远在
observation-mask 的 10 边界窗口内），且每轮必变，是 appendix 最大的常驻 churner。
`read-file-dedup-hint` 与 `toolHistory` 数据管道（recorder → historical-lessons 打分）保留。

> 原计划的 `deltaStable`（仅 baseline 发送）方案被否决：baseline 在会话首边界发送、
> 早于任何工具运行，该方案实际行为是"块永不可见 + 压缩后闪现一次陈旧快照"。

### `52f88dc0` — tool-context 渲染量化

EFE 2 位小数 → 1 位；排名概率 → 10% 桶（`(~80%)`）。亚桶数值抖动（EFE 第二位小数、
<5% 概率波动）不再产生字节变化；theta/direction/工具集/名次保持精确——它们的变化是
真实信息，跨桶时照常重发。

### `db96e409` — cognitive mirror 全浮点字段三档化

mirror 全部连续值维度（stability/exploration/caution/vigor/curiosity/complexity/
verification_coverage/seasonIntensity/convergence_precision/output_efficiency）改
low/mid/high 三档，`formatDim` 删除。字节只在跨档时变化——跨档恰是模型该感知的状态
转换，byte-diff 天然等价于"状态转换才通知"。三个特殊字面量（`none`/`0.00`/`1.00`）
保留（本就恒定且语义精确）。

## 设计原则（后续新增 appendix 块必读）

1. **appendix 块必须声明自己的变化频率**。每边界必变的块是 churn 源，进 appendix 前
   先想清楚：信息是否已在消息历史里？能否量化到"语义变化才字节变化"？
2. **量化在渲染层做，不在 engine 做**。`buildAppendixBody` 保持单一字节比较语义；
   引擎侧语义哈希（regex 解析自渲染 XML + 第二套 diff 状态）被评审否决。
3. **字节恒定块在 delta 下免费**。入场付一次、稳态零成本、压缩后自动补课——比
   任何 emit-once 状态机都简单。

## 预期与观察项

- 稳态边界 delta 字节量应可测量下降（cache-log `appendixChars` 对比）；自闭合标签
  出现频率是副产品指标——progress、git-status（每 3 边界）、historical-lessons
  （每边界按 recentQuery 重排，**独立遗留问题**）仍在变。
- 跟进项（实测后决定）：排名同桶名次翻转 → 字典序稳定排序；三档边界反复横跳 → 滞回。
- plan-mode 恒定块的验证协议见 `.rivet/plans/plan-mode注入简化-字节恒定块-实验计划.md`。
