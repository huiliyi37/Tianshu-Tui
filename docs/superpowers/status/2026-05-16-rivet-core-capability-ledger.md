# Rivet Core Capability Ledger

> Last updated: 2026-05-16. Based on actual code verification + test/typecheck/build validation. 697 tests passing.

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
| Cache Safety | **Verified** | `specs/...-cache-safety-design.md` | `plans/...-cache-safety-implementation.md` | `src/agent/prewarm.ts`, `src/agent/prewarm-file.ts`, `src/agent/loop.ts`, `src/tools/read-file.ts`, `src/prompt/volatile.ts`, `src/prompt/volatile-git.ts` | Plan 30/30 checked, 697 tests pass, Task 5 (fingerprint) pre-verified | None | — |
| Tool Safety + Verification Evidence | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-tool-safety-verification-evidence.md` | `src/agent/approval-risk.ts`, `src/agent/evidence.ts`, `src/agent/delivery-gate.ts` | Plan 29/30 (preamble only unchecked), 620 tests pass, evidence gate bypass fixed | None critical | — |
| Execution Resilience + Sub-agent Evidence | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-execution-resilience-subagent-evidence.md` | `src/agent/turn-harness.ts`, `src/agent/failure-classifier.ts`, `src/agent/aggregation.ts`, `src/agent/strategy-shift.ts` | Plan 34/35 (preamble only unchecked), 620 tests pass, strategy shift added | None critical | — |
| Execution Resilience Layer | **Verified** | `specs/...-execution-resilience-layer-design.md` | `plans/...-execution-resilience-layer-implementation.md` | `src/agent/turn-harness.ts`, `src/agent/trace-store.ts` | Plan 37/37 checked, 612 tests pass | None | — |
| Cockpit Observability | **Verified** | `specs/...-core-business-gap-review.md` | `plans/...-cockpit-capability-ledger.md` | `src/tui/cockpit/*`, `src/tui/cockpit/state.ts`, `src/tui/cockpit/mcp-panel.tsx` | Unified CockpitSnapshot aggregator, panel status indicators, MCP panel, 620 tests pass | None | — |
| Cockpit Techstyle | **Verified** | `specs/...-glanceable-cockpit-techstyle-design.md` | `plans/...-glanceable-cockpit-techstyle-implementation.md` | `src/tui/cockpit/*`, `src/tui/summary-bar.tsx`, `src/tui/phase-tracker.ts`, `src/tui/theme.ts` | SummaryBar (3-line live status), PhaseTracker state machine, tool-type border colors, context threshold coloring, braille sparkline, gradient banner, 694 tests pass | None | — |
| Pastel Theme + Render Perf + Memory Safety | **Verified** | `specs/...-pastel-aesthetic-performance-memory-design.md` | `plans/...-render-perf-memory-bounded-visual-polish.md` | `src/tui/theme.ts`, `src/tui/ring-buffer.ts`, `src/tui/summary-bar.tsx`, `src/tui/agent-status.tsx`, `src/agent/context.ts` | 7 tasks complete, 15 new tests, code review fixes, 684 tests pass | `pushStatic` O(n) items copy (capped at 500) | — |
| MCP Integration | **Verified** | `specs/...-p2-model-mcp-repo-intel-design.md` | `plans/...-mcp-client-implementation.md` | `src/mcp/*`, `src/mcp/failure-classifier.ts`, `src/tui/cockpit/mcp-panel.tsx` | Failure classifier (5 error classes), cockpit MCP panel, error annotations on tool results, 620 tests pass | Not yet in unified ToolSafetyPolicy | MCP safety integration |
| Model Routing | **Verified** | `specs/...-p2-model-mcp-repo-intel-design.md` | — | `src/model/capability.ts`, `src/model/task-inferrer.ts`, `src/model/routing-metrics.ts`, `src/agent/loop.ts` | TaskInferrer + per-turn routing integrated into AgentLoop, routing reason in volatile context, 620 tests pass | Verification feedback not yet wired back to metrics | — |
| Repo Intelligence | **Verified** | `specs/...-p2-model-mcp-repo-intel-design.md` | — | `src/agent/import-graph.ts`, `src/agent/impact-hint.ts`, `src/agent/loop.ts` | Lightweight import graph + impact hint injected after edits, impacted files/tests in evidence badge, 620 tests pass | Graph rebuild is synchronous | Background build optimization |
| Progressive Context Engine | **Verified** | `specs/...-progressive-context-engine-design.md` | `plans/...-progressive-context-engine-implementation.md` | `src/context/*` | Plan 87/88 (preamble only unchecked), 612 tests pass | None | — |
| Sub-agent Orchestration | **Verified** | `specs/...-subagent-orchestration-design.md` | `plans/...-subagent-orchestration-implementation.md` | `src/agent/coordinator.ts`, `src/agent/work-order.ts` | Plan 40/41 (preamble only unchecked), 612 tests pass | None | — |
| Attention Anchor Dispersal | **Verified** | `specs/...-attention-anchor-dispersal-design.md` | `plans/...-attention-anchor-dispersal-implementation.md` | `src/prompt/volatile.ts` | Plan 27/27 checked, 612 tests pass | None | — |
| XML Protocol + Speculative Engine | **Verified** | `specs/...-xml-protocol-speculative-engine-design.md` | `plans/...-xml-protocol-speculative-engine-implementation.md` | `src/prompt/volatile.ts`, `src/agent/prewarm.ts` | Plan 34/35 (preamble only unchecked), 612 tests pass | None | — |
| Multi-pass Repair Pipeline | **Verified** | `specs/...-multi-pass-repair-pipeline-design.md` | `plans/...-multi-pass-repair-pipeline.md` | `src/agent/repair-pipeline.ts`, `src/agent/repair-passes.ts`, `src/agent/repair-hint.ts`, `src/api/client.ts` | Plan 36/36 (all 6 tasks complete: pipeline skeleton, four horsemen, semantic repair, schema gate, adaptive injection, integration test), 642 tests pass | None | — |
| CTCL Migration (Tool Input Repair) | **Designed** | None | `plans/...-tool-input-repair-cch-strip-schema-gate.md` | None | Plan 0/41 checked, code in ebook-v1.0 repo | Port from external repo | Execute migration plan |
| Gap Closing (hooks/git/todo/webfetch/undo) | **Verified** | — | `plans/...-rivet-gap-closing-hardening.md` | `src/hooks/*`, `src/tools/git.ts`, `src/tools/todo*.ts`, `src/tools/web-fetch.ts`, `src/agent/file-history.ts` | Hooks error isolation + 2 new events (UserPromptSubmit, PreCompact), git log/stash + 50KB truncation, turndown HTML, TodoStore concurrency, undo orphan cleanup, 684 tests pass | None | — |
| P1 Remaining Gaps | **Verified** | — | `plans/...-p1-remaining-gaps.md` | `src/tui/cockpit/state.ts`, `src/agent/strategy-shift.ts`, `src/agent/approval-risk.ts` | CockpitSnapshot aggregator, doom-loop strategy shift (4 detectors), MCP tool risk rules, 694 tests pass | None | — |
| Performance Optimization | **Verified** | — | `plans/...-performance-optimization.md` | `src/prompt/volatile-git.ts`, `src/tui/log-state.ts`, `src/agent/context.ts`, `src/main.tsx` | Non-blocking git status stale cache, TUI log batching, incremental token accounting, smartCompact wired, 694 tests pass | None | — |
| Capability Reliability Layer | **Verified** | — | `plans/...-p2-2-capability-reliability-layer.md` | `src/tools/path-validate.ts`, `src/agent/checkpoint.ts`, `src/tools/output-store.ts`, `src/tools/glob.ts`, `src/tools/grep.ts`, `src/tools/run-tests.ts` | Cwd boundary validation, checkpoint v2 (dirty snapshot + confirmation token), safe output filenames, glob/grep realpath + symlink cycle protection, safe test filter argv, VerificationMetadata, 694 tests pass | None | — |
| Harness Cockpit | **Verified** | `specs/...-p2-3-harness-cockpit-design.md` | `plans/...-p2-3-harness-cockpit-implementation.md` | `src/agent/trace-store.ts`, `src/agent/approval-risk.ts`, `src/tui/cockpit/*`, `src/model/capability.ts` | TraceStore, approval risk assessment, 6 cockpit panels (trace/verify/context/safety/model/mcp), CockpitRail with status indicators, ModelCapabilityCard, 694 tests pass | None | — |
| Open Source Harness Strategy | **Designed** | `specs/...-open-source-harness-strategy-design.md` | None | None | Brainstorm complete | No plan yet | Review design, write implementation plan |

## Summary

- **Verified**: 20 capabilities (Context Layer, Tool Safety, Execution Resilience x2, Cockpit Observability, Cockpit Techstyle, MCP Integration, Model Routing, Repo Intelligence, Progressive Context Engine, Sub-agent Orchestration, Attention Anchors, XML Protocol, Multi-pass Repair Pipeline, Gap Closing, Pastel Theme + Render Perf + Memory Safety, P1 Remaining Gaps, Performance Optimization, Capability Reliability Layer, Harness Cockpit, Cache Safety)
- **MVP**: 0
- **Planned**: 0 capabilities
- **Designed**: 2 capabilities (CTCL Migration, Open Source Strategy)

## Maintenance Rules

- New design/spec: status cannot exceed **Designed**.
- New implementation plan: status upgrades to **Planned**.
- Code merged without full verification: status is **MVP** at most.
- `npm run typecheck`, `npm test`, `npm run build`, and target behavior tests all pass: status can be **Verified**.
- Review finds deviation: status must be **Gap** or noted in "Known Gaps" column.
