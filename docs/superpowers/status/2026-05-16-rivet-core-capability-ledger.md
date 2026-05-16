# Rivet Core Capability Ledger

> Last updated: 2026-05-16. Based on actual plan checkbox status + test/typecheck/build verification.

## Status Definitions

| Status | Meaning |
|--------|---------|
| Designed | Spec exists, no executable plan |
| Planned | Implementation plan exists, not executed |
| MVP | Code exists, covers core path, plan not fully executed |
| Verified | Plan executed, tests pass, typecheck clean, build succeeds |
| Gap | Known deviation between implementation and design |

## Capability Ledger

| Capability | Status | Design | Plan | Primary Code | Validation | Known Gaps | Next Action |
|-----------|--------|--------|------|-------------|-----------|-----------|-------------|
| Context Layer + Cache Architecture | **Verified** | `specs/...-context-layer-cache-architecture-gap.md` | `plans/...-context-layer-boundary-implementation.md` | `src/prompt/*` | Plan 34/34 checked, 612 tests pass | Logical layers use physical channel mapping | Monitor for new cache behaviors |
| Cache Safety | **Planned** | `specs/...-cache-safety-design.md` | `plans/...-cache-safety-implementation.md` | `src/agent/prewarm.ts`, `src/agent/loop.ts` | Plan 0/30 checked | prewarm bypasses read_file safety boundary | Execute cache safety plan |
| Tool Safety + Verification Evidence | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-tool-safety-verification-evidence.md` | `src/agent/approval-risk.ts`, `src/agent/evidence.ts` | Plan 29/30 (preamble only unchecked), 612 tests pass | None critical | — |
| Execution Resilience + Sub-agent Evidence | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-execution-resilience-subagent-evidence.md` | `src/agent/turn-harness.ts`, `src/agent/failure-classifier.ts`, `src/agent/aggregation.ts` | Plan 34/35 (preamble only unchecked), 612 tests pass | None critical | — |
| Execution Resilience Layer | **Verified** | `specs/...-execution-resilience-layer-design.md` | `plans/...-execution-resilience-layer-implementation.md` | `src/agent/turn-harness.ts`, `src/agent/trace-store.ts` | Plan 37/37 checked, 612 tests pass | None | — |
| Cockpit Observability | **MVP** | `specs/...-core-business-gap-review.md` | `plans/...-cockpit-capability-ledger.md` | `src/tui/cockpit/*`, `src/tui/app.tsx` | Unified snapshot implemented, 4 tests pass | Capability ledger + README update (this doc) | Close remaining tasks (in progress) |
| Cockpit Techstyle | **MVP** | `specs/...-glanceable-cockpit-techstyle-design.md` | `plans/...-glanceable-cockpit-techstyle-implementation.md` | `src/tui/cockpit/*`, `src/tui/summary-bar.tsx` | Plan 42/43 (preamble only unchecked) | — | — |
| MCP Integration | **MVP** | `CLAUDE.md`, README | `plans/...-mcp-client-implementation.md` | `src/mcp/*` | Plan 33/34 (preamble only unchecked), unit tests pass | Not wired into unified safety/trace/evidence | MCP hardening plan |
| Model Routing | **MVP** | `specs/...-core-business-gap-review.md` | None | `src/model/capability.ts` | `capability.test.ts` passes | Not wired into AgentLoop/coordinator policy | Write model routing plan |
| Repo Intelligence | **MVP** | P2.2 records / README | None | `src/repo/*` | symbol-index unit tests | Not wired into default impact/test selection | Write repo intelligence plan |
| Progressive Context Engine | **Verified** | `specs/...-progressive-context-engine-design.md` | `plans/...-progressive-context-engine-implementation.md` | `src/context/*` | Plan 87/88 (preamble only unchecked), 612 tests pass | None | — |
| Sub-agent Orchestration | **Verified** | `specs/...-subagent-orchestration-design.md` | `plans/...-subagent-orchestration-implementation.md` | `src/agent/coordinator.ts`, `src/agent/work-order.ts` | Plan 40/41 (preamble only unchecked), 612 tests pass | None | — |
| Attention Anchor Dispersal | **Verified** | `specs/...-attention-anchor-dispersal-design.md` | `plans/...-attention-anchor-dispersal-implementation.md` | `src/prompt/volatile.ts` | Plan 27/27 checked, 612 tests pass | None | — |
| XML Protocol + Speculative Engine | **Verified** | `specs/...-xml-protocol-speculative-engine-design.md` | `plans/...-xml-protocol-speculative-engine-implementation.md` | `src/prompt/volatile.ts`, `src/agent/prewarm.ts` | Plan 34/35 (preamble only unchecked), 612 tests pass | None | — |
| Multi-pass Repair Pipeline | **Planned** | `specs/...-multi-pass-repair-pipeline-design.md` | `plans/...-multi-pass-repair-pipeline.md` | None | Plan 0/36 checked | No implementation | Execute plan |
| CTCL Migration (Tool Input Repair) | **Designed** | None | `plans/...-tool-input-repair-cch-strip-schema-gate.md` | None | Plan 0/41 checked, code in ebook-v1.0 repo | Port from external repo | Execute migration plan |
| Gap Closing (hooks/git/todo/webfetch/undo) | **Planned** | — | `plans/...-gap-closing-hooks-git-todo-webfetch-undo.md` | Existing tools | Plan 0/38 checked | Not evaluated | Execute plan |
| P1 Remaining Gaps | **Planned** | — | `plans/...-p1-remaining-gaps.md` | — | Plan 0/28 checked | Not evaluated | Execute plan |
| Performance Optimization | **Planned** | — | `plans/...-performance-optimization.md` | — | Plan 0/72 checked | Not evaluated | Execute plan |
| Capability Reliability Layer | **Planned** | — | `plans/...-p2-2-capability-reliability-layer.md` | — | Plan 0/100 checked | Not evaluated | Execute plan |
| Harness Cockpit | **Planned** | `specs/...-p2-3-harness-cockpit-design.md` | `plans/...-p2-3-harness-cockpit-implementation.md` | — | Plan 0/69 checked | Not evaluated | Execute plan |
| Open Source Harness Strategy | **Designed** | `specs/...-open-source-harness-strategy-design.md` | None | None | Brainstorm complete | No plan yet | Review design, write implementation plan |

## Summary

- **Verified**: 7 capabilities (Context Layer, Tool Safety, Execution Resilience x2, Progressive Context Engine, Sub-agent Orchestration, Attention Anchors, XML Protocol)
- **MVP**: 5 capabilities (Cockpit x2, MCP, Model Routing, Repo Intelligence)
- **Planned**: 6 capabilities with unexecuted plans
- **Designed**: 2 capabilities (CTCL Migration, Open Source Strategy)

## Maintenance Rules

- New design/spec: status cannot exceed **Designed**.
- New implementation plan: status upgrades to **Planned**.
- Code merged without full verification: status is **MVP** at most.
- `npm run typecheck`, `npm test`, `npm run build`, and target behavior tests all pass: status can be **Verified**.
- Review finds deviation: status must be **Gap** or noted in "Known Gaps" column.
