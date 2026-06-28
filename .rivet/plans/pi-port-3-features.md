# Pi 特性移植：语义去重 + 探索停滞检测 + GLM hardStall 消险

> 2026-06-27。从 oh-my-pi 核心架构对比分析中筛选的 3 项高收益低代价特性。

## 任务

### 任务 1：语义化工具结果去重

- [ ] 在 `src/compact/` 新建 `semantic-prune.ts`，实现 `pruneOutdatedQueryResults()`
- [ ] 在 `src/agent/compaction-controller.ts` 的 compaction 流程中，消息历史构建前调用去重
- [ ] 测试 `src/compact/__tests__/semantic-prune.test.ts`

**目标**：对相同查询（grep 相同 pattern、glob 相同 pattern、read_file 相同路径）只保留最新一条结果。不影响 cache anchor（前 N 条不剪枝）。

**核心逻辑**：遍历消息列表，识别 tool_use(message) → tool_result 对，按 key=`toolName:args` 分组。每组只保留 index 最大的（最新）条目。保护 anchorCount 条前缀不动。

### 任务 2：探索停滞检测

- [ ] 在 `src/agent/` 新建 `exploration-stall.ts`，实现 `detectExplorationStall()`
- [ ] 在 `src/agent/convergence-detector.ts` 或 `sensorium.ts` 中接入，作为 stability 维度的补充信号
- [ ] 测试 `src/agent/__tests__/exploration-stall.test.ts`

**目标**：检测"连续 N 轮只读不改"——grep/read_file/glob 了大量内容但从未调用 write_file/edit_file/hash_edit。当连续 >= 5 轮只读不改时，向 sensorium 注入低 stability 信号，触发策略调整。

### 任务 3：GLM hardStall 消险

- [ ] 在 `src/agent/turn-step-producer.ts` 心跳构造处：GLM provider 的 `hardStallMs` 从 600s 改为 0（完全禁用 hardStall abort），仅保留 informational heartbeat
- [ ] 更新 `src/agent/__tests__/turn-heartbeat.test.ts`（如有）

**目标**：已验证 GLM 独立推理模式下不会真正死锁，hardStall 误杀风险 > 防护价值。对 GLM 关闭 hardStall abort，仅保留信息性心跳。

## 验证

```bash
npx tsc --noEmit
npm exec -- tsx --test src/compact/__tests__/semantic-prune.test.ts
npm exec -- tsx --test src/agent/__tests__/exploration-stall.test.ts
```
