# Wave 1 Task 10：多 Session 协作协议 v2

> 任务编号：W1-10
> 日期：2026-05-21
> 状态：实施中
> 设计原则：天枢是产品，不是实验场

## 目标

多个天枢 session（含 coordinator + worker hands session）同时工作时：
1. **零 git 冲突** — 通过语义文件锁 + 冲突梯度预防
2. **零孤儿锁** — 通过心跳式过期 + 僵尸收割
3. **零死锁** — 通过图论死锁检测
4. **零人工干预合并** — 通过三级合并协议自动化 merge-back

## 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                     DelegationCoordinator                     │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ SessionReg  │  │ WorktreeCoor │  │  MergeQueue          │  │
│  │ (SQLite)    │  │              │  │  (有序 merge-back)    │  │
│  │             │  │              │  │                      │  │
│  │ sessions    │  │ worktrees    │  │ [Worker-A diff]      │  │
│  │ claims      │  │              │  │ [Worker-B diff]      │  │
│  │ heartbeats  │  │              │  │ [Worker-C diff]      │  │
│  └─────┬───────┘  └──────┬───────┘  └──────────┬──────────┘  │
│        │                 │                      │             │
│        ▼                 ▼                      ▼             │
│  ┌──────────────────────────────────────────────────────────┐│
│  │              CollaborationProtocol                        ││
│  │                                                          ││
│  │  1. acquireSemanticLock(intent, files, sessionId)        ││
│  │  2. detectConflictGradient(workerA, workerB) → 绿/黄/橙/红││
│  │  3. checkDeadlock(waitGraph) → 环检测                    ││
│  │  4. mergeBack(workerResult) → 三级协议                   ││
│  │  5. heartbeat(sessionId) → 锁活性维护                    ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

## 模块设计

### 模块 1：SemanticLock — 语义文件锁

**核心理念**：不只是"我要编辑这个文件"，而是声明"我要在文件中做什么"。

```typescript
interface LockIntent {
  /** 锁声明的操作类型 */
  operation: 'edit' | 'create' | 'delete' | 'rename' | 'refactor'
  /** 受影响文件列表 */
  files: string[]
  /** 语义描述：如 "修改 AgentLoop 的 turn 处理逻辑" */
  description: string
  /** 预估影响区域（可选） */
  domainHints?: DomainArea[]
}

interface SemanticLock {
  sessionId: string
  intent: LockIntent
  acquiredAt: number
  lastHeartbeat: number
  ttl: number  // 秒，默认 3600
}
```

**锁兼容矩阵**：

| 锁 A \ 锁 B | edit | create | delete | rename | refactor |
|---|---|---|---|---|---|
| edit | ❌（同文件） | ✅ | ❌ | ❌ | ⚠️（需检查） |
| create | ✅ | ✅（不同文件） | ❌ | ❌ | ✅ |
| delete | ❌ | ❌ | ❌ | ❌ | ❌ |
| rename | ❌ | ❌ | ❌ | ❌ | ❌ |
| refactor | ⚠️ | ✅ | ❌ | ❌ | ⚠️（需检查） |

⚠️ = 自动升级为冲突梯度检测

### 模块 2：ConflictGradient — 四色冲突梯度

不再是非黑即白的"冲突/不冲突"，而是一个连续的梯度：

```typescript
type ConflictLevel = 'green' | 'yellow' | 'orange' | 'red'

interface ConflictAssessment {
  level: ConflictLevel
  overlappingFiles: string[]
  detail: string
  recommendation: string
}
```

| 级别 | 含义 | 自动处理 |
|---|---|---|
| 🟢 Green | 无文件重叠 | 直接并行 |
| 🟡 Yellow | 文件重叠但意图互补 | 并行但加入合并队列 |
| 🟠 Orange | 文件重叠且意图可能冲突 | 序列化：等 A 完成后 B 开始 |
| 🔴 Red | 文件重叠且意图冲突 | 阻止：建议协调员重新分配 |

检测算法：
1. 计算文件集合交集
2. 无交集 → Green
3. 有交集，检查 domainHints 是否互补 → Yellow
4. 有交集，operation 互斥 → Orange/Red
5. refactor 操作特殊处理：检查 import-graph 确认影响范围

### 模块 3：MergeProtocol — 三级合并协议

```
Level 1: Auto-cherry-pick (无冲突，直接应用)
    ↓ 失败
Level 2: Smart-rebase (检测到冲突，尝试智能 rebase)
    ↓ 失败
Level 3: Escalate (人工介入，生成冲突报告)
```

```typescript
interface MergeResult {
  strategy: 'auto_cherry_pick' | 'smart_rebase' | 'escalate'
  success: boolean
  appliedFiles: string[]
  conflictedFiles: string[]
  report?: string  // escalate 时的详细报告
}
```

**Level 1: Auto-cherry-pick**
- 条件：worker diff 中所有修改的文件不在其他已 merge 的 diff 中
- 操作：`git cherry-pick --no-commit` → 检查 → `git commit`
- 失败回退到 Level 2

**Level 2: Smart-rebase**
- 条件：存在文件重叠但不是相同行
- 操作：提取 diff hunks → 按行号排序 → 逐个应用
- 如果 hunk 上下文不匹配，回退到 Level 3

**Level 3: Escalate**
- 生成冲突报告：包含双方的 diff、意图、影响文件
- 返回给 coordinator 作为 WorkerResult artifact
- 由主 session 的模型决定如何处理

### 模块 4：DeadlockDetector — 图论死锁检测

Worker 等待资源分配图（Wait-For Graph）中的环检测：

```
Worker A → [file-1] ← Worker B
Worker B → [file-2] ← Worker A   ← 死锁！
```

使用 DFS 环检测算法，每 30 秒扫描一次。

```typescript
interface DeadlockReport {
  cycle: string[]  // [sessionIdA, sessionIdB, ...]
  resources: string[]  // [filePath, ...]
  resolved: boolean
}
```

解决策略：选择最新请求的 session 作为"受害者"，释放其所有锁。

### 模块 5：HeartbeatExpiry — 心跳式锁过期

现有 SessionRegistry 已有 `heartbeat()` 和 `detectCrashedSessions()`。
增强：

1. **锁 TTL**：每个锁有 TTL（默认 3600s），每次 heartbeat 续期
2. **僵尸收割**：每 60s 扫描，清除 heartbeat 超时的 session 及其锁
3. **优雅降级**：session 异常退出时，锁由下一次 scan 自动释放

### 模块 6：MergeQueue — 有序合并队列

Worker 完成后，diff 进入有序合并队列：

```typescript
interface MergeQueueEntry {
  workerId: string
  branch: string
  diff: string
  changedFiles: string[]
  conflictLevel: ConflictLevel
  enqueuedAt: number
  priority: number  // 绿优先，黄次之，橙最后
}
```

合并顺序：
1. Green entries 先合并（无冲突风险）
2. Yellow entries 按入队顺序合并
3. Orange entries 等待所有绿/黄完成后序列化合并
4. Red entries 不入队，直接 escalate

## 与现有代码的集成点

### 1. coordinator.ts

在 `delegateOrder()` 中：
- dispatch 前：调用 `acquireSemanticLock()`
- dispatch 后：检查 `detectConflictGradient()`
- hands session 完成后：加入 `MergeQueue`

### 2. hands-session.ts

在 `runHandsSession()` 中：
- 开始前：由 coordinator 分配语义锁
- 结束后：diff 进入 merge queue 而不是直接丢弃

### 3. session-registry.ts

增强：
- 添加 `semantic_claims` 表
- 添加 `heartbeats` 时间戳追踪
- 添加锁 TTL 检查

## 测试策略

每个模块独立测试 + 集成测试：

1. `semantic-lock.test.ts` — 锁兼容矩阵测试
2. `conflict-gradient.test.ts` — 四色梯度边界测试
3. `merge-protocol.test.ts` — 三级合并测试（mock git）
4. `deadlock-detector.test.ts` — 环检测测试
5. `merge-queue.test.ts` — 有序合并测试
6. `collaboration-protocol.test.ts` — 集成测试

## 交付物

- [ ] `src/agent/semantic-lock.ts`
- [ ] `src/agent/conflict-gradient.ts`
- [ ] `src/agent/merge-protocol.ts`
- [ ] `src/agent/deadlock-detector.ts`
- [ ] `src/agent/merge-queue.ts`
- [ ] `src/agent/collaboration-protocol.ts` — 门面模式整合
- [ ] 6 个测试文件
- [ ] coordinator.ts 集成
- [ ] session-registry.ts 增强
