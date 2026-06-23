# 子代理修复：delegate_batch 依赖 + review 隔离 + 残余泄漏

> 2026-06-23 · 关联计划 `subagent dependency and review fixes`

## 背景

对子代理编排做了一轮排查，确认三类问题：

1. **dispatcher 言行不一**：dispatcher-hook 已 advisory 化（不再自己 spawn worker，原「并行 delegate 丢依赖」竞态消失），但 advisory 叫模型「调 `delegate_batch` 并传 dependencies」，而 `delegate_batch` 工具 schema **没有 dependencies 字段** → 模型即便照做也被 Zod 静默剥掉。运行时依赖 enforcement 只有 `coordinator.delegateBatch` → `WorkOrderQueue` 一条链生效，此前只有 `team_orchestrate`/`plan_task` 喂得进去。
2. **review worker 缓存隔离被击穿**：Flash→Pro 升级在 transient 失败时把 `reviewer`/`adversarial_verifier` 升到主会话强模型，违背 `tierLock:'cheap'` 的既定意图（`profile-registry.ts:277` 注释「永不升级」），踢掉主会话前缀缓存（见 `.rivet/knowledge/debug-glm-cache-break-deliver-task.md`）。
3. **cooldown 文案虚假 + 泄漏残余**：post-commit review 的 30s cooldown 文案说「合并入上一轮」，实际只是跳过、未合并 ChangeSet；`~/.rivet/subagents/*.json` 无 TTL；`bootstrap.test.ts` 路径漂移导致 `cleanupStaleWorkerSessionDirs` 用例一直失败。

worker 目录泄漏主修复（`evictOldSessionsInternal` rmSync 目录 + 启动 `cleanupStaleWorkerSessionDirs`）此前已完成，本轮只补残余。

## 改动

### 1. delegate_batch 真正接上 dependencies（核心）

- `[src/agent/coordinator.ts](../../src/agent/coordinator.ts)` `deriveStableWorkOrderId`：正则 `/\b(team|council):/` → `/\b(team|council|batch):/`，使 batch 任务获得确定性稳定 ID（`prefix:batch:N` → `batch:N`）。
- `[src/tools/delegate-batch.ts](../../src/tools/delegate-batch.ts)`：
  - `taskSchema` + JSON `input_schema` 加 `dependsOn: number[]`（指向同批任务的 0-based index）。
  - `parentTurnId` 改为 `${toolUseId}:batch:${i}`，`dependsOn` 映射成 `dependencies: ['batch:N']` 传入 request（coordinator 已透传给 WorkOrder，队列 `work-queue.ts:63-78` enforce 等待 + 文件冲突串行；未满足依赖经 A3 post-drain 标 `blocked`，不死锁）。
  - 校验：index 越界 / 自引用 → `isError` 明确报错；循环依赖容忍（落 blocked）。
  - **cap 交互**：任一 task 带 `dependsOn` 时跳过 `progressiveTaskCap` 修剪（否则裁掉上游会让下游永久 blocked），依赖批次的并发本就由队列按波次限制。

### 2. dispatcher advisory 对齐

- `[src/agent/hooks/dispatcher-hook.ts](../../src/agent/hooks/dispatcher-hook.ts)`：文案改为「按上面顺序列 tasks，用 dependsOn 传被依赖任务的 0-based 下标（被指向方先跑）」，与新 schema 一致。

### 3. review worker 缓存隔离

- `[src/agent/coordinator.ts](../../src/agent/coordinator.ts)` Flash→Pro escalation：`canUpgrade` 加 `!tierLocked` 守卫——`profileRegistry.get(order.profile)?.tierLock === 'cheap'` 时不升级到 strong。与 `profile-registry.ts:277` 既定意图一致；之前是未被遵守的 bug。
- 默认 flash 路由仍属配置层（`agent.review.profiles`），不在代码强配 provider；tierLock cheap 现已端到端生效，GLM/Kimi 用户配 flash/deepseek override 即可隔离。

### 4. cooldown 文案诚实化

- `[src/agent/deliver-task.ts](../../src/agent/deliver-task.ts)`：cooldown 命中时由「本轮合并入上一轮」改为「⏭ 提交后审查跳过：距上轮审查仅 Ns（<30s 冷却窗口）。本轮变更未被审查，必要时用 `/review` 手动覆盖。」（真正的 ChangeSet 合并列为后续。）

### 5. 泄漏残余

- `[src/agent/coordinator.ts](../../src/agent/coordinator.ts)`：新增 `evictOldSubagentResults`（导出，cap `MAX_SUBAGENT_RESULTS=500`），`persistWorkerResult` 写入后做一次 LRU 淘汰。
- `[src/__tests__/bootstrap.test.ts](../../src/__tests__/bootstrap.test.ts)`：测试内设 `RIVET_SESSION_DIR` 对齐 `getSessionDir`（原本默认 `~/.rivet/sessions/<slug>`，用例创建于 `testCwd/.rivet/sessions/` → 一直失败）。

## 测试

- `delegate-batch.test.ts`：dependsOn → `batch:N` 稳定 ID + parentTurnId、越界/自引用报错、有依赖绕过 cap、无依赖仍按 cap 裁剪。
- `coordinator-stable-id.test.ts`：`batch:` 前缀稳定化。
- `subagent-result-eviction.test.ts`：LRU 淘汰 / 不足上限 no-op / 缺目录 / 忽略非 json。
- `coordinator.test.ts`：tierLock cheap profile transient 失败**不**升级 strong。
- `deliver-task.test.ts`：cooldown 命中诚实文案、不出现「合并入上一轮」。
- `bootstrap.test.ts`：路径修正后 stale worker 目录清理用例通过。

`npm run build` 通过；touched 文件 typecheck 无错（仓库内 `compact-boundary-coordinator.test.ts` 的既有 WIP 错误与本次无关）。

## 设计偏差 / 不做

- **未从 coordinator 调用 `cleanupStaleWorkerSessionDirs`**：它在 `bootstrap.ts`，而 bootstrap import coordinator，硬连成循环依赖。权衡后不为此重构模块边界——启动 sweep + 已修的 `evictOldSessions` + 新增 subagents TTL 已覆盖主泄漏路径，仅「单次超长会话内 orphan 目录」延迟到下次启动清。
- **cooldown 仅文案诚实化**，不实装真正的 ChangeSet 合并（避免过度工程）。
- **不给单发 `delegate_task` 加 enforce**：它 bypass 队列；需要顺序用 `delegate_batch`/`team_orchestrate`。
- **不在代码层强配 review provider**：保持 `agent.review.profiles` 配置驱动。
