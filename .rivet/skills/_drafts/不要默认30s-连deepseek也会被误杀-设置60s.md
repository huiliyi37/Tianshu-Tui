---
name: 不要默认30s-连deepseek也会被误杀-设置60s
description: 不要默认30s 连deepseek也会被误杀 设置60s — verified by 2 checks
triggers: ['openai-client', 'stream-hard-cap.test', '不要默认30s', '连deepseek也会被误杀']
---

# 不要默认30s-连deepseek也会被误杀-设置60s

> 自动从会话 a0796052 蒸馏的草稿。审核后用 `/skill approve 不要默认30s-连deepseek也会被误杀-设置60s` 入库，或 `/skill reject 不要默认30s-连deepseek也会被误杀-设置60s` 丢弃。

## Steps
1. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/api/openai-client.ts、/Users/banxia/app/deepseek-tui/opencode-tui/src/api/__tests__/stream-hard-cap.test.ts
2. 阅读 / 搜索：cd /Users/banxia/app/deepseek-tui/opencode-tui &&
3. 验证：run_tests、deliver_task

## Verified by
- tsx --test src/api/__tests__/stream-hard-cap.test.ts (passed 8)
- tsx --test src/api/__tests__/openai-client.test.ts (passed 31)

<!-- skill-draft-key: ec4dbebafa06 -->
<!-- source-session: a0796052 -->
