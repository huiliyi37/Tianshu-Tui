# Wave 1 任务文档：多 Session 协作协议

> 任务编号：W1-10
> 优先级：高
> 预估：单 session，1.5 小时
> 前置依赖：无

## 目标

多个天枢 session 同时在同一仓库工作时，不产生 git 冲突，不互相覆盖文件，能感知彼此的存在。

## 背景

已验证场景：4 TUI + 2 Opus 同分支 13 条独立交付。当前靠 `.rivet/dev-guide.md` 中的人工规则（分支命名、文件所有权）。需要运行时自动化。

## 架构设计

### 协作层级

```
Level 0: 无感知 — 各 session 独立工作，靠 git 解决冲突（当前状态）
Level 1: 文件锁 — session 声明正在编辑的文件，其他 session 避让
Level 2: 任务分配 — 中心化任务板，session 领取不重叠的任务
Level 3: 实时协作 — session 间实时通信，协调决策
```

**本次实现 Level 1**（文件锁 + 冲突检测）。

### 文件锁机制

```
.rivet/locks/
├── <session-id>.json    每个 session 的锁文件
└── manifest.json        汇总视图
```

锁文件格式：
```json
{
  "sessionId": "abc123",
  "pid": 12345,
  "startedAt": "2026-05-21T14:00:00Z",
  "files": ["src/agent/loop.ts", "src/prompt/engine.ts"],
  "task": "chat mode implementation"
}
```

### 冲突检测

在 tool-pipeline 中，write_file / edit 执行前：
1. 读取 `.rivet/locks/` 下所有锁文件
2. 检查目标文件是否被其他 session 锁定
3. 如果锁定：
   - 警告模型"此文件正被 session X 编辑，建议等待或选择其他文件"
   - 不阻止执行（advisory lock，不是 mandatory lock）

### 自动清理

- session 正常退出时删除自己的锁文件
- session 异常退出时，其他 session 检测到 PID 不存在 → 清理孤儿锁
- 锁文件超过 2 小时自动过期

## 实现计划

### Task 1: 锁管理器

创建 `src/agent/session-lock.ts`：
- `acquireLock(sessionId, files, task): void`
- `releaseLock(sessionId): void`
- `checkConflict(file): ConflictInfo | null`
- `cleanStaleLocks(): void`

### Task 2: 集成到 tool-pipeline

修改 `src/agent/tool-pipeline.ts`：
- write_file / edit 执行前调用 `checkConflict`
- 冲突时在 tool_result 中附加警告（不阻止执行）

### Task 3: 集成到 AgentLoop 生命周期

修改 `src/agent/loop.ts`：
- 启动时 `acquireLock`（初始为空文件列表）
- 每次 write/edit 成功后更新锁文件列表
- 退出时 `releaseLock`
- 启动时 `cleanStaleLocks`

### Task 4: 分支命名自动化

修改 `src/agent/checkpoint.ts`：
- 多 session 时自动创建 `feat/tianshu-<task>-<session-short-id>` 分支
- 单 session 时保持当前行为

### Task 5: 测试

- 锁文件创建/读取/删除
- 冲突检测（两个 session 锁同一文件）
- 孤儿锁清理（PID 不存在）
- 过期锁清理

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/session-lock.test.ts
```

## 不做的事

- 不做 Level 2（任务板）— 后续迭代
- 不做 Level 3（实时通信）— 后续迭代
- 不做 mandatory lock（不阻止执行，只警告）
- 不做跨机器协作（只支持同一机器多 session）
