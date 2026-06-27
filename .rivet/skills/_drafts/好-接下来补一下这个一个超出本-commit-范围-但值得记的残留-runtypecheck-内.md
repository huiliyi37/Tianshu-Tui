---
name: 好-接下来补一下这个一个超出本-commit-范围-但值得记的残留-runtypecheck-内
description: 好 接下来补一下这个一个超出本 commit 范围、但值得记的残留：runTypeCheck 内部用 (require as any)('typescript')（client.ts:30），这是 480ecd39 引入、现在被门禁和 baseline 脚本共用的真实路径。若它在某运行环境（bundled dist / 某些 tsx 版本）解析失败，runTypeCheck 会 fail-o...
triggers: ['client.test', 'client', 'exclude', '接下来补一下这个一个超出本']
---

# 好-接下来补一下这个一个超出本-commit-范围-但值得记的残留-runtypecheck-内

> 自动从会话 a45bad29 蒸馏的草稿。审核后用 `/skill approve 好-接下来补一下这个一个超出本-commit-范围-但值得记的残留-runtypecheck-内` 入库，或 `/skill reject 好-接下来补一下这个一个超出本-commit-范围-但值得记的残留-runtypecheck-内` 丢弃。

## Steps
1. 阅读 / 搜索：.、glob、cd /Users/banxia/app/deepseek-tui/opencode-tui &&
2. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/lsp/__tests__/client.test.ts
3. 阅读 / 搜索：cd /Users/banxia/app/deepseek-tui/opencode-tui &&
4. 操作：src/lsp/client.ts
5. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/lsp/client.ts、/Users/banxia/app/deepseek-tui/opencode-tui/src/lsp/__tests__/client.test.ts
6. 验证：run_tests
7. 操作：src/lsp/client.ts
8. 阅读 / 搜索：cd /Users/banxia/app/deepseek-tui/opencode-tui &&、cat .git/info/exclude 2>&1
9. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/.git/info/exclude
10. 验证：deliver_task

## Verified by
- tsx --test src/lsp/__tests__/client.test.ts (passed 2)
- tsx --test src/agent/__tests__/typecheck-gate.test.ts (passed 22)

<!-- skill-draft-key: f0851ee55ef8 -->
<!-- source-session: a45bad29 -->
