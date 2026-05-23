T1 · Worktree Reality Contract — 接入就绪状态

日期：2026-05-23

## 已交付

- `src/agent/worktree-reality.ts` — 纯函数 `detectWorktreeReality(cwd, injected?)` 完成
- `src/agent/__tests__/worktree-reality.test.ts` — 10/10 测试通过
- severity 三级：green / yellow / red
- HEAD 不匹配 → red；branch/cwd/isGitRepo 不匹配 → yellow

## 未接入（标记后续）

接入 AgentLoop 需要：

1. `src/agent/loop.ts:671` `AgentLoop.run()` 中调用 `detectWorktreeReality`
2. 从 `gitStatusCache`（volatile-git.ts）提取注入上下文（branch、HEAD）
3. 在 `src/prompt/volatile.ts` 的 `buildDynamicAppendix()` 中新增 `<worktree-warning>` 块
4. **不能**加到 frozen block（会破坏 prefix cache）
5. 估计 ~80 行改动，3-4 个文件

### 接入判断条件

当以下任一条件满足时启动接入：
- agent 出现"上下文当现实"退行模式（spec F 项）
- 稳定态迭代需要 pre-flight check 机制
- 用户明确要求

### 注意的陷阱

- `runStartupHealthCheck` 已定义但从未被调用——不要复制这个模式（定义了不用等于没有）
- volatile 分层：frozen（缓存友好）vs dynamic appendix（每 turn 变化）。warning 必须进 dynamic
- cwd mismatch 当前判定 yellow——如果实际场景中 cwd 不匹配意味着 agent 在错误仓库操作，后续可升级为 red
