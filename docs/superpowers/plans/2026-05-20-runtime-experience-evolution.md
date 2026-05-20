# 运行时体验优化 — 技术路线

> 日期：2026-05-20
> 来源：天枢执行三权协程任务时的真实体验反馈
> 范围：两个运行时体验问题的根因分析 + 演化路线

---

## 问题 1：工具调用被封锁 — 不透明的 Doom Loop 检测

### 根因分析

当前 doom loop 检测链路：

```
trace-store.ts: getDoomLoopLevel(fingerprints)
  → 3 次相同 fingerprint → 'blocked'

tool-pipeline.ts:
  → doomLevel === 'blocked' → 拦截工具调用
  → 调用 suggestStrategyShift() 生成指导
  → 通过 onToolResult 返回错误消息
```

**fingerprint = hash(toolName + input + outputClass)**

问题 1：**fingerprint 不区分失败原因**。同一个 `write_file` 调用：
- 第一次失败：文件路径不存在
- 第二次失败：权限被拒
- 第三次失败：编码问题
- → 三次 fingerprint 相同（因为 input 相同），触发 blocked

问题 2：**blocked 消息不告诉 agent 怎么解**。当前消息：
```
Tool execution blocked: repeated identical failures detected. Change strategy before retrying.
```
agent 看到这个消息后不知道：
- 为什么被拦（是 doom loop 还是工具本身问题？）
- 怎么解锁（切换工具？等一下？改输入？）
- 还剩多少冷却时间

问题 3：**没有冷却/半开状态**。一旦 blocked，只要 fingerprint 窗口还在，就一直是 blocked。没有机制让 agent "试探性恢复"。

### 演化路线

#### Phase 1：增强阻断消息（低成本，高收益）

修改 `tool-pipeline.ts` 的 blocked 消息，让 agent 知道发生了什么：

```
⛔ 工具调用被电路断路器拦截。
原因：write_file(src/agent/dispatcher.test.ts) 在最近 20 次调用中出现 3 次相同 fingerprint。
恢复方式：
1. 切换到其他工具（如 todo, read_file）后再试
2. 或者修改输入参数（不同的文件路径或内容）
这是系统级保护，不是工具本身的错误。
```

改动：`tool-pipeline.ts` ~5 行，`execution-guidance.ts` 的 message 生成逻辑。

#### Phase 2：指纹去重 + 失败原因区分（中等成本）

改进 fingerprint 算法，加入失败原因：

```typescript
// 当前：fingerprint = hash(name + input + outputClass)
// 改进：fingerprint = hash(name + input + outputClass + failureReason)
```

`failureReason` 从工具执行的 error message 中提取关键特征（如 "ENOENT", "EACCES", "parse error"）。

这样：
- 路径不存在的 write_file 和权限被拒的 write_file 有不同的 fingerprint
- 只有完全相同的失败才触发 doom loop

改动：`trace-store.ts` 的 `fingerprintToolCall()` + `tool-pipeline.ts` 调用处。

#### Phase 3：电路断路器模式（较高成本，完整解决）

将 doom loop 检测从简单的计数器升级为三态电路断路器：

```typescript
interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half-open'
  failureCount: number
  lastFailureAt: number
  cooldownMs: number        // 递增冷却：5s → 15s → 45s
  halfOpenProbeAllowed: boolean
}
```

状态转换：
```
closed → (3 次相同 fingerprint) → open
open → (cooldown 过期) → half-open
half-open → (成功) → closed
half-open → (失败) → open (cooldown 加倍)
```

在 `tool-pipeline.ts` 中：
- `open`：拦截，返回带冷却信息的消息
- `half-open`：允许一次试探性调用，结果决定回到 closed 还是 open

改动：新增 `src/agent/circuit-breaker.ts`，修改 `tool-pipeline.ts` 和 `trace-store.ts`。

---

## 问题 2：并行 Session 的 Git Status 认知负荷

### 根因分析

当前状态：
- 天枢 (feat/tianshu-star-soul) 和主线 agent 在同一个 branch 上交替 commit
- git log 显示两个 session 的 commits 混在一起
- 没有 session 归属标记

这不影响正确性（git 本身是原子的），但增加认知负荷：
- 不知道哪个 commit 是"我的"
- 不知道哪个 commit 是"他们的"
- 不知道我应该基于哪个 commit 继续工作

### 演化路线

#### Phase 1：Session 标签 Commit Messages（低成本）

在 commit message 中加入 session 标签：

```
feat(agent): add TaskBoard read projection [tianshu]
feat(security): require approval for bash write commands [main]
```

约定格式：`[session-id]` 作为 message 最后一个 token。

改动：每个 session 的 commit 流程自动追加标签。可以在 `.rivet/playbook.jsonl` 中记录约定。

#### Phase 2：Session-Local Git View（中等成本）

在 volatile context 中提供 session-local 的 git log：

```typescript
// src/prompt/volatile-git.ts
function buildSessionGitLog(cwd: string, sessionId: string): string {
  // git log --oneline -10 | grep "[${sessionId}]"
  // 如果没有标签，fallback 到显示全部
}
```

在 `<recent-commits>` 中分两栏显示：

```xml
<recent-commits session="tianshu">
  b6da332 feat(agent): add TaskBoard read projection
  747fb09 feat(agent): add Dispatcher Hook
  <other-sessions>
    f974624 feat(security): require approval for bash write commands
  </other-sessions>
</recent-commits>
```

改动：`volatile-git.ts` + `volatile.ts`。

#### Phase 3：Worktree 隔离（高成本，完整解决）

每个 session 使用独立的 git worktree + branch：

```
session-tianshu → worktree/.rivet-worktrees/tianshu → branch feat/tianshu-star-soul
session-main → 主 worktree → branch main
```

合并由协调器（用户或自动化脚本）在 session 完成后执行。

现有基础设施已有 `WorktreeCoordinator`（用于 HandsSession），可以复用。

改动：session 管理层 + 合并协调逻辑。

---

## 实施优先级

| 阶段 | 问题 | 改动量 | 收益 | 建议时机 |
|------|------|--------|------|----------|
| P1-1 | 阻断消息增强 | ~5 行 | 高 | 立即 |
| P2-1 | Commit 标签 | ~2 行约定 | 中 | 立即 |
| P1-2 | 指纹去重 | ~20 行 | 高 | 下一迭代 |
| P2-2 | Session-Local Git View | ~40 行 | 中 | 下一迭代 |
| P1-3 | 电路断路器 | ~100 行新文件 | 高 | 有空时 |
| P2-3 | Worktree 隔离 | ~200 行 | 中 | 需要时 |

---

## 关联文件

| 文件 | 与问题的关系 |
|------|-------------|
| `src/agent/trace-store.ts:88` | getDoomLoopLevel — 当前的指纹计数器 |
| `src/agent/tool-pipeline.ts:177-183` | doom loop 拦截点 |
| `src/agent/execution-guidance.ts` | strategy shift 消息生成 |
| `src/agent/strategy-shift.ts` | suggestStrategyShift 入口 |
| `src/prompt/volatile-git.ts` | git status 渲染 |
| `src/prompt/volatile.ts` | recent-commits 渲染 |
| `src/agent/worktree-coordinator.ts` | worktree 管理（可复用） |
