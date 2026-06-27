# 天枢 Changelog — 2026-06-27 Worker Artifact Namespace Fallback

## 🔍 问题

Worker 会话把自己的 artifact 写到 `<cwd>/.rivet/artifacts/worker-<orderId>/`，而主会话的 `ArtifactStore` 只认识自己 session 目录，导致主会话在 `buildPrimaryWorkerPacket` 或 `read_section` 时无法解析 worker 产生的 artifact，报 `artifact namespace mismatch`。

## 🐛 修复

采用「彻底」方案：让主 `ArtifactStore` 直接能读 worker artifact 目录，而不是在 coordinator 里做二次拷贝。

### 1. `ArtifactStore` fallback session 机制 — `src/artifact/store.ts`

- 新增 `addFallbackSession(sessionId)`，允许多个 worker session 目录被注册为只读回退源。
- `get(id)` 优先查主 session，未命中时按注册顺序查 worker session 的 `_index.jsonl`。
- 命中后把 `rawPath` re-anchor 到 worker session 目录，保证 `readRaw/readLines/readLineRange` 能直接读原文件。
- `readRaw` 和 `readLines` 改为通过 `get(id)` 读取，从而也支持 fallback artifact。

### 2. Coordinator 自动注册 worker artifact 目录 — `src/agent/coordinator.ts`

- `DelegationCoordinatorConfig` 新增可选 `artifactStore: ArtifactStore`。
- 运行 hands / worker 成功后调用 `registerWorkerArtifacts(order.id)`，计算 `worker-${orderId.replace(/:/g, '-')}` 并注册 fallback。
- 所有 `buildPrimaryWorkerPacket(...)` 调用都传入 `this.config.artifactStore`，让超大 packet 也能卸载到主 store。

### 3. Bootstrap 装配 — `src/bootstrap.ts`

- 调整创建顺序：先创建 `AgentLoop`，再把它 `agent.artifactStore` 注入 `DelegationCoordinator`。
- 这样 coordinator 和主 agent 共用同一个 store 实例，fallback 注册立即生效。

## ✅ 验证

| 测试套件 | 结果 |
|---------|------|
| `src/artifact/__tests__/store.test.ts` | ✅ 全部通过（含新增 fallback 用例） |
| `src/agent/__tests__/coordinator-artifact-fallback.test.ts` | ✅ 通过 |
| `src/agent/__tests__/coordinator.test.ts` | ✅ 全部通过 |
| `src/agent/__tests__/patcher-e2e.test.ts` | ✅ 通过 |
| touched 文件 `tsc --noEmit` | ✅ 无错误 |

## 📋 涉及文件

- `src/artifact/store.ts`
- `src/artifact/__tests__/store.test.ts`
- `src/agent/coordinator.ts`
- `src/agent/__tests__/coordinator-artifact-fallback.test.ts`
- `src/bootstrap.ts`
- `AGENTS.md`

---

*Worker artifact 目录格式：`worker-${order.id.replace(/:/g, '-')}`，与 `src/agent/worker-session.ts` 中 worker session id 生成规则保持一致。*
