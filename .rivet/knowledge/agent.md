## Workflow Rules (2026-05-19 迭代)

- **计划-设计对齐**：执行计划文档前，必须回查设计文档的成功标准。集成验证不只做 typecheck + tests，还要逐条验证设计要求是否被满足。
- **"继续"不是惯性**：每轮开始前问"还有什么没做完"，而不是"下一个任务是什么"。

---

### 2026-05-19 — session e69ea146

**Modified** (4): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/session-registry.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/session-registry.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/main.tsx, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/coordinator.ts
**Read** (6): /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/specs/2026-05-19-multi-session-orchestration-design.md, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/lwt-guard.ts, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/plans/2026-05-19-multi-session-phase1.md, /Users/banxia/app/deepseek-tui/opencode-tui/src/main.tsx, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/coordinator.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/hands-session.ts
**Tests**: ✅ 21 passed, 0 failed (npx tsx --test src/agent/__tests__/session-registry.test.ts)
**Tools used**: read_file×15, bash×10, todo×6, edit_file×4, grep×3, git×3, write_file×2, delegate_batch×1, run_tests×1, ask_user_question×1

### 2026-05-19 — session e69ea146

**Modified** (7): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/star-soul-gate.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/create-runtime-hooks.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/static.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/star-soul-gate.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/ab-harness/tasks.json, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/ab-harness/results-template.md
**Read** (8): /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/plans/2026-05-19-star-soul-ab-validation.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/plans/2026-05-19-star-domain-soul-phase1.md, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/create-runtime-hooks.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/static.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/volatile.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/hooks/courage-hook.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/ab-harness/tasks.json
**Tests**: ✅ 4 passed, 0 failed (npx tsx --test src/agent/__tests__/create-runtime-hooks.test.ts)
**Tools used**: read_file×17, bash×9, edit_file×7, grep×5, write_file×4, git×3, delegate_batch×2, ask_user_question×2, todo×2, run_tests×2

### 2026-05-19 — session a867cb0a

**Modified** (6): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/star-domain.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/star-domain.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/engine.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/__tests__/engine.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/loop.test.ts
**Read** (6): /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/engine.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/star-domain.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/star-domain.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/__tests__/engine.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/loop.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts
**Tests**: ⚠️ unverified
**Tools used**: edit_file×15, bash×11, read_file×10, todo×5, grep×5, git×3, diff×3
- Decision: make sure to include a test using an engine variable to capture the request

### 2026-05-18 — session 87b03c0c

**Modified** (3): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/turn-stream.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/turn-stream.test.ts
**Read** (4): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/api/stream-client.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/api/client.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/api/types.ts
**Tests**: ⚠️ unverified
**Tools used**: read_file×12, edit_file×11, bash×6, todo×4, git×4, grep×2, write_file×2, diff×2

### 2026-05-18 — session 87b03c0c

**Modified** (3): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/compaction-controller.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/compaction-controller.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts
**Read** (2): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/compaction-controller.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/compaction-controller.ts
**Tests**: ⚠️ unverified
**Tools used**: bash×6, read_file×4, edit_file×4, git×3, grep×1, diff×1

### 2026-05-18 — session 3d73798d

**Modified** (4): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/auto-reasoning.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/create-agent-config.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/api/client.ts
**Read** (3): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/auto-reasoning.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/create-agent-config.ts
**Tests**: ⚠️ unverified
**Tools used**: edit_file×6, bash×6, read_file×5, ask_user_question×1, grep×1

