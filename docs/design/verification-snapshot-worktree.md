# Verification Snapshot Worktree (VSW)

> 在与当前会话改动隔离的 Git worktree 中运行验证，把「我的改动是否真的通过」与「外部并发改动 / 脏基线噪声」彻底分开。

## 1. 动机

交付门禁（delivery gate）依赖 `run_tests` 的结果判断"本会话拥有的改动是否通过验证"。但在真实运行环境里，验证结果会被两类噪声污染：

1. **脏基线**：任务启动前工作树就已有未提交改动（别的会话、人手动改、上次任务残留）。测试失败可能源于这些**外部文件**，而非本会话的改动。
2. **并发会话**：本仓库常有多个 agent 会话共享同一工作目录。会话 A 跑测试时，会话 B 正在改文件——A 看到的失败可能是 B 造成的。

VSW 的核心思想：**把"本会话拥有的改动"叠加到一个干净的基线 commit 上，在独立 worktree 里跑测试**。这样 Phase A（隔离）只反映本会话改动的真实质量；同时在真实工作树跑 Phase B（集成）作为非阻塞的"集成冲突"预警。

## 2. 关键概念

| 概念 | 含义 |
|------|------|
| `baseline.head` | 任务启动时捕获的真实 commit SHA（`BaselineSnapshot.head`）。快照 worktree detach 到这个 commit。 |
| `baselineHash` | 结构完整性哈希（branch + head + 外部文件），用于 cycle 完整性校验。**与 `baselineHead` 区分**：前者是身份指纹，后者是 commit-ish。 |
| owned diff | 本会话拥有文件相对 `baseline.head` 的改动（tracked 改动用 `git diff`，untracked 用文件物化）。 |
| `snapshotRef` | `baselineHead(12) + "+" + sha256(ownedDiff)(12)`。内容寻址的快照身份。**owned diff 变化 → ref 变化 → 旧验证自动失效**。 |
| Phase A（isolated） | 在快照 worktree（`baseline.head` + owned diff）跑测试。**阻塞门禁**。 |
| Phase B（integration） | 在真实工作树（当前 HEAD + 所有改动）跑测试。**仅 advisory**，失败归类为 `integration_conflict`，不阻塞交付。 |

## 3. 架构与数据流

```
deliver/run_tests 触发
   │
   ▼
VerificationSnapshotManager.prepare(ownedFiles)
   │   decideSnapshotPolicy(§6 矩阵)
   ├─ 决策 = in-place ──► 返回 null ──► run_tests 单阶段（默认，行为不变）
   └─ 决策 = snapshot ──► 懒建/复用 worktree ──► 返回 {path, snapshotRef}
                                  │
                                  ▼
                        run_tests 两阶段：
                          Phase A in plan.path   (isolated, 阻塞)  → tag snapshotRef
                          Phase B in params.cwd  (integration, advisory)
                                  │
                                  ▼
                     tool-pipeline 记录两条 verification 事件
                                  │
                                  ▼
                     delivery-gate.assess(…, currentSnapshotRef)
                       · getEffectiveVerifications 丢弃 stale snapshotRef 的验证
                       · integration_conflict → YELLOW（可交付，advisory）
```

## 4. 模块清单

| 文件 | 职责 |
|------|------|
| `src/agent/worktree.ts` | `buildDetachedWorktreeArgs` / `createWorktreeAt`：底层 `git worktree add --detach <path> <commitish>`。 |
| `src/agent/verification-snapshot.ts` | 创建/管理快照 worktree，叠加 owned diff（`git diff \| git apply` 处理 tracked 改动 + `materializeScope` 处理 untracked）。worktree 注册表 mutation 受 `RepoLock` 保护。 |
| `src/agent/snapshot-deps.ts` | 为快照 worktree 提供依赖（如 `node_modules` 链接），让隔离环境可运行测试。 |
| `src/agent/snapshot-ref.ts` | `computeSnapshotRef` / `computeOwnedDiff` / `snapshotRefFor`：确定性计算 `snapshotRef`。 |
| `src/agent/snapshot-policy.ts` | `decideSnapshotPolicy`：§6 决策矩阵。决定 snapshot vs in-place，不可用时优雅降级。 |
| `src/agent/repo-lock.ts` | 跨会话互斥锁（O_EXCL 原子创建 + PID 租约 + 陈旧回收）。序列化 `git worktree add/remove`，防注册表损坏。 |
| `src/agent/verification-snapshot-manager.ts` | 会话级 VSW 编排：`prepare`（懒建/刷新/策略）、`destroy`、`reapOrphanSnapshots`（按 owner pid 探活回收死会话残留）。 |
| `src/tools/run-tests.ts` | 两阶段执行：`runTestCommandIn` 单阶段抽取 + `tagVerification` 打 phase/ref 标签。 |

变更挂接点：`src/tools/types.ts`（`VerificationMetadata.snapshotRef/verificationPhase`、`ToolCallParams.baselineHead/verificationSnapshot`、`ToolResult.extraVerifications`）、`src/agent/verification-attribution.ts`（陈旧超越 + `integration_conflict` 归因）、`src/agent/delivery-gate-v2.ts`（`integration_conflict` → YELLOW）、`src/agent/ownership-ledger.ts`（`getBaselineHead`）。

## 5. 两阶段验证语义（`run_tests`）

```
execute(params):
  if !params.verificationSnapshot:        # 默认路径，未变
    return runTestCommandIn(params.cwd, …)

  # VSW 两阶段
  phaseA = runTestCommandIn(plan.path, …)   # 隔离快照
  tag(phaseA, 'isolated', plan.snapshotRef)
  phaseB = runTestCommandIn(params.cwd, …)  # 真实工作树
  tag(phaseB, 'integration', plan.snapshotRef)

  result = { ...phaseA, isError: phaseA.isError }   # Phase A 决定阻塞
  result.extraVerifications = [phaseB.verification]  # Phase B 随行记录
```

- **Phase A 是阻塞门**：它的 `isError` 决定 `run_tests` 整体成败。
- **Phase B 仅 advisory**：失败时输出 `[Phase B · integration on current HEAD] FAILED — … Delivery is NOT blocked by this.`，归类 `integration_conflict`，提示 rebase/协调而非阻塞。

## 6. 陈旧超越与集成冲突归因

- **陈旧超越**：`getEffectiveVerifications(events, currentSnapshotRef)` 丢弃 `snapshotRef !== currentSnapshotRef` 的验证（owned diff 已变，旧结果不再代表当前改动），计入 `staleSnapshotDropped`。
- **`integration_conflict`**：新增的 `AttributionClass`。Phase B 失败时归此类——本会话改动在隔离下通过，只是与 HEAD 上的并发改动冲突。`isBlocking: false`，门禁返回 `YELLOW`（`canDeliver: true`），消息提示先 rebase/协调。

## 7. §6 决策矩阵（`decideSnapshotPolicy`）

```
wantsSnapshot = forceSnapshot
             || preExistingDirtyCount  > 0
             || preExistingUntrackedCount > 0
             || sameCwdRunningSessions > 0

snapshot 当且仅当：isGitRepo && baselineHead 存在 && wantsSnapshot
否则降级为 in-place（非 git 仓 / 无 baselineHead / 无需隔离）
```

**默认安全**：单一干净会话（无脏基线、无并发会话、非 force）→ in-place，行为与 VSW 前完全一致。只有脏基线 / 并发会话 / `RIVET_VSW=1` 才激活快照隔离。

## 8. 并发安全（`RepoLock`）

- `O_EXCL` 原子创建锁文件；写入 `{pid, hostname, ownerToken, acquiredAtMs}`。
- **per-instance `ownerToken`**：每个 `RepoLock` 实例是独立持有者，同进程内两个实例也互斥；同实例可重入。
- **陈旧回收**：持有者 pid 不存活（`isPidAlive`，含 `/proc` zombie 排除）→ 回收锁。
- 只有 `.git/worktrees` 注册表 mutation（remove + add）进锁，per-session overlay 写入私有目录、留在锁外，缩短临界区。

## 9. 活接路径（生产激活）

| 位置 | 改动 |
|------|------|
| `loop-types.ts` / `tool-pipeline.ts` | `AgentConfig` 与 `ToolPipelineDeps` 新增 `verificationSnapshotManager?`。 |
| `tool-pipeline.ts` | `run_tests` 执行前 `prepare(ownedFiles)` → 注入 `params.verificationSnapshot`；try/catch 降级（VSW 异常绝不破坏验证）。 |
| `tool-execution.ts` | 两处 deps 装配透传 manager。 |
| `deliver-task.ts` | 两处 `getReport(…)` 传入 `getCurrentSnapshotRef?.()`。 |
| `bootstrap.ts` | 按会话构造 manager（喂 `baselineHead` / dirty 计数）；启动 `reapOrphanSnapshots`；`RIVET_VSW=1` 显式开关；CLI 路径 `sameCwdRunningSessions = () => 0`。 |

> `main.ts` / `main-ink.tsx` 等备用入口未挂接 manager；因相关字段均为 optional，这些路径默认走 in-place，行为不变。

## 10. 缓存安全

VSW 不改写消息历史、不在 anchor 前注入内容，所有 worktree/锁操作都在工具执行层、独立于对话上下文。对 DeepSeek V4 前缀缓存无影响。

## 11. 测试

| 套件 | 覆盖 |
|------|------|
| `snapshot-ref.test.ts` | ref 确定性 + diff 敏感性。 |
| `snapshot-policy.test.ts` | §6 矩阵全分支 + 降级。 |
| `repo-lock.test.ts` | 互斥 / 重入 / 陈旧回收 / pid 探活 / zombie 排除。 |
| `verification-snapshot.test.ts` / `snapshot-deps.test.ts` | worktree 创建 + overlay + 依赖物化。 |
| `verification-snapshot-manager.test.ts` | 懒建/复用/刷新 + orphan reaper。 |
| `verification-snapshot-attribution.test.ts` | snapshotRef 陈旧超越 + `integration_conflict` 归因。 |
| `run-tests-two-phase.test.ts` | 两阶段编排 + 标签 + Phase A 决定 isError。 |
| `tool-pipeline.test.ts` | run_tests 注入接缝（有 plan 注入 / 无 plan in-place）。 |

> **测试陷阱（已规避）**：`run_tests` spawn 子进程 `node --test`，若在 `node:test` 下运行会继承 `NODE_TEST_CONTEXT=child-v8`，导致子进程以 nested-child 模式退出 0（永不报错）。两阶段测试用 `runTool()` 在 spawn 前剥离该变量。
>
> **cron 测试 hermetic 化**：`cron-lock/scheduler/wiring` 测试从固定 `.test-tmp/*` 路径改为 `mkdtemp`，消除并发会话碰撞，且不再把 `*.corrupt-*` 残留泄漏进工作树。
