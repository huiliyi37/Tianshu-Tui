# Compact/Cache 架构审查 — 完整链路记录

> 日期：2026-06-06-23 | 审查者：天枢（天权域）| 对象：compact 压缩系统 + prompt 提示词体系 + hook 流水线

## 触发

用户提供外部审查计划 `rivet_架构深度审查_20735041.plan.md`，含 14 个架构问题，要求天枢核实并给出意见。

## 链路

```
原始审查（14 问题）
  → 天枢第一轮核实（问题 1-3）：逐行读 compaction-controller / compact-boundary-coordinator / constants.ts
    → 发现：问题 1 断言成立（1M 路径绕过 isCachePreservingProvider），遗漏 T7 请求时折叠缓解机制
    → 发现：P2.1 测试虚假绿灯（makeController 没传 primaryClient）
  → 两份调查报告（compact-issue-1 / compact-issue-2）
    → Issue 1 修正：严重度从"高"降为"中"（T7 折叠是主要减压阀）
    → Issue 2 修正：TaskAnchor 含 constraints/scope/successCriteria（原审查说"仅覆盖任务目标"不准确）
    → 新发现：persistExtractedMemories 仅在 86%/95% 路径调用（maybeCompact/partial 不 persist）
  → 三个修复提交
    → a1731b79: P0 测试修复 + P1 task-anchor 注入 + P2 provider gate + P3 persist + P4 token 口径统一
    → cd76b582: P3 persist 位置修正（llmCompact 之后，避免 cache miss）
    → 06cf5ab5: P5 followUp contract merge + P6 summary post-check + P7 E2E 测试
  → 分层归档方案（新计划）
    → 核心：oldZone 归档为 compact-history artifact，模型可 read_section 召回
    → 天枢意见：阶段 1 有价值先做，阶段 3（自适应反馈环）过度设计
  → 方法论反推：从全链路中提取五个审查方法论缺口
```

## 关键决策

| 决策 | 理由 | 来源 |
|------|------|------|
| 问题 1 严重度"高"→"中" | T7 请求时折叠在 50-85% 区间减压，60%/75% 存储层 compact 实际很难触发 | 调查报告 issue 1 |
| P2.1 虚假绿灯优先修 | 后续所有 compact 改动需要正确的回归保护 | 天枢第一轮 |
| persist 放 llmCompact 之后 | persist 热更新 session memory → frozen base 重建 → llmCompact cache miss | cd76b582 |
| partial compact 注入 TaskAnchor | LLM 摘要丢 constraints 后无确定性后备 | 天枢第一轮（issue 1 × issue 2 交叉点） |
| 分层归档阶段 1 先做 | 独立可验证，不需要阶段 2-4 | 天枢方案审查 |

## 涉及文件

- `src/agent/compaction-controller.ts` — maybeCompact 1M 分支、tryPartialCompact、llmCompact、replaceWithCheckpoint
- `src/agent/compact-boundary-coordinator.ts` — isCachePreservingProvider 保护点、stale-round 跳过
- `src/compact/constants.ts` — cache-preserving ratios、summaryOutputBudgetChars、CACHE_ANCHOR_MESSAGES
- `src/context/compact-policy.ts` — decideCompactTier
- `src/cache/advisor.ts` — shouldDelayCompact
- `src/prompt/engine.ts` — T7 请求时折叠、token 估算口径
- `src/context/task-contract.ts` — renderTaskAnchor、mergeFollowUpIntoContract
- `src/agent/turn-step-producer.ts` — followUp contract 继承
- `.rivet/investigations/compact-issue-1-1m-cache-conflict.md` — Issue 1 完整调查
- `.rivet/investigations/compact-issue-2-llm-summary-quality.md` — Issue 2 完整调查

## 遗留

- 分层归档方案阶段 1 待实施
- compact 路径召回内容淘汰机制（召回的 tool_result 应在下次 partial compact 时优先归入 oldZone）
- T7 折叠与分层归档的请求层/存储层协作关系待明确
