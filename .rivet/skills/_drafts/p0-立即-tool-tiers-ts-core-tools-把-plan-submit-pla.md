---
name: p0-立即-tool-tiers-ts-core-tools-把-plan-submit-pla
description: P0 立即:tool-tiers.ts CORE_TOOLS 把 plan_submit/plan_close→plan,并把 request_path_access、skill 从 EXTENDED 挪回 CORE。 — verified by 1 check
triggers: ['tool-tiers', 'tool-tiers.test', 'CORE_TOOLS', 'plan_submit']
---

# p0-立即-tool-tiers-ts-core-tools-把-plan-submit-pla

> 自动从会话 b30728b2 蒸馏的草稿。审核后用 `/skill approve p0-立即-tool-tiers-ts-core-tools-把-plan-submit-pla` 入库，或 `/skill reject p0-立即-tool-tiers-ts-core-tools-把-plan-submit-pla` 丢弃。

## Steps
1. 阅读 / 搜索：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/tool-tiers.ts
2. 操作：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/tool-tiers.ts
3. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/tool-tiers.ts
4. 阅读 / 搜索：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/tool-tiers.test.ts、/Users/banxia/app/deepseek-tui/opencode-tui/src/tools/default-registry.ts
5. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/tool-tiers.test.ts
6. 验证：npx tsc --noEmit 2>&1 | head -10
7. 修改：/Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/tool-tiers.test.ts
8. 验证：run_tests、deliver_task

## Verified by
- tsx --test src/agent/__tests__/tool-tiers.test.ts (passed 17)

<!-- skill-draft-key: 56e5d8313d03 -->
<!-- source-session: b30728b2 -->
