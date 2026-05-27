# Scoped Delivery Commit 契约

> **Status**: implemented / verified

## 目标

`deliver_task(commit=true)` 是共享工作区中的语义交付入口。它在 Delivery Gate 非 RED、commit message 存在且 approval 通过后，只提交 owned files。

## 边界

- `deliver_task` 负责 ownership-aware commit；
- `git` tool 保留 staged fallback 和底层 git 操作能力；
- 不允许 `git add -A` 作为默认交付路径；
- external dirty files 必须保留在工作区，不进入 scoped commit。

## 失败行为

| 场景 | 行为 |
|---|---|
| Delivery Gate RED | 拒绝 commit，返回 tool error |
| 缺少 message | 拒绝 commit，返回 tool error |
| owned files 为空 | scoped commit helper 返回失败 |
| git commit 失败 | 报告 git 输出，不自动改用全量提交 |

## 实现说明

`src/agent/scoped-git-commit.ts` 使用 project-relative pathspec 执行：

```text
git add -- <owned files>
git commit -m <message> --only -- <owned files>
```

`--only` 防止已有 staged external changes 被带入交付提交；`git add -- <owned files>` 只补充 owned files，包括 owned untracked files。
