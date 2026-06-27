---
name: 他没做worker-你可以先修-但不是worker的问题
description: 他没做worker 。你可以先修。但不是worker的问题 — verified by 2 checks
triggers: ['factory', 'factory.test', '他没做worker', '你可以先修']
---

# 他没做worker-你可以先修-但不是worker的问题

> 自动从会话 a0796052 蒸馏的草稿。审核后用 `/skill approve 他没做worker-你可以先修-但不是worker的问题` 入库，或 `/skill reject 他没做worker-你可以先修-但不是worker的问题` 丢弃。

## Steps
1. 阅读 / 搜索：/Users/banxia/app/deepseek-tui/opencode-tui/src/api/openai-client.ts、src/api、src/api/factory.ts
2. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/api/factory.ts
3. 阅读 / 搜索：cd /Users/banxia/app/deepseek-tui/opencode-tui &&
4. 验证：run_tests
5. 阅读 / 搜索：/Users/banxia/app/deepseek-tui/opencode-tui/src/api/__tests__/factory.test.ts
6. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/api/__tests__/factory.test.ts
7. 验证：run_tests、deliver_task

## Verified by
- tsx --test src/api/__tests__/thinking-stall-config.test.ts (passed 3)
- tsx --test src/api/__tests__/factory.test.ts (passed 20)

<!-- skill-draft-key: 9938a2449fa2 -->
<!-- source-session: a0796052 -->
