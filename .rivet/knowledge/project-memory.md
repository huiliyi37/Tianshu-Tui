## 2026-05-20 — 天枢伙伴对话迭代 总结

### 当前架构状态

**星域人格系统 (Star Soul)**:
- 3 domains: 破军 (bold), 天府 (cautious), 天梁 (methodical)
- Domain matching via keyword detection → ActiveStarDomain { id, name, volatileBlock, motto }
- A/B gate: STAR_SOUL env var, AB test proved personality improves objection rate
- Domain voice: harness-layer tone conversion, 14 phrases per domain

**缓存系统 (Ice Mirror)**:
- v3 confidence accumulator: IRF4-inspired, α modulated by phaseHint (explore:0.10, plan:0.20, execute:0.35, verify:0.30, deliver:0.40)
- Three-zone layout: frozen / consolidated / active
- Hard separation: audit+self-perception fields removed from LLM context (~1,700t saved)
- FieldHabituationTracker: confidence-based promotion (threshold 0.8), decay on absent (0.3)

**天枢无线电 (Tianshu Radio)**:
- 13 phase transition/milestone templates
- 5 phase-aware heartbeat templates (explore/plan/execute/verify/deliver)
- Heartbeat interval: 6 turns
- Domain voice pipeline: applyDomainVoice() on all messages
- Stuck detection: 8+ consecutive same-phase turns, separate cooldown
- Wired to Chronicle for structured event capture

**星桥四站 (Starbridge)**:
- Station 1: Main (conversation)
- Station 2: Starmap (constellation + sensorium gauges)
- Station 3: Chronicle (phase-by-phase execution timeline)
- Constellation: Unicode star chart for 紫微七星
- Mode switching: 1=main, 2=starmap, 3=chronicle, Esc=back

**上下文系统 (Context)**:
- ACF: Adaptive Context Fabric — all phases complete
- Compact policy: ratio-based tier 0-4 + circuit breaker
- Pressure monitor: PSI-style pressure/thrashing detection
- Anchor registry: user constraints + decisions with budget
- Cold storage: PersistentStore with SHA-256 archive + disk cap
- Starspine task contract ledger
- Cognitive ledger with dead-end rules

**Avatar 系统 (开发中)**:
- New directory: src/tui/avatar/ (avatar-renderer, expressions, frames, types)
- Star panel colors: src/tui/star-panel-colors.ts
- Theme updates in progress
- Design spec: docs/superpowers/specs/2026-05-20-avatar-styles-design.md

**测试状态**: 2025 tests, 0 failures (npx tsx --test src/**/__tests__/*.test.ts)
**类型检查**: 0 errors (npx tsc --noEmit)

---

### 2026-05-19 — session ea5cf850

**Modified** (3): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/create-runtime-hooks.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/star-domain.ts
**Read** (2): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/star-domain.ts
**Tests**: ⚠️ unverified
**Tools used**: edit_file×7, bash×4, read_file×3, grep×1, git×1, todo×1
- Decision: the `name` field is '破军', '天府', or '天梁'

### 2026-05-19 — session dc47b5e7

**Modified** (4): /Users/banxia/app/deepseek-tui/opencode-tui/src/tools/output-store.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/playbook.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/volatile.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/dead-end-rules.ts
**Read** (5): /Users/banxia/app/deepseek-tui/opencode-tui/src/tools/output-store.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/retrospect.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/playbook.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/volatile.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/dead-end-rules.ts
**Tests**: ⚠️ unverified
**Tools used**: edit_file×7, read_file×6, bash×6, todo×3, git×1, grep×1

### 2026-05-19 — session edfd1210

**Modified** (6): /Users/banxia/app/deepseek-tui/opencode-tui/src/context/task-contract.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/cognitive-ledger.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/__tests__/task-contract.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/__tests__/cognitive-ledger.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/engine.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/__tests__/engine-cache-stability.test.ts
**Read** (5): /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/__tests__/engine-cache-stability.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/__tests__/engine.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/loop.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/task-contract.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/prompt/engine.ts
**Tests**: ❌ 0 passed, 0 failed (npx tsx --test src/context/__tests__/task-contract.test.ts src/context/__tests__/cognitive-ledger.test.ts)
**Tools used**: bash×7, edit_file×7, read_file×6, write_file×4, todo×3, git×2, glob×2, diff×2, delegate_batch×1, run_tests×1

### 2026-05-19 — session e69ea146

**Modified** (4): /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/analysis/2026-05-19-workflow-iteration-plan-design-alignment.md, /Users/banxia/app/deepseek-tui/opencode-tui/.rivet/knowledge/agent.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/plans/2026-05-19-multi-session-phase1.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/ab-harness/results-template.md
**Read** (6): /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/plans/2026-05-19-multi-session-phase1.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/specs/2026-05-19-multi-session-orchestration-design.md, /Users/banxia/app/deepseek-tui/opencode-tui/.rivet/knowledge/agent.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/analysis/2026-05-19-workflow-iteration-plan-design-alignment.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/ab-harness/tasks.json, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/ab-harness/results-template.md
**Tests**: ⚠️ unverified
**Tools used**: read_file×11, edit_file×7, git×5, write_file×1, todo×1, ask_user_question×1, bash×1
- Decision: help them run them

Let me build first

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
