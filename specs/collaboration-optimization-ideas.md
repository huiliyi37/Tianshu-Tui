# 多 Session 协作机制优化方向

> 创建时间：2026-06-04
> 状态：备忘，待团队模式时实现
> 前置条件：不破坏 prefix cache，改动在 agent 协作层，不影响 API 层

## 当前协作机制组件

| 组件 | 文件 | 职责 |
|------|------|------|
| SessionRegistry | `session-registry.ts` | SQLite 持久化注册表（sessions/claims/events/cycle_relay） |
| SemanticLock | `semantic-lock.ts` | 语义文件锁（advisory，TTL + 心跳续期） |
| ConflictGradient | `conflict-gradient.ts` | 四色冲突梯度检测（🟢🟡🟠🔴） |
| DeadlockDetector | `deadlock-detector.ts` | 图论死锁检测（DFS 环检测） |
| MergeProtocol | `merge-protocol.ts` | 三级合并协议（auto-cherry-pick → smart-rebase → escalate） |
| MergeQueue | `merge-queue.ts` | 有序合并队列（Green 优先） |
| FsWatcher | `fs-watcher.ts` | 文件系统事件监听（top-level + 子目录） |
| StigmergyHook | `stigmergy-hook.ts` | 信息素机制（virtue signals + pheromone deposit） |
| CrossSessionHook | - | 跨 session 事件注入 |

## 当前锁机制的局限

### 文件级排他过于保守

当前 `SemanticLock` 是文件级的。两个 session 编辑同一文件 → 排他冲突（exclusive）→ 必须串行。

**实际场景**：`loop.ts`（1700+ 行）被拆成 13 个子任务时，多个 worker 可能需要编辑该文件的不同区域（L100-200, L500-600, L1200-1300），当前会被阻塞为串行执行。

### 没有版本号追踪

锁只声明"我要编辑这个文件"，但不记录文件的当前版本。合并时可能遇到：
- Session A 编辑前文件是 v1
- Session B 编辑前文件也是 v1
- 两个都基于 v1 的 diff 合并时可能冲突

## 可能的优化方向

### A. 行级冲突检测（Hunk-level Conflict Detection）

**效果**：两个 session 编辑同一文件的不同行 → 可以并行

**实现思路**：
1. `LockIntent` 添加可选的 `lineRanges?: Array<{start: number, end: number}>`
2. 冲突检测时，如果文件重叠且操作是 `edit`，检查行范围是否重叠
3. 行范围不重叠 → `conditional`（可并行，合并时 cherry-pick）
4. 行范围重叠 → `exclusive`（必须串行）

**与现有工具的衔接**：
- `edit_file` 的 `old_string` 可以通过 `indexOf` 定位行号
- `hash_edit` 的 anchor 本身就是行级的（`L42:a1b2c3d4`）
- 可以在工具执行后记录实际编辑的行范围

**对 prefix cache 的影响**：无。改动在 agent 协作层，不影响 API 请求内容。

**复杂度**：中等。需要修改 `LockIntent` 接口、`SemanticLockManager.acquire()`、`detectConflictGradient()`。

### B. 乐观锁 + 版本号（Optimistic Lock with Version）

**效果**：合并时检测文件是否被其他 session 修改过，避免静默覆盖

**实现思路**：
1. `SemanticLock` 添加 `fileVersion?: string`（文件内容 hash 或 mtime）
2. 获取锁时记录文件的当前版本
3. 合并时检查文件版本是否变化
4. 版本变化 → 重新读取 + 智能合并

**与现有机制的关系**：
- `edit_file` 已有 mtime 检测（防 stale edit），但这只保护单 session
- 跨 session 需要共享版本信息

**对 prefix cache 的影响**：无。

**复杂度**：低。主要是给 `SemanticLock` 添加字段，在合并时检查。

### C. 实时文件变化感知（Cross-session File Change Notification）

**效果**：当其他 session 修改了文件时，实时通知当前 session

**实现思路**：
1. `StigmergyHook` 已经在 publish `file_changed` 事件到 SQLite
2. 可以在主循环中轮询 events 表，检测其他 session 的文件修改
3. 检测到冲突时，注入 system reminder 提醒模型重新读取文件

**与现有机制的关系**：
- `FsWatcher` 监听文件系统事件，但不区分是哪个 session 写的
- `SessionRegistry` 的 events 表已经有 `file_changed` 事件
- 需要一个轻量级的轮询机制

**对 prefix cache 的影响**：无。只是注入 system reminder，不改变 API 结构。

**复杂度**：低。主要是轮询 SQLite events 表 + 注入提醒。

### D. 语义感知的锁降级（Semantic-aware Lock Downgrade）

**效果**：对于 refactor 操作，根据实际影响范围动态调整锁级别

**当前问题**：`refactor` 在兼容矩阵中是 `conditional`，但实际上 refactor 可能只影响一个函数，不影响同一文件的其他函数。

**实现思路**：
1. 在 `ConflictGradient` 的 `conditional` 分支中，引入更细粒度的语义分析
2. 如果两个 `refactor` 操作的 description 不重叠（如"重构 getWeather" vs "重构 calculateTotal"），降级为 `compatible`

**对 prefix cache 的影响**：无。

**复杂度**：高。需要 NLP 或关键词匹配来判断语义重叠。

## 优先级建议

| 方向 | 价值 | 复杂度 | 建议优先级 |
|------|------|--------|-----------|
| B. 乐观锁+版本号 | 防止静默覆盖 | 低 | P1（防 bug） |
| C. 实时文件变化感知 | 提前发现冲突 | 低 | P2（提升体验） |
| A. 行级冲突检测 | 提升并行度 | 中 | P3（性能优化） |
| D. 语义感知锁降级 | 精细化冲突 | 高 | P4（锦上添花） |

## 实现约束

1. **不破坏 prefix cache**：所有改动在 agent 协作层（`src/agent/`），不影响 API 请求结构
2. **向后兼容**：新字段都是 optional，现有调用方不需要修改
3. **渐进式**：每个方向可以独立实现，不需要同时做
4. **测试覆盖**：每个新功能都需要对应的测试文件（`src/agent/__tests__/xxx.test.ts`）
