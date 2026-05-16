# Rivet Core Capability Ledger

> Last updated: 2026-05-16. Based on actual plan checkbox status + test/typecheck/build verification. Updated after repair pipeline verification (642 tests, typecheck clean).

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
| Tool Safety + Verification Evidence | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-tool-safety-verification-evidence.md` | `src/agent/approval-risk.ts`, `src/agent/evidence.ts`, `src/agent/delivery-gate.ts` | Plan 29/30 (preamble only unchecked), 620 tests pass, evidence gate bypass fixed | None critical | — |
| Execution Resilience + Sub-agent Evidence | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-execution-resilience-subagent-evidence.md` | `src/agent/turn-harness.ts`, `src/agent/failure-classifier.ts`, `src/agent/aggregation.ts`, `src/agent/strategy-shift.ts` | Plan 34/35 (preamble only unchecked), 620 tests pass, strategy shift added | None critical | — |
| Execution Resilience Layer | **Verified** | `specs/...-execution-resilience-layer-design.md` | `plans/...-execution-resilience-layer-implementation.md` | `src/agent/turn-harness.ts`, `src/agent/trace-store.ts` | Plan 37/37 checked, 612 tests pass | None | — |
| Cockpit Observability | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-cockpit-capability-ledger.md` | `src/tui/cockpit/*`, `src/tui/cockpit/state.ts`, `src/tui/cockpit/mcp-panel.tsx` | Unified CockpitSnapshot aggregator, panel status indicators, MCP panel, 620 tests pass | None | — |
| Cockpit Techstyle | **MVP** | `specs/...-glanceable-cockpit-techstyle-design.md` | `plans/...-glanceable-cockpit-techstyle-implementation.md` | `src/tui/cockpit/*`, `src/tui/summary-bar.tsx` | Plan 42/43 (preamble only unchecked) | — | — |
| MCP Integration | **Verified** | `specs/...-p2-model-mcp-repo-intel-design.md` | `plans/...-mcp-client-implementation.md` | `src/mcp/*`, `src/mcp/failure-classifier.ts`, `src/tui/cockpit/mcp-panel.tsx` | Failure classifier (5 error classes), cockpit MCP panel, error annotations on tool results, 620 tests pass | Not yet in unified ToolSafetyPolicy | MCP safety integration |
| Model Routing | **Verified** | `specs/...-p2-model-mcp-repo-intel-design.md` | — | `src/model/capability.ts`, `src/model/task-inferrer.ts`, `src/model/routing-metrics.ts`, `src/agent/loop.ts` | TaskInferrer + per-turn routing integrated into AgentLoop, routing reason in volatile context, 620 tests pass | Verification feedback not yet wired back to metrics | — |
| Repo Intelligence | **Verified** | `specs/...-p2-model-mcp-repo-intel-design.md` | — | `src/agent/import-graph.ts`, `src/agent/impact-hint.ts`, `src/agent/loop.ts` | Lightweight import graph + impact hint injected after edits, impacted files/tests in evidence badge, 620 tests pass | Graph rebuild is synchronous | Background build optimization |
| Progressive Context Engine | **Verified** | `specs/...-progressive-context-engine-design.md` | `plans/...-progressive-context-engine-implementation.md` | `src/context/*` | Plan 87/88 (preamble only unchecked), 612 tests pass | None | — |
| Sub-agent Orchestration | **Verified** | `specs/...-subagent-orchestration-design.md` | `plans/...-subagent-orchestration-implementation.md` | `src/agent/coordinator.ts`, `src/agent/work-order.ts` | Plan 40/41 (preamble only unchecked), 612 tests pass | None | — |
| Attention Anchor Dispersal | **Verified** | `specs/...-attention-anchor-dispersal-design.md` | `plans/...-attention-anchor-dispersal-implementation.md` | `src/prompt/volatile.ts` | Plan 27/27 checked, 612 tests pass | None | — |
| XML Protocol + Speculative Engine | **Verified** | `specs/...-xml-protocol-speculative-engine-design.md` | `plans/...-xml-protocol-speculative-engine-implementation.md` | `src/prompt/volatile.ts`, `src/agent/prewarm.ts` | Plan 34/35 (preamble only unchecked), 612 tests pass | None | — |
| Multi-pass Repair Pipeline | **Verified** | `specs/...-multi-pass-repair-pipeline-design.md` | `plans/...-multi-pass-repair-pipeline.md` | `src/agent/repair-pipeline.ts`, `src/agent/repair-passes.ts`, `src/agent/repair-hint.ts`, `src/api/client.ts` | Plan 36/36 (all 6 tasks complete: pipeline skeleton, four horsemen, semantic repair, schema gate, adaptive injection, integration test), 642 tests pass | None | — |
| CTCL Migration (Tool Input Repair) | **Designed** | None | `plans/...-tool-input-repair-cch-strip-schema-gate.md` | None | Plan 0/41 checked, code in ebook-v1.0 repo | Port from external repo | Execute migration plan |
| Gap Closing (hooks/git/todo/webfetch/undo) | **Planned** | — | `plans/...-gap-closing-hooks-git-todo-webfetch-undo.md` | Existing tools | Plan 0/38 checked | Not evaluated | Execute plan |
| P1 Remaining Gaps | **Planned** | — | `plans/...-p1-remaining-gaps.md` | — | Plan 0/28 checked | Not evaluated | Execute plan |
| Performance Optimization | **Planned** | — | `plans/...-performance-optimization.md` | — | Plan 0/72 checked | Not evaluated | Execute plan |
| Capability Reliability Layer | **Planned** | — | `plans/...-p2-2-capability-reliability-layer.md` | — | Plan 0/100 checked | Not evaluated | Execute plan |
| Harness Cockpit | **Planned** | `specs/...-p2-3-harness-cockpit-design.md` | `plans/...-p2-3-harness-cockpit-implementation.md` | — | Plan 0/69 checked | Not evaluated | Execute plan |
| Open Source Harness Strategy | **Designed** | `specs/...-open-source-harness-strategy-design.md` | None | None | Brainstorm complete | No plan yet | Review design, write implementation plan |

## Summary

- **Verified**: 12 capabilities (Context Layer, Tool Safety, Execution Resilience x2, Cockpit Observability, MCP Integration, Model Routing, Repo Intelligence, Progressive Context Engine, Sub-agent Orchestration, Attention Anchors, XML Protocol, Multi-pass Repair Pipeline)
- **MVP**: 1 capability (Cockpit Techstyle)
- **Planned**: 5 capabilities with unexecuted plans
- **Designed**: 2 capabilities (CTCL Migration, Open Source Strategy)

## Maintenance Rules

- New design/spec: status cannot exceed **Designed**.
- New implementation plan: status upgrades to **Planned**.
- Code merged without full verification: status is **MVP** at most.
- `npm run typecheck`, `npm test`, `npm run build`, and target behavior tests all pass: status can be **Verified**.
- Review finds deviation: status must be **Gap** or noted in "Known Gaps" column.
