# 变更落地闭环修复记录 — 归档保护 + 会话级基线 Diff + 落地动作条

> 产出日期：2026-07-05
> 实施 commit：`9be1edef`（15 files，+1095/-40）
> 背景：桌面端工程任务闭环对标 Codex 2.0 / Cursor 3.0 的缺口分析（见 `2026-06-27-codex-desktop-gap-analysis.md` 的延续调查）
> 设计决策（用户确认）：**双通道**（server 直接 git + 保留「让 agent 提交」）；合并策略 **squash merge**

## 问题：worktree 会话的工作成果没有出口

隔离 worktree 会话（`isolatedWorktree: true`）让 agent 在独立分支上并行工作，但闭环的后半段完全缺失，三个缺陷环环相扣：

| # | 缺陷 | 后果 | 严重度 |
|---|---|---|---|
| ① | `archiveSession()` 无条件 `removeWorktree` → `git branch -D` 强删分支 | **归档 = 数据丢失**。未合并的提交蒸发，未提交的改动被 `worktree remove --force` 直接丢弃 | 数据丢失级 |
| ② | `/git/working-tree` 和 `/git/diff` 永远用 `defaultCwd` + `HEAD` | worktree 会话的 Changes tab 显示的是**主工作区**的脏改动；agent 中途 commit 后已提交部分从 diff 消失 | 功能错误 |
| ③ | GithubPanel 只能 review 已有 PR | 会话成果没有 Commit / Merge back / Create PR 通道，只能靠用户手动去终端操作 | 闭环缺失 |

①③ 组合最危险：用户没有落地出口（③），随手归档清理会话（①），工作直接消失。

## 修复

### 阶段一：归档保护（止血）

`src/agent/worktree.ts`：

- `hasUnlandedWork(cwd, wtPath, branch)` — 双信号探测：worktree 内 `git status --porcelain -uall` 判脏（**排除 `.vsw-owner.json` 基建标记**，否则每个新 worktree 都误报脏）+ 主 cwd `git rev-list --count HEAD..branch` 判未合并提交。**git 出错时 fail-open 视为有工作**——宁可多保留分支，不静默毁数据。
- `commitAll(cwd, message, { noVerify? })` — 结构化返回（sha / nothingToCommit / error），`git add` 排除 owner 标记。
- `removeWorktree(..., { keepBranch: true })` — 保留分支只删 worktree 目录。

`session-manager.archiveSession`：脏工作区先自动 `rivet: archive checkpoint` 提交（`--no-verify`，清理动作不该被 hook 卡住），有未合并提交则 keepBranch，`status` 事件带 `branchKept: true`。

**同族漏洞顺手收口**：`cleanupStaleHandsBranches`（bootstrap 启动清理）原来强删所有孤儿 `rivet-hands-*` 分支——归档保留的分支会在下次启动被它清掉，等于白保护。现在带未合并提交的分支不删。

### 阶段二：会话级基线 diff

- `getWorkingTreeFiles` / `getFileDiff` 接受 `baseRef` 参数（默认 `HEAD`），带 `safeBaseRef` 护栏：拒绝 `-` 开头（选项注入）和含 `~^:.\` 空白的 ref，畸形输入回退 HEAD。
- `SessionRecord.baselineHead` — worktree 创建成功后 `rev-parse HEAD` 记录任务起点。
- 新路由 `GET /sessions/:id/git/working-tree|diff` — 解析 `cwd = worktreePath ?? defaultCwd`、`baseRef = baselineHead ?? 'HEAD'`。**agent 中途 commit 后，Changes tab 仍显示完整任务 delta**（numstat 对基线可见，status 补未提交部分）。`.vsw-owner.json` 从文件列表过滤。
- 旧全局 `/git/*` 路由保留（Git graph 面板还在用）。
- 桌面 `useWorkingTree(sessionId)` / `useFileDiff(path, sessionId)`，queryKey 带 sessionId 避免跨会话缓存串扰。

### 阶段三：落地动作条

服务端三方法（`session-manager.ts`，失败返回结构化错误 + 路由 409，不抛异常）：

- `commitSessionChanges(id, message?)` — 会话 cwd 内 `commitAll`，成功发 `landing` SSE 事件。
- `mergeSessionBack(id)` — 仅 worktree 会话。先 checkpoint 未提交改动（squash 会拍平，不丢）→ `squashMergeBranch`：主工作区脏则**拒绝**；冲突则收集 `--diff-filter=U` 文件列表后 `merge --abort` + `reset --merge` **回滚**；hook 拒绝 commit 也回滚。
- `createSessionPr(id, title?, body?)` — checkpoint → `pushBranch`（`GIT_TERMINAL_PROMPT=0` + 60s 超时，防凭据提示挂死）→ `gh pr create`（无 title 用 `--fill`），返回 PR URL。

桌面 `ChangesTab` 底部 `LandingBar`：

- `Commit`（内联 message 输入，留空用默认）+ `让智能体提交`（组 prompt 走 `onSendPrompt`，经 agent 提交纪律通道）——双通道。
- worktree 会话追加 `Merge back` / `Create PR`。
- **agent running 时禁用直接 git 按钮**（避免与 agent 写文件竞态）。
- 结果内联提示：成功 sha / PR 链接 / 冲突文件列表；成功后 invalidate workingTree query。
- i18n：`desktop/src/locales/{en,zh-CN}/thread.json` 补 20 条 `landing*` 文案。

## 关键语义陷阱：squash merge 之后 rev-list 判不出「已落地」

这是实施中发现的最重要的坑，**改动归档/合并逻辑前必须理解**：

squash merge 在主分支创建的是**新提交**，worktree 分支上的原始提交对 main 依然不可达 → `git rev-list HEAD..branch` 永远 > 0 → 归档保护会把**已经落地**的分支误判为「有未合并工作」而永久保留。

解法：`SessionRecord.landedHead` — merge-back 成功时记录分支头 sha。归档时若分支头**未越过**该标记（且工作区干净），视为已落地，安全删除。merge 之后又有新工作 → 分支头移动 → 标记失效 → 分支保留，语义正确。

副作用（有意接受）：崩溃残留的 squash 已合并孤儿分支，`cleanupStaleHandsBranches` 没有 landedHead 可查，会 fail-open 永久保留。宁可留垃圾分支，不冒误删风险。

## 验证

- 新测试 `src/server/__tests__/session-archive-worktree.test.ts`（10 用例）：归档三态（脏 checkpoint 保留 / 干净删除 / 已提交未合并保留）、会话级 diff（中途 commit 仍可见）、landing 三方法（成功 / 主工作区脏拒绝 / 冲突回滚 / 非 worktree 拒绝）、**路由级端到端链路**（建 worktree 会话 → 改 → 会话 diff → commit → merge-back → 归档清理分支）。
- `worktree.test.ts` / `git.test.ts` 扩展：`hasUnlandedWork` 三态、keepBranch、commitAll、baseRef（含注入回退）、cleanup 保留未合并分支。
- 双端 typecheck 干净；`src/server` 全目录 378 测试 376 过——仅剩 2 个失败在干净 HEAD 的临时 worktree 复跑确认为**既有失败**（session-persistence 损坏行处理），与本次无关。

## 遗留

- `landing` SSE 事件桌面 reducer 走 default 分支静默忽略（动作条已内联展示结果；时间线卡片是加分项未做）。
- `createSessionPr` 无路由级真实测试（依赖 `gh` 登录态）；拒绝路径与 push 失败路径有单测。
- 真实 UI 手工点按验证未做（API 层链路已端到端覆盖）。
- `unarchiveSession` 恢复会话后 worktree 目录已删（分支还在）——恢复后是无 worktree 的普通会话，重建 worktree 需另起会话。既有行为，未纳入本次范围。
