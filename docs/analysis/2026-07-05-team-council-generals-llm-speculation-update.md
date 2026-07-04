# 更新记录 — Team/Council 闭环 · 将星机制 · Tier 2 LLM 投机引擎

> 产出日期：2026-07-05
> 覆盖 commit：`1a97366e` → `abde446a` → `3bcf2f93`（三段一条主线：多智能体协作闭环 → 将星账本通电 → 空闲算力变现）
> 用途：后续查看与迭代的锚点文档。改这些机制前先读本文的「迭代方向」和各自的防线设计。

## 一条主线

三个提交解决的是同一个问题的三个层面：**多智能体系统的产能没有被完整回收**。

- Team/Council 跑完的成果断在半路（闭环缺口）→ `1a97366e`
- Worker 积累的战绩经验写不进账本（学习回路死接线）→ `abde446a`
- 工具批 await 期间的免费算力白白流走（DeepSeek 前缀缓存红利未变现）→ `3bcf2f93`

---

## `1a97366e` — TUI Team/Council 闭环 + 将星点亮 + 天梁最大化

**Phase A（闭环止血）**：

- `plan-executor` 每波 `saveCheckpoint`、交付后 clear —— team 中断后不再从零开始
- `/team-resume` 真续跑：checkpoint → 重组计划 → plan-store → 主控续派
- council 产出自动 `storePlan` 入会话桥；`autoExecute` 改走 `executePlan` 完整管线（此前 council 的结论只是文本，不进执行链）

**Phase B（将星点亮）**：

- 新增 `src/agent/general-ledger.ts` + `recall_general` / `record_general_finding` 工具，`.rivet/generals/` 战绩账本读写闭环
- `buildWorkerPrompt` 合并账本 top-3 缺陷族；贪狼胶囊 T1-T7 principle 标签；yaoguang 账本摘要同步

**Phase C（天梁最大化）**：`docs/seed-capsule-tianliang.md`（L1-L6）；dispatcher advisory 透传 per-task authority。

## `abde446a` — 将星机制收束闭环（G1-G4）

上一个提交把机制建了起来，这个提交修的是「送达了指引、没送达能力」的死接线：

- **G1**：`recall_general`/`record_general_finding` 加入十域 `toolWhitelist` 与 reviewer/patcher `allowedTools`。教训：星域 whitelist 是 fail-closed 交集过滤器，B3 指引 worker 记账但工具活不过 `profile ∩ whitelist`。交集回归测试双侧钉死。
- **G2**：`general-ledger-hook`（postTool）——带账本星 authority 的 delegate 完成后提醒主控核对新战绩，每星每会话一次，`RIVET_GENERAL_LEDGER_REMINDER=0` 可关。
- **G3**：账本读/写落遥测（sensorium.jsonl 同通道），sink 抛错被吞不影响账本 I/O。
- **G4**：G1 缺陷本身入账 yaoguang.md（dead-pointer-tool-reference 族）——机制首次真实使用。

## `3bcf2f93` — Tier 2 LLM 投机引擎（本次）

复活 [2026-05-24 P3 优化设计](../superpowers/specs/2026-05-24-p3-optimization-scout-design.md) 模块 B 分层推测架构中唯一未落地的「Flash 空闲推测」。Tier 0/1（流式预热、bigram 工具投机）与 T2-01（Physarum 文件预测）早已落地。

**经济账**：投机请求浅拷贝主会话 messages + 同模型同 tools → DeepSeek 前缀缓存全命中 → input 成本 ≈ 0；DSpark（V4 服务端投机解码）再压 output 侧延迟。工具批 await 期间就是免费算力窗口。

**数据流**：`turn-orchestrator` 创建 batchPromise 后 fire-and-forget → `llm-speculation.ts` 发旁路请求（`tool_choice:'none'`、`temperature:0`、320 tokens）→ 解析 JSON 预测 → `p3.enqueueLlmPredictions`（source: `llm`）→ `ShadowQueue` 投机预执行只读工具 → 下一轮真实调用 `speculativeHit` 短路。

**防线（改动前必读）**：

| 防线 | 实现 | 钉死它的测试 |
|---|---|---|
| 前缀安全 | 绝不改原 `request`/`messages`，新数组追加指令 | RED 门：断言原引用+内容逐字节不变 |
| 只读门 | 引擎解析层白名单 + ShadowQueue 白名单双重过滤 | RED 门：`edit_file`/`bash` 预测被丢 |
| 门控链 | enabled（**默认关**）→ in-flight 串行 → maxPerTurn(3) → 慢工具门 | 每道门独立用例 |
| best-effort | `AbortSignal.any([loop, timeout])`，失败/超时静默吞 | 错误吞掉 + stats 计数 |
| 零开销关闭 | loop-factory 只在开启时构造引擎并注入 dep | wiring 测试断言 dep 为 undefined |

**开关**：`agent.llmSpeculation`（config），支持 `true` 简写或对象 `{ enabled, maxPerTurn, maxTokens, timeoutMs, minProbability, slowToolsOnly }`。

**观测**：`ShadowQueue.statsBySource()` 按源统计 enqueued/hits（tool-pattern / physarum-file / combined / llm 四源谁在挣钱）；telemetry `kind:'llm-speculation'` 记 outcome/latency。

## 验证状态

三个提交各自带测试全绿；本次投机引擎：typecheck 通过，新增 24 用例 + 邻接套件（shadow-queue / p3-integration / schema / layered-config / create-agent-config）共 162 例通过。

## 迭代方向（backlog，按优先级）

1. **投机引擎默认开启的决策**：现在默认关。需要真实会话跑一段时间，用 `statsBySource().llm` 的命中率 + telemetry latency 数据决定是否默认开。命中率 < 10% 或 p95 latency > 慢工具平均执行时间 → 保持关。
2. **命中率反馈回路**：LLM 预测命中/落空目前只计数不学习。可把落空样本喂 MistakeNotebook 或调 minProbability 自适应。
3. **Tier 3 COW overlay 写投机**：另立设计（明确不在本次范围）。
4. **更广闲时预计算**：预生成计划候选/预审查等（backlog，同一发射窗口可复用）。
5. **DSpark**：服务端能力，harness 侧无代码工作；自托管 vLLM 时需开对应 flag。
6. **将星账本增长管理**：`.rivet/generals/*.md` 会持续增长，top-3 族合并策略在账本大了之后需要重新评估（目前无淘汰机制）。
7. **慢工具清单维护**：`SLOW_TOOLS`（bash/run_tests/delegate_task/delegate_batch/web_search/council_convene）是硬编码集合，新增慢工具时记得同步。

## 相关文件索引

- 引擎：`src/agent/llm-speculation.ts`（门控/构造/解析/telemetry 全在此）
- 接线：`src/agent/loop-factory.ts` `createTurnOrchestrator` 头部、`src/agent/turn-orchestrator.ts` `speculateDuringBatch` dep
- 消费链：`src/agent/p3-integration.ts` → `src/agent/shadow-queue.ts` → `src/agent/tool-pipeline.ts` speculativeHit
- 将星：`src/agent/general-ledger.ts`、`src/agent/hooks/general-ledger-hook.ts`、`.rivet/generals/`
- Team 闭环：`src/agent/plan-executor.ts`、`src/agent/wave-checkpoint.ts`、`src/tools/council-convene.ts`
