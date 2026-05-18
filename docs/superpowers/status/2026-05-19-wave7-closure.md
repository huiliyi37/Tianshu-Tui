# Wave 7 Closure — Sub-Agent 接线增强 完工报告

**日期:** 2026-05-19  
**分支:** `feat/tui-2.4-structural-maturity` → `main`  
**状态:** ✅ 全部完成

---

## 完成概览

| 编号 | 任务 | 状态 | 验证 |
|------|------|------|------|
| A1 | delegate_task 支持 kind/profile 参数 | ✅ | `src/tools/delegate-task.ts` — 6 种 kind + 6 种 profile 全暴露 |
| A2 | Worker 可选写入工具 | ✅ | `coordinator.ts:158` — 按 profile 选择 READ_ONLY/WRITE 工具集 |
| A3 | Worker 结果 → claim store | ✅ | delegate-task/delegate-batch 提取 findings → `worker_finding` claims |
| A4 | Goal loop 注入 coordinator | ✅ | `main.tsx:633-660` — DelegationCoordinator + delegate_task/batch 注册 |
| A5 | 并行 delegation (delegate_batch) | ✅ | `src/tools/delegate-batch.ts` — 2-5 workers 并行 |
| A6 | Worker 继承父 active claims | ✅ | `worker-session.ts:85-86` — promptEngine.updateActiveClaims() |
| A7 | 失败梯度 + shouldEscalate | ✅ | `coordinator.ts:166` — state.shouldEscalate() 接线 |
| — | Worker 超时保护 | ✅ | `worker-session.ts:93-94` — setTimeout(abort, timeoutMs) |

**7/7 设计目标全部完成。10 个审计断点 → 0。**

---

## 测试结果

```
npm test: 1908 passed, 0 failed, 0 skipped
```

| 测试组 | 数量 | 状态 |
|--------|------|------|
| delegate_task tool | 3 | ✅ |
| delegate_batch tool | 2 | ✅ |
| DelegationCoordinator | 10 | ✅ |
| CoordinatorState | 5 | ✅ |
| work-order contract | 13 | ✅ |
| worker prompts | 4 | ✅ |
| runWorkerSession | 5 | ✅ |
| aggregateResults | 5 | ✅ |
| 全量测试 | 1908 | ✅ |

最后 3 个 env-dependent 测试 (MiMo 提供商缺失) 已修复为条件跳过 —— 非代码缺陷。

---

## 关键文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/tools/delegate-task.ts` | 修改 | kind/profile 参数 + claim 提取 + concurrency-safe |
| `src/tools/delegate-batch.ts` | 新建 | 并行 delegation 工具 |
| `src/agent/coordinator.ts` | 修改 | profile→toolSet 选择 + shouldEscalate 接线 + providerHealth 降级 |
| `src/agent/worker-session.ts` | 修改 | activeClaims 注入 + timeout 保护 + hasOwn 防护 |
| `src/main.tsx` | 修改 | runtimeFactory + goal loop coordinator 注入 |
| `src/agent/work-order.ts` | 修改 | WRITE_WORKER_TOOLS + worker result schema 扩展 |
| `src/config/__tests__/integration/user-config.test.ts` | 修改 | 缺失 provider 时条件跳过 |
| `src/config/__tests__/config-schema-integration.test.ts` | 修改 | 动态验证默认 provider |

---

## 能力矩阵

### Worker 类型

| Kind | Profile | 工具集 | Max Turns | 用途 |
|------|---------|--------|-----------|------|
| code_search | code_scout | RO | 4 | 代码搜索 |
| doc_research | doc_scout | RO | 4 | 文档研究 |
| plan | planner | RO | 4 | 实施计划 |
| review | reviewer | RO | 4 | 代码审查 |
| verify | verifier | RO + run_tests | 8 | 测试验证 |
| patch_proposal | patcher | RW | 8 | 修复补丁 |

### 路由配置

```
repo_summarization     → cheap   (flash)
code_edit              → capable (pro)
test_failure_diagnosis → capable (pro)
risky_refactor         → capable (pro)
```

---

## 架构保障

| 约束 | 状态 | 机制 |
|------|------|------|
| SessionContext 隔离 | ✅ | Worker 创建独立 SessionContext，结果只通过 WorkerResult 返回 |
| 只读 Worker (Phase 1) | ✅ | READ_ONLY_WORKER_TOOLS + PHASE1_DISALLOWED_WORKER_TOOLS |
| Schema 验证 | ✅ | workerResultSchema.parse() + normalizeWorkerResult() 修复 |
| 主控权 | ✅ | Primary AgentLoop 决定最终操作，Worker 只产生 evidence |
| 前缀缓存保留 | ✅ | Worker 共享主 session 的 system prompt + tool definitions |
| Budget gate | ✅ | shouldDelegateObjective() — <6 词且 <2 files/symbols 不 dispatch |
| Git 隔离 | ✅ | Worker 无 checkpoint 回调，无 branch/worktree 操作 |

---

## 相关工作流闭环

| 工作流 | 状态 | 证据 |
|---|---|---|
| `/plan <feature>` | ✅ 已集成 | `src/workflows/ecosystem-workflows.ts` 生成 writing-plans prompt；`src/tui/slash-commands.ts` 负责 slash alias 接线 |
| `/write-plan <feature>` | ✅ 已集成 | 与 `/plan` 共享 `resolveEcosystemWorkflowInput()` |

验证命令：

```bash
./node_modules/.bin/tsx --test src/workflows/__tests__/ecosystem-workflows.test.ts
./node_modules/.bin/tsx --test src/tui/__tests__/slash-commands.test.ts
```

---

## 文档索引

| 文档 | 路径 |
|------|------|
| 设计文档 | `docs/superpowers/specs/2026-05-16-rivet-wave7-subagent-wiring-design.md` |
| 实施计划 | `docs/superpowers/plans/2026-05-16-rivet-wave7-subagent-wiring.md` |
| 能力参考 | `docs/superpowers/status/2026-05-18-subagent-capability-reference.md` |
| Subagent 设计 | `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md` |
| 完工报告 | `docs/superpowers/status/2026-05-19-wave7-closure.md` (本文档) |

---

## Wave 8 候选 (未排期)

| 项目 | 设计文档 |
|------|---------|
| Brain/Hands 分离 | Wave 7 附录 |
| Git worktree 隔离 (write worker) | Wave 7 附录 |
| Worker 间共享 knowledge base | Wave 7 附录 |
| 自适应路由学习 | — |
