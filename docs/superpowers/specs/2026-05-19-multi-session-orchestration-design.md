# 多会话并发编排系统（Multi-Session Orchestration）

## 背景

### 用户需求
同一项目目录允许多个 Rivet 会话并行工作。动态编排工作区，关联文件和测试文件不互相干扰。识别任务依赖关系——当一个任务完成后，关联任务的智能体自动开始执行；在那之前，它等待。

### 当前问题
`lwt-guard.ts` 使用全局 `~/.rivet/state/agent.lock` 阻止多实例。整个系统假设单进程独占。

### 已有基础设施
- `WorkOrderQueue`：DAG 依赖 + 优先级 + 去重（`src/agent/work-queue.ts`）
- `DelegationCoordinator`：worker 调度 + 模型路由（`src/agent/coordinator.ts`）
- `worktree-coordinator.ts`：git worktree 生命周期管理
- `stigmergy.ts`：跨 session 信息素（decay + spatial signal）
- `isConcurrencySafe` 标志：已声明未启用（`src/tools/types.ts`）
- `conflict-detect.ts`：claim 级冲突检测
- `coordination-policy.ts`：brain/hands/readonly 角色分离

### 调研发现
- **行业共识（2026）**：worktree 隔离 + atomic claim DAG + AST semantic merge
- **coord 项目**：SQLite WAL + blocking wait 原语——最简可行方案
- **Weave**：Tree-sitter AST merge 100% clean merge vs Git 48%
- **OpenAI Symphony**：独立 workspace per issue，orchestrator reads / agents write
- **跨领域**：MVCC copy-on-write + 空管三层模型 + 蚁群 decaying claim

---

## 最终方案：渐进式多会话编排

### 架构概览

```
┌─────────────────────────────────────────────────────┐
│  Rivet TUI (Primary / Coordinator)                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  StarChart Scheduler (DAG + 星域路由)          │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐      │  │
│  │  │Worker A │  │Worker B │  │Worker C │      │  │
│  │  │worktree │  │worktree │  │(waiting)│      │  │
│  │  │破军域   │  │天梁域   │  │depends  │      │  │
│  │  │api/     │  │ui/      │  │on A+B   │      │  │
│  │  └────┬────┘  └────┬────┘  └────┬────┘      │  │
│  │       │             │             │           │  │
│  │  ┌────▼─────────────▼─────────────▼────┐     │  │
│  │  │  Coordination Layer                  │     │  │
│  │  │  SQLite WAL (claims + deps + state)  │     │  │
│  │  │  Unix Socket (event broadcast)       │     │  │
│  │  │  Stigmergy (cross-session signals)   │     │  │
│  │  └─────────────────────────────────────┘     │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Merge Layer                                  │  │
│  │  AST-aware merge (Tree-sitter function-level) │  │
│  │  Hot-file sequencing (barrel files)           │  │
│  │  Conflict → TUI prompt for user resolution    │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

外部 Rivet 实例可通过 Unix socket 连接到同一 coordinator
```

### 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 状态存储 | SQLite WAL | JSON 多进程写入不安全（Scout 5 验证） |
| 通知机制 | Unix domain socket | Push 而非 poll，零延迟依赖触发 |
| 文件隔离 | Git worktree per worker | 已有 worktree-coordinator 基础设施 |
| 冲突解决 | AST function-level merge | Weave 证明消除 95% 假冲突 |
| 调度模型 | 扩展现有 WorkOrderQueue | 已有 DAG + 依赖 + 去重 + 优先级 |
| Coordinator 位置 | 主 TUI 进程 | 不引入独立 daemon；崩溃 = 用户退出 |
| 热文件策略 | AST merge + barrel file sequencing | 两 agent 加不同 export 不冲突 |

### 两种运行模式

**模式 A（TUI 内编排 — 默认）：**
用户在主 TUI 中描述任务集 → 主 agent 分解为 DAG → spawn headless worker 进程 → TUI 显示进度 → 自动 merge-back

**模式 B（多终端协作）：**
用户开多个终端各自启动 Rivet → 第一个实例成为 coordinator → 后续实例通过 socket 注册 → 共享 claim registry → 依赖通知跨进程传递

---

## SQLite Schema

```sql
-- Session 注册表（替代全局锁）
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('coordinator','worker','standalone')),
  task_description TEXT
);

-- 文件 Claim（带 TTL）
CREATE TABLE claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_path TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared_read')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(file_path, claim_type) -- exclusive claim 唯一
);

-- 任务依赖 DAG
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','blocked')),
  description TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(task_id, depends_on)
);
```

---

## 依赖触发协议

```
Worker A 完成:
  1. UPDATE tasks SET status='completed' WHERE id='A'
  2. SELECT task_id FROM task_deps WHERE depends_on='A'
     GROUP BY task_id HAVING COUNT(*) = (
       SELECT COUNT(*) FROM task_deps d
       JOIN tasks t ON d.depends_on = t.id
       WHERE d.task_id = task_deps.task_id AND t.status = 'completed'
     )
  3. 对每个可解锁的 task → 通过 Unix socket 发送 EVENT_TASK_UNBLOCKED
  4. 等待中的 Worker C 收到事件 → 检查自己的 task 是否在解锁列表 → 开始执行
```

---

## 与星域系统的融合

| 星域 | 调度策略 | 并发行为 |
|------|---------|---------|
| 破军 | 乐观并发，允许冲突后 merge | 多 worker 同时启动，AST merge 解决 |
| 天府 | 保守串行，claim exclusive | 同文件域只允许一个 worker |
| 天梁 | 按 spec 顺序执行 | 严格 DAG 拓扑排序 |

Worker 的星域由主 agent 在 DAG 分解时根据任务特性分配（复用 `matchDomain()`）。

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| SQLite WAL macOS 兼容性 | WAL 在 APFS 上完全支持；测试覆盖 |
| Worker 崩溃遗留 worktree | heartbeat 超时（30s）→ coordinator reap + cleanup |
| 两 worker 改同一函数体 | AST merge 检测 → TUI 提示用户 → 用户选择保留哪个 |
| node_modules 隔离 | worktree symlink 到主仓 node_modules；worker 禁止 npm install |
| Coordinator 崩溃 | worker 检测 socket 断开 → 保存 diff 到 `.rivet/orphan-diffs/` → 用户下次启动时提示恢复 |
| 依赖推断错误 | Phase 1-2 用显式声明；Phase 3 才引入基于 import graph 的自动推断 |

---

## 实施路径

### Phase 1（1 周）：多实例共存 + 文件 Claim

- 替换 `lwt-guard.ts` 全局锁为 SQLite session 注册表
- 实现 `ClaimRegistry` 类（acquire/release/check/reap_stale）
- 现有 `DelegationCoordinator` 的 hands worker 使用 claim 检查
- 允许多 Rivet 实例同时运行（各自注册，claim 互斥）
- **成功标准**：两个实例编辑不同文件无冲突；同文件 claim 被拒绝并提示
- **退出条件**：SQLite 问题 → 降级为 flock + JSONL append

### Phase 2（1 周）：依赖调度 + 事件通知

- 实现 Unix domain socket coordinator（`~/.rivet/state/coordinator.sock`）
- 协议：`REGISTER` / `CLAIM` / `COMPLETE` / `WAIT` / `EVENT`
- 扩展 `WorkOrderQueue.dependencies` 为跨进程可见
- 实现 `wait(taskId)` 阻塞 + `complete(taskId)` 广播
- **成功标准**：Task B depends on A → A 完成后 B 在 <100ms 内自动启动
- **退出条件**：IPC 复杂度过高 → 降级为 fs.watch 监听 SQLite 变更

### Phase 3（2 周）：TUI 星图调度 + AST Merge

- TUI 加 "星图调度" 视图（DAG 可视化 + worker 状态 + 进度）
- 主 agent 自动分解任务为 DAG（基于用户描述 + 文件依赖图）
- Worker 完成后 AST merge-back（Tree-sitter TypeScript parser）
- 冲突时 TUI 内联 diff 显示 + 用户裁决
- 星域路由影响调度策略（破军并发 / 天府串行 / 天梁顺序）
- **成功标准**：用户描述 3 任务 → 自动并行 → combined diff → 审查通过

---

## 下一步

Phase 1 的第一个具体动作：在 `src/agent/` 下创建 `session-registry.ts`，实现基于 SQLite（better-sqlite3）的 session 注册 + claim 管理，替换 `lwt-guard.ts` 的全局锁。
