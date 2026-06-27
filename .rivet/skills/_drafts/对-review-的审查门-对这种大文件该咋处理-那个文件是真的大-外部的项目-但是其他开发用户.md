---
name: 对-review-的审查门-对这种大文件该咋处理-那个文件是真的大-外部的项目-但是其他开发用户
description: 对 review 的审查门 对这种大文件该咋处理 。那个文件是真的大，外部的项目。但是其他开发用户也可能存在 。是不是应该做个自适应的。或者搜索一下外部竞品的实现 — verified by 3 checks
triggers: ['review-discipline', 'review-coordinator-deps', 'deliver-task', 'review']
---

# 对-review-的审查门-对这种大文件该咋处理-那个文件是真的大-外部的项目-但是其他开发用户

> 自动从会话 6bddf354 蒸馏的草稿。审核后用 `/skill approve 对-review-的审查门-对这种大文件该咋处理-那个文件是真的大-外部的项目-但是其他开发用户` 入库，或 `/skill reject 对-review-的审查门-对这种大文件该咋处理-那个文件是真的大-外部的项目-但是其他开发用户` 丢弃。

## Steps
1. 阅读 / 搜索：grep -rn 'review' src/agent/review-coordinator-dep、src/agent/review-router.ts、src/agent/review-coordinator-deps.ts
2. 修改：src/agent/review-discipline.ts
3. 阅读 / 搜索：src/agent/review-coordinator-deps.ts
4. 修改：src/agent/review-coordinator-deps.ts
5. 阅读 / 搜索：src/agent/review-coordinator-deps.ts
6. 修改：src/agent/review-coordinator-deps.ts
7. 阅读 / 搜索：grep -n 'ChangeSet = {' src/agent/deliver-task.ts、grep -n 'change.*ChangeSet\|ChangeSet' src/agent/d、src/agent/deliver-task.ts
8. 操作：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/deliver-task.ts
9. 修改：src/agent/deliver-task.ts
10. 阅读 / 搜索：grep -n "from 'node:fs'" src/agent/deliver-task.ts、src/agent/deliver-task.ts
11. 修改：src/agent/deliver-task.ts
12. 阅读 / 搜索：src/agent/deliver-task.ts
13. 修改：src/agent/deliver-task.ts
14. 阅读 / 搜索：cd /Users/banxia/app/deepseek-tui/opencode-tui &&
15. 验证：run_tests、deliver_task

## Verified by
- tsx --test src/agent/__tests__/review-coordinator-deps.test.ts (passed 6)
- tsx --test src/agent/__tests__/change-classification.test.ts (passed 26)
- tsx --test src/agent/__tests__/deliver-task.test.ts (passed 84)

<!-- skill-draft-key: 1680cd4180a6 -->
<!-- source-session: 6bddf354 -->
