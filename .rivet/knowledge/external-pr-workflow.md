# 外部 PR 处理流程

> 来源：PR #1（HarriethWiKk → huiliyi37/Tianshu-Tui，"Wsl兼容问题"）的实战处理经验。
> 适用于所有从公开仓库 `huiliyi37/Tianshu-Tui` 收到的外部贡献 PR。

## 背景：仓库双 remote 结构

| 仓库 | 路径 | 角色 |
|------|------|------|
| 开发仓库 | `/Users/banxia/app/deepseek-tui/opencode-tui` | origin = revit.git（私有镜像），所有改动先在这里验证 |
| 公开仓库（本地 clone） | `/Users/banxia/app/Tianshu` | remote = Tianshu-Tui.git（公开），接收 sync 脚本的 rsync 输出 |
| 公开仓库（GitHub） | `huiliyi37/Tianshu-Tui` | 外部贡献者 fork + PR 的目标 |

**关键约束**：绝不直接 `git push tianshu`——公开仓库历史与开发仓库不同步。同步只能通过 `scripts/sync-to-public.sh`。

## 处理流程（6 步）

### 1. 拉取 PR 到本地审查

```bash
# 在公开仓库本地 clone 中拉取 PR 分支
cd /Users/banxia/app/Tianshu
git fetch origin pull/<N>/head:pr-<N>
```

### 2. 审查 PR 内容

用 GitHub API 快速获取概览：
```bash
# PR 详情
curl -s "https://api.github.com/repos/huiliyi37/Tianshu-Tui/pulls/<N>" | python3 -m json.tool

# 改动文件
curl -s "https://api.github.com/repos/huiliyi37/Tianshu-Tui/pulls/<N>/files" | python3 -m json.tool

# commits
curl -s "https://api.github.com/repos/huiliyi37/Tianshu-Tui/pulls/<N>/commits" | python3 -m json.tool
```

审查要点：
- **分类**：PR 混合了哪些类型的改动？（bug fix / 功能 / 视觉重写 / 重构）——不同类型应拆分处理
- **commit 历史**：是否有 revert、merge commit、无关改动？
- **是否有描述**：无描述的 PR 需要更仔细审查代码本身

### 3. 检查与当前 main 的冲突

```bash
cd /Users/banxia/app/Tianshu

# PR base 和 main 差多少
git merge-base main pr-<N>
git log --oneline <base>..main | wc -l

# 交集文件（可能冲突）
git diff --name-only main...pr-<N> | sort > /tmp/prf.txt
git diff --name-only <base>..main | sort > /tmp/mainf.txt
comm -12 /tmp/prf.txt /tmp/mainf.txt

# 试合并看实际冲突
git merge --no-commit --no-ff pr-<N>
# 看冲突文件
git diff --name-only --diff-filter=U
# 中止
git merge --abort
```

### 4. 采纳有价值的改动到开发仓库

**不直接 merge PR**。手动将有价值的改动移植到开发仓库 `/Users/banxia/app/deepseek-tui/opencode-tui`：

- 读取 PR diff，理解每处改动的意图
- 在开发仓库的**当前代码**上手动应用（不是 cherry-pick——代码可能已大幅变化）
- 跳过已解决的问题（如 `/exit` 已用更好的方式实现）
- typecheck + 相关测试验证
- `deliver_task commit` 提交到开发仓库

提交信息格式：
```
fix(scope): 简述 — 来源 PR #N（贡献者名）

Adapted from PR #N (<contributor>) to current codebase:
- 文件1: 改动说明
- 文件2: 改动说明
Note: <说明哪些没采纳及原因>

Verified: tsc --noEmit pass, N/N tests pass.
```

### 5. 在 GitHub 上回复并关闭 PR

用 `gh` CLI（已登录 `huiliyi37`）：

```bash
# 评论：说明采纳了什么、没采纳什么、后续计划
gh pr comment <N> --repo huiliyi37/Tianshu-Tui --body '<评论内容>'

# 关闭 PR（带关闭评论）
gh pr close <N> --repo huiliyi37/Tianshu-Tui --comment '<关闭评论>'
```

评论模板：
```
感谢提交这个 PR！

我审查了全部 N 个 commit。PR 包含了 [类型1] 和 [类型2] 两类改动。
由于仓库在 [日期] 之后有 N 个 sync commit 更新了 [文件列表]，直接 merge 会有 N 个文件冲突。

**[有价值的改动] 已采纳到开发主线**，适配后的改动在 commit <hash>：
- 文件1: 改动说明
- 文件2: 改动说明
- [说明哪些没采纳及原因]

以上改动会通过 sync 脚本在下一次推送到公开仓库的 main 分支。

[如果 PR 混合了视觉/功能改动] 如果后续还想推进 [未采纳部分]，建议拆成单独的 PR，基于最新 main 重新适配。

再次感谢贡献 🎉 欢迎后续继续提交。
```

### 6. 后续 sync

采纳的改动在下次执行 `bash scripts/sync-to-public.sh` 时自动推送到公开仓库 main。贡献者 `git pull` 即可看到。

## 决策原则

| 情况 | 处理方式 |
|------|---------|
| PR 只有 bug fix，不冲突 | 可以直接 merge（但仍建议移植到开发仓库保持单源） |
| PR 混合多类改动 | 只移植有价值的部分到开发仓库，close PR 并说明 |
| PR 和 main 大量冲突 | 不 merge，移植需要的改动，close PR 并说明 |
| PR 有安全风险 | 拒绝，close 并说明原因 |
| PR 质量低（无测试、无描述、commit 混乱）| 要求拆分和补充后再提交，或直接 close |

**核心原则**：开发仓库是唯一源头。所有改动先进开发仓库验证，再通过 sync 脚本推到公开仓库。公开仓库的 PR 只作为贡献来源——有价值的手动移植，不直接合并。
