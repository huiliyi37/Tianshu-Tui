# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-17T01:22:58.046Z
> Files: 374 tracked | Anatomy hits: 0 | Misses: 0
>
> Manual update 2026-05-17: Session HA Task 1 added recoverable session loading and dynamic session-dir resolution in `src/agent/session-persist.ts`, restore recovery notes in `src/tui/app.tsx`, targeted coverage in `src/agent/__tests__/session-persist.test.ts`, standardized synthetic resume repair text in `src/context/resume-preflight.ts`, and buglog entry `bug-079` for session-dir test isolation.
> Manual update 2026-05-17: Recorded user delegation preference in `.wolf/cerebrum.md`, `.wolf/memory.md`, and persistent memory `feedback_model-delegation.md`; main implementation remains in the primary assistant session.
> Manual update 2026-05-17: Session HA Task 2 added partial assistant persistence on stream errors in `src/agent/loop.ts`, regression coverage in `src/agent/__tests__/loop.test.ts`, and buglog entry `bug-080`.
> Manual update 2026-05-17: Session HA Task 3 added `src/tools/process-kill.ts`, process-tree timeout cleanup in `src/tools/bash.ts` and `src/tools/process-tracker.ts`, tests in `src/tools/__tests__/bash.test.ts` and `src/tools/__tests__/process-kill.test.ts`, timeout single-settle protection in `src/tools/bash.ts`, and buglog entry `bug-081`.
> Manual update 2026-05-17: Session HA Task 4 added configurable MCP operation timeouts and degraded callTool state in `src/mcp/manager.ts`, `degraded` status in `src/mcp/types.ts`, `timeoutMs` config parsing in `src/mcp/config.ts`, tests in `src/mcp/__tests__/manager.test.ts`, and buglog entry `bug-082`.
> Manual update 2026-05-17: Session HA Task 5 added smart compaction summary quality gates in `src/compact/auto.ts`, fallback coverage in `src/compact/__tests__/auto.test.ts`, and buglog entry `bug-083`.
> Manual update 2026-05-17: Session HA Task 6 escaped volatile `repairHint` and `sessionMemoryBlock` inside fixed XML tags in `src/prompt/volatile.ts`, added injection regression tests in `src/prompt/__tests__/volatile.test.ts`, and buglog entry `bug-084`.
> Manual update 2026-05-17: Session HA Task 7 added bounded live stream tail helper in `src/tui/stream-window.ts`, covered it in `src/tui/__tests__/stream-window.test.ts`, connected `src/tui/app.tsx` live display state without truncating final assistant content, and buglog entry `bug-085`.
> Manual update 2026-05-17: Session HA Task 8 added `resetAccumulator()` and single-step `escalate` behavior in `src/agent/prediction-error.ts`, wired tipping-point recovery in `src/agent/loop.ts`, strengthened `src/agent/__tests__/prediction-error.test.ts`, exported ThinkingCollapser format helpers in `src/tui/thinking.tsx`, added `src/tui/__tests__/thinking.test.tsx`, and buglog entries `bug-086`/`bug-087`.
> Manual update 2026-05-17: Session HA Task 9 updated `CHANGELOG.md` and `README.md` for Session HA Closure, aligned `src/prompt/__tests__/engine.test.ts` with escaped session-memory volatile context, logged bug `bug-088`, and final validation passed typecheck, 1043 tests, and build.
> Manual update 2026-05-17: Main merge resolved duplicate Session HA/cerebellar helper definitions in `src/agent/prediction-error.ts` and `src/tui/thinking.tsx`, reran typecheck/tests/build successfully, and logged bug `bug-089`.
> Manual update 2026-05-17: Documentation refresh expanded `README.md` Session HA Closure status into a completed-this-round checklist, updated architecture entries for restore/process/MCP/compaction/prompt/TUI streaming, and added a CHANGELOG completed/validation section.
> Manual update 2026-05-17: Activity Status Layer brainstorming produced `docs/superpowers/specs/2026-05-17-rivet-activity-status-layer-design.md` and separate process asset `docs/superpowers/specs/2026-05-17-rivet-activity-status-layer-brainstorm.md` for long-task observability beyond thinking.
> Manual update 2026-05-17: Activity Status Layer implementation plan added `docs/superpowers/plans/2026-05-17-rivet-activity-status-layer.md` with TDD tasks for `src/tui/activity-status.ts`, AgentStatus, ThinkingCollapser, App projection, tool/MCP/analyzing activity, docs, and validation.
> Manual update 2026-05-17: Activity Status Layer Task 1 created pure lifecycle module `src/tui/activity-status.ts` with ActivityPhase/ActivityLifecycleStatus/ActivityState types and immutable transition functions (createIdleActivity, beginActivity, heartbeatActivity, completeActivity, failActivity, clearActivity), covered in `src/tui/__tests__/activity-status.test.ts` (5 tests), typecheck/tests pass.
> Manual update 2026-05-17: Activity Status Layer Task 1 follow-up aligned `src/tui/activity-status.ts` with the plan: no idle begin type, shared HeartbeatOptions, idle no-op transitions, completion/failure label and sizeHint updates, with expanded tests in `src/tui/__tests__/activity-status.test.ts`.
> Manual update 2026-05-17: Activity Status Layer Task 2 added display formatting helpers `formatActivityDuration`, `formatThinkingSize`, `activityPhaseLabel`, `formatActivitySummary`, `classifyToolActivity`, and `shouldBeginAnalyzing` in `src/tui/activity-status.ts`, with eight new tests in `src/tui/__tests__/activity-status.test.ts` (14 total); typecheck and 1057 tests pass.
> Manual update 2026-05-17: Activity Status Layer Task 3 added `activitySummary` prop to `AgentStatusProps`, exported `statusPhaseText` helper that overrides `phaseLabel` when an activity summary is provided, updated `AgentStatus` component to use it, and added two tests in `src/tui/__tests__/agent-status.test.ts`; typecheck and 133 agent-status tests pass.
> Manual update 2026-05-17: Activity Status Layer Task 4 added `thinkingStatusLabel` pure helper and `completedDurationMs` prop to `ThinkingCollapser` in `src/tui/thinking.tsx`, extended `src/tui/__tests__/thinking.test.tsx` with three status label tests; typecheck and 19 combined thinking/activity-status tests pass.
> Manual update 2026-05-17: Activity Status Layer Task 5 added `shouldProjectActivity` cadence guard in `src/tui/activity-status.ts`, wired low-frequency (1Hz) activity projection in `src/tui/app.tsx` for thinking/answer streaming with begin/heartbeat/complete/fail lifecycle, projected activity summary to AgentStatus and completed thinking duration to ThinkingCollapser, added three projection cadence tests; typecheck and 1067 tests pass.
> Manual update 2026-05-17: Activity Status Layer Task 6 added `toolActivityLabel` and `analysisLabelForTool` helpers in `src/tui/activity-status.ts`, wired tool/MCP activity lifecycle with heartbeat during live output, completion/failure on final result, and analyzing phase for large read_file/bash results in `src/tui/app.tsx`, added three tool label tests in `src/tui/__tests__/activity-status.test.ts`; typecheck and 1067 tests pass.

## ../../../.claude/projects/-Users-banxia-app-deepseek-tui-opencode-tui/memory/

- `feedback_model-delegation.md` — Declares models (~217 tok)
- `MEMORY.md` — Memory (~317 tok)
- `project_open_model_agent_goal.md` (~234 tok)
- `project_subagent-phase1-validation.md` — 子代理协同 Phase 1 — 自主执行验证记录 (~487 tok)
- `reference_rivet-codebase-index.md` — Rivet Codebase Module Map (~1188 tok)

## ../../../.cli-proxy-api/

- `config.yaml` (~2172 tok)

## ./

- `.gitignore` — Git ignore rules (~23 tok)
- `CHANGELOG.md` — Changelog (~6162 tok)
- `CLAUDE.md` — Rivet (~310 tok)
- `config.example.toml` — ~/.opencode/config.toml (~232 tok)
- `package-lock.json` — npm lock file (~19981 tok)
- `package.json` — Node.js package manifest (~164 tok)
- `README.md` — Project documentation (~13658 tok)
- `tsconfig.json` — TypeScript configuration (~153 tok)
- `tsup.config.ts` (~65 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .claude/worktrees/session-ha-closure/

- `package-lock.json` (~19976 tok)

## .claude/worktrees/session-ha-closure/.wolf/

- `anatomy.md` — anatomy.md (~7130 tok)
- `buglog.json` — Declares annotation (~7919 tok)
- `cerebrum.md` — Cerebrum (~616 tok)
- `memory.md` — Memory (~34104 tok)

## .claude/worktrees/session-ha-closure/src/agent/

- `loop.ts` — Exports ApprovalMode, AgentConfig, AgentCallbacks, AgentLoop (~6684 tok)
- `session-persist.ts` — Append a single message to the session file (~2560 tok)

## .claude/worktrees/session-ha-closure/src/agent/__tests__/

- `loop.test.ts` — Creates a mock client that delivers content blocks and then stops (~7485 tok)
- `session-persist.test.ts` — Declares persist (~2085 tok)

## .claude/worktrees/session-ha-closure/src/context/

- `resume-preflight.ts` — Exports runResumePreflight (~681 tok)

## .claude/worktrees/session-ha-closure/src/tools/

- `bash.ts` — Exports BASH_TOOL (~1411 tok)
- `process-kill.ts` — Exports killProcessTree (~119 tok)
- `process-tracker.ts` — Exports track, killAll, getActiveCount (~205 tok)

## .claude/worktrees/session-ha-closure/src/tools/__tests__/

- `bash.test.ts` — Declares wait (~328 tok)
- `process-kill.test.ts` — Declares calls (~257 tok)

## .claude/worktrees/session-ha-closure/src/tui/

- `app.tsx` — THINKING_FLUSH_MS (~9654 tok)

## .omc/

- `prd.json` (~446 tok)
- `progress.txt` — Wave 5: Trust Infrastructure — Progress Log (~633 tok)

## .superpowers/brainstorm/

- `2026-05-15-rivet-open-model-terminal-agent-fragments.json` (~1635 tok)
- `2026-05-16-rivet-evolutionary-tui-memory-fragments.json` — Declares spine (~2062 tok)
- `2026-05-16-rivet-execution-resilience-layer-fragments.json` — Declares exists (~1500 tok)
- `2026-05-16-rivet-glanceable-cockpit-techstyle-fragments.json` (~1123 tok)
- `2026-05-16-rivet-multi-pass-repair-pipeline-fragments.json` (~1282 tok)
- `2026-05-16-rivet-pastel-aesthetic-performance-memory-fragments.json` (~930 tok)
- `2026-05-16-rivet-subagent-orchestration-fragments.json` — Rivet subagent orchestration brainstorm fragments (~2146 tok)
- `2026-05-16-rivet-subagent-orchestration-fragments.json` (~2146 tok)
- `2026-05-16-rivet-xml-protocol-speculative-engine-fragments.json` (~1213 tok)

## Evolutionary Context Fabric Phase 1 Final Review Fixes


## Evolutionary Context Fabric Phase 1 Implementation


## Evolutionary Context Fabric Phase 1 Review Feedback


## Evolutionary Context Fabric Phase 1 Runtime


## Planned Evolutionary Context Fabric Phase 1


## Planned Evolutionary Context Fabric Phase 2


## docs/

- `cliproxy-fork-optimization.md` — Cliproxy Fork 优化：Codex 额度减半 (~419 tok)
- `codebase-index.md` — Rivet Codebase Index (~2725 tok)
- `optimization-design-v2.md` — OpenCode TUI 优化增补设计 (~4002 tok)

## docs/analysis/

- `2026-05-15-handoff.md` — Handoff: Rivet v0.1 — 2026-05-15 (updated P2.2) (~2443 tok)
- `2026-05-16-xml-protocol-code-review-fixes.md` — 工作记录：XML Protocol + Code Review Fixes (~783 tok)

## docs/superpowers/plans/

- `2026-05-15-rivet-p2-2-capability-reliability-layer.md` — Rivet P2.2 Capability Reliability Layer 实现计划 (~14754 tok)
- `2026-05-15-rivet-p2-3-harness-cockpit-implementation.md` — Rivet P2.3 Harness Cockpit TUI 实现计划 (~13437 tok)
- `2026-05-15-rivet-performance-optimization.md` — Rivet 性能优化与 Claude Code 对标实现计划 (~10205 tok)
- `2026-05-16-multi-pass-repair-pipeline.md` — Multi-Pass Repair Pipeline 实现计划 (~6966 tok)
- `2026-05-16-rivet-cockpit-capability-ledger.md` — Rivet Cockpit + Capability Ledger 实现计划 (~3995 tok)
- `2026-05-16-rivet-ecf-phase4-rules-budget.md` — ECF Phase 4: Project Rules + Claim Budget 实现计划 (~3464 tok)
- `2026-05-16-rivet-ecf-phase4b-recall-export.md` — ECF Phase 4B: Recall Tool + Claim Export/Import 实现计划 (~4270 tok)
- `2026-05-16-rivet-evolutionary-context-fabric-phase1.md` — Evolutionary Context Fabric Phase 1 实现计划 (~9576 tok)
- `2026-05-16-rivet-evolutionary-context-fabric-phase3.md` — Evolutionary Context Fabric Phase 3 实现计划 (~5833 tok)
- `2026-05-16-rivet-execution-resilience-layer-implementation.md` — Execution Resilience Layer 实现计划 (~6873 tok)
- `2026-05-16-rivet-execution-trust-closure-implementation.md` — Rivet Execution Trust Closure 实现计划 (~10006 tok)
- `2026-05-16-rivet-gap-closing-hooks-git-todo-webfetch-undo.md` — Rivet 差距弥补：Hooks / Git / Todo / WebFetch / Undo 实现计划 (~11245 tok)
- `2026-05-16-rivet-glanceable-cockpit-techstyle-implementation.md` — Rivet Glanceable Cockpit + 科技风视觉层 实现计划 (~6867 tok)
- `2026-05-16-rivet-mcp-client-implementation.md` — Rivet MCP Client 实现计划 (~7790 tok)
- `2026-05-16-rivet-progressive-context-engine-implementation.md` — Rivet Progressive Context Engine 实现计划 (~18102 tok)
- `2026-05-16-rivet-risk-remediation.md` — Rivet 风险修复 实现计划 (~5070 tok)
- `2026-05-16-rivet-subagent-orchestration-implementation.md` — Rivet 子代理协同 Phase 1 实现计划 (~14921 tok)
- `2026-05-16-rivet-wave6-goal-loop.md` — Wave 6: Goal Loop 实施计划 (~3900 tok)
- `2026-05-16-rivet-wave8-context-fabric-phase2.md` — Wave 8: Context Fabric Phase 2 — Claim 自动提取 + TTL + 晋升 实施计划 (~4816 tok)
- `2026-05-16-rivet-xml-protocol-speculative-engine-implementation.md` — Rivet XML Protocol Layer + Speculative Pre-warming 实现计划 (~5642 tok)
- `2026-05-17-cerebellar-loop.md` — Cerebellar Loop: Prediction-Error Accumulator 实现计划 (~4838 tok)
- `2026-05-17-deep-interview-plan.md` — Deep Interview 实施计划 (~196 tok)
- `2026-05-17-multi-provider-phase1.md` — Multi-Provider Integration Phase 1 实现计划 (~4349 tok)
- `2026-05-17-multi-provider-phase2.md` — Multi-Provider Phase 2: OpenAIClient 实现计划 (~7193 tok)
- `2026-05-17-project-memory-dream.md` — Project Memory: Dream 蒸馏 Phase 1 实现计划 (~3733 tok)
- `2026-05-17-project-memory-phase1.md` — Project Memory Phase 1 实现计划 (~4191 tok)
- `2026-05-17-rivet-ecf-phase5-recall-feedback.md` — ECF Phase 5: Recall 正反馈 + Claim 质量信号 实现计划 (~2705 tok)
- `2026-05-17-rivet-wave9-defect-fixes.md` — Wave 9: 内部缺陷修复 + 结构优化 实施计划 (~4239 tok)
- `2026-05-17-session-ha-closure.md` — Session HA 闭环补强实现计划 (~8205 tok)
- `2026-05-17-session-rendering-p0.md` — 会话渲染 P0 实现计划 (~8138 tok)
- `2026-05-17-session-rendering-p1p2.md` — Session Rendering P1/P2 实现计划 (~2385 tok)
- `2026-05-17-wave10-test-loop-split.md` — Wave 10: 测试补强 + loop.ts 拆分 实施计划 (~10180 tok)
- `2026-05-17-wave11-cache-perf.md` — Wave 11: Cache 效率 + Token 节约 实现计划 (~3516 tok)

## docs/superpowers/specs/

- `2026-05-15-rivet-open-model-terminal-agent-direction-design.md` — Rivet 开源模型终端代理方向深度头脑风暴结果 (~2338 tok)
- `2026-05-15-rivet-p2-1-performance-dev-capability-optimization.md` — P2.1：Rivet 性能层与开发能力层优化建议 (~2607 tok)
- `2026-05-15-rivet-p2-3-harness-cockpit-design.md` — Rivet P2.3 Harness Cockpit TUI 设计 (~3319 tok)
- `2026-05-15-system-prompt-expansion-design.md` — OpenCode TUI System Prompt 架构优化 (~791 tok)
- `2026-05-16-rivet-core-business-gap-review.md` — Rivet 非 Context 核心业务缺口审查与修复路线 (~1906 tok)
- `2026-05-16-rivet-evolutionary-tui-memory-design.md` — Rivet Evolutionary TUI Memory 深度头脑风暴结果 (~5738 tok)
- `2026-05-16-rivet-execution-resilience-layer-design.md` — Rivet Execution Resilience Layer 设计 (~1696 tok)
- `2026-05-16-rivet-execution-trust-closure-design.md` — Rivet Execution Trust Closure 设计 (~1804 tok)
- `2026-05-16-rivet-glanceable-cockpit-techstyle-design.md` — Rivet Glanceable Cockpit + 科技风视觉层 设计 (~1897 tok)
- `2026-05-16-rivet-p2-model-mcp-repo-intel-design.md` — Rivet P2 补强设计：Model Routing + MCP Integration + Repo Intelligence (~2478 tok)
- `2026-05-16-rivet-pastel-aesthetic-performance-memory-design.md` — Rivet 二次元 Pastel UI + 渲染性能 + 内存安全 深度头脑风暴结果 (~922 tok)
- `2026-05-16-rivet-progressive-context-engine-design.md` — Rivet Progressive Context Engine 方案设计 (~3845 tok)
- `2026-05-16-rivet-subagent-orchestration-design.md` — Rivet 主控模型子代理协同能力深度头脑风暴结果 (~7664 tok)
- `2026-05-16-rivet-xml-protocol-speculative-engine-design.md` — Rivet XML Protocol Layer + Speculative Pre-warming 设计 (~2060 tok)
- `2026-05-17-cerebellar-loop-brainstorm.md` — Cerebellar Loop: Deep Brainstorm 过程记录 (~1245 tok)
- `2026-05-17-deep-interview-design.md` — Deep Interview — 认知对齐模式 (~1212 tok)
- `2026-05-17-multi-provider-integration-design.md` — Multi-Provider Integration: Design (v2 — Deep Brainstorm) (~4366 tok)
- `2026-05-17-multi-provider-integration.md` — Multi-Provider Integration: Session Rendering P1/P2 + Cross-Provider Switching (~1031 tok)
- `2026-05-17-project-memory-brainstorm.md` — 项目记忆系统：深度头脑风暴过程 (~963 tok)
- `2026-05-17-project-memory-dream-design.md` — 项目记忆系统 v2：Dream 蒸馏方案 — 深度头脑风暴 (~826 tok)
- `2026-05-17-recall-feedback-design.md` — ECF Phase 5: Recall 正反馈 + Claim 质量信号 (~399 tok)
- `2026-05-17-session-rendering-p0-design.md` — P0 会话渲染优化：消息类型分离 + 工具调用折叠 (~1534 tok)
- `2026-05-17-session-rendering-p1p2-design.md` — Session Rendering P1/P2: AssistantMessage + Segmented Static (~1287 tok)
- `2026-05-17-wave10-test-loop-split-design.md` — Wave 10: 测试补强 + loop.ts 拆分 设计规格 (~857 tok)
- `2026-05-17-wave11-cache-perf-design.md` — Wave 11: 性能优化 — Cache 效率 + Token 节约 (~598 tok)

## docs/superpowers/status/

- `2026-05-16-rivet-core-capability-ledger.md` — Rivet Core Capability Ledger (~4002 tok)

## docs/superpowers/validations/

- `2026-05-16-subagent-phase1-validation.md` — 子代理协同 Phase 1 — 自主执行验证报告 (~1377 tok)
- `2026-05-17-cerebellar-loop-validation.md` — Cerebellar Loop — 自主执行验证报告 (~806 tok)

## prompts/

- `base.md` — Environment (~136 tok)

## prompts/tools/

- `bash.md` — Bash Tool (~295 tok)
- `edit.md` — Edit File Tool (~147 tok)
- `read.md` — Read File Tool (~179 tok)
- `write.md` — Write File Tool (~142 tok)

## scripts/

- `test-deepseek.ts` — DeepSeek API End-to-End Test Harness (~3914 tok)

## src/

- `fs-atomic.ts` — Atomically write a file: write to a temp file in the same directory, (~235 tok)
- `goal-loop.ts` — Exports GoalLoopAgent, GoalLoopConfig, GoalLoopResult, runGoalLoop (~874 tok)
- `headless.ts` — Exports HeadlessCliArgs, HeadlessJsonOutput, HeadlessRunResult, HeadlessAgent + 3 more (~1052 tok)
- `main.tsx` — deepMerge (~6592 tok)
- `validation.ts` — Exports isValidSessionId, assertValidSessionId (~78 tok)

## src/__tests__/

- `claim-store-durable.test.ts` — Declares dir (~1178 tok)
- `commands-loader.test.ts` — Declares makeProject (~716 tok)
- `create-agent-config.test.ts` — Declares AgentConfigInput (~636 tok)
- `delegate-batch.test.ts` — Declares tool (~472 tok)
- `delegate-task.test.ts` — Declares tool (~488 tok)
- `file-history-persist.test.ts` — Declares snapshots (~529 tok)
- `goal-loop-integration.test.ts` — Declares result (~773 tok)
- `goal-loop.test.ts` — Declares GoalLoopConfig (~1554 tok)
- `headless.test.ts` — Declares result (~840 tok)
- `wave5-integration.test.ts` — Declares reg (~930 tok)

## src/agent/

- `adaptive-routing.ts` — 1 second of avgLatencyMs penalizes 0.1 points of passRate in the composite score (~530 tok)
- `aggregation.ts` — Exports aggregateResults (~388 tok)
- `approval-risk.ts` — Exports RiskLevel, RiskAssessment, assessToolRisk (~1266 tok)
- `checkpoint.ts` — Returns the checkpoint file path scoped to a session ID. (~2353 tok)
- `context.ts` — Replace all messages (used after compaction) (~2024 tok)
- `coordinator-state.ts` — Cumulative event counts — each completed work order increments queued, running, AND its terminal sta (~490 tok)
- `coordinator.ts` — Exports DelegationRequest, CoordinatorRun, WorkerRuntimeFactory, DelegationCoordinatorConfig + 2 mor (~1550 tok)
- `create-agent-config.ts` — Exports ModelSpec, AgentConfigInput, createAgentConfig (~625 tok)
- `delivery-gate.ts` — Exports DeliveryGateSeverity, DeliveryGateResult, buildDeliveryGate (~641 tok)
- `evidence.ts` — Exports DeliveryVerificationStatus, EvidenceState, EvidenceTracker (~1212 tok)
- `execution-guidance.ts` — Exports GuidanceTrajectoryEntry, ExecutionGuidanceInput, ExecutionGuidance, buildExecutionGuidance (~1292 tok)
- `failure-classifier.ts` — Classify all failures found in a test run output (~1162 tok)
- `file-history-persist.ts` — Exports FileSnapshot, HistoryEntry, persistFileHistory, loadFileHistory (~213 tok)
- `file-history.ts` — Exports FileBackup, FileSnapshot, DiffStats, FileHistory (~1780 tok)
- `impact-hint.ts` — Exports ImpactHint, generateImpactHint (~764 tok)
- `import-graph.ts` — Exports ImportGraph, buildImportGraph, getReverseDeps, invalidateFile (~1122 tok)
- `intent-extractor.ts` — Exports IntentType, Intent, extractIntents (~362 tok)
- `loop.ts` — Exports ApprovalMode, AgentConfig, AgentCallbacks, AgentLoop (~6670 tok)
- `prediction-error.ts` — Exports InterventionLevel, PredictionAccumulator, createPredictionAccumulator, recordPrediction + 5 (~610 tok)
- `prewarm.ts` — Exports PrewarmCache (~323 tok)
- `repair-hint.ts` — Exports RepairHintTracker (~368 tok)
- `repair-passes.ts` — Exports fourHorsemenPass, fixAutoLinks, semanticRepairPass (~1019 tok)
- `repair-pipeline.ts` — Exports RepairContext, RepairResult, RepairPass, RepairTelemetryEntry + 2 more (~346 tok)
- `retry-policy.ts` — Exports RetryPolicyInput, RetryPolicyDecision, shouldRetryToolFailure (~428 tok)
- `session-persist.ts` — Append a single message to the session file (~2266 tok)
- `strategy-shift.ts` — Exports TrajectorySummary, suggestStrategyShift (~103 tok)
- `task-state.ts` — Exports TaskState, extractTaskState (~326 tok)
- `tool-pipeline.ts` — Exports ToolPipelineDeps, ToolExecResult, executeToolUse (~5131 tok)
- `trace-store.ts` — Exports TraceEventKind, TraceEventStatus, DoomLoopLevel, TraceEvent + 9 more (~718 tok)
- `trajectory.ts` — Exports TrajectoryEntry, TrajectoryRecorder (~312 tok)
- `turn-end.ts` — Exports TurnEndDeps, TurnEndResult, processTurnEnd (~781 tok)
- `turn-harness.ts` — Exports ToolExecution, ToolExecutionResult, TurnHarnessConfig, TurnHarness (~818 tok)
- `verification.ts` — Exports VerificationState, emptyVerificationState, addVerificationRun, summarizeVerification + 2 mor (~514 tok)
- `work-order.ts` — Zod schemas: workOrderKindSchema, workerProfileSchema, aggregationPolicySchema, workOrderScopeSchema (~2145 tok)
- `work-queue.ts` — Exports QueueEntry, WorkOrderQueue (~472 tok)
- `worker-evidence.ts` — Exports verifyWorkerEvidence (~385 tok)
- `worker-prompts.ts` — buildWorkerPrompt, buildWorkerRepairPrompt, buildPrimaryWorkerPacket (~2263 tok)
- `worker-session.ts` — Exports WorkerSessionConfig, WorkerTranscript, WorkerSessionRun, runWorkerSession (~1132 tok)

## src/agent/__tests__/

- `adaptive-routing.test.ts` — Declares router (~703 tok)
- `aggregation.test.ts` — Declares result (~708 tok)
- `approval-risk.test.ts` — Declares antibodyClaim (~2444 tok)
- `checkpoint.test.ts` — makeTempGitRepo: cleanupRepo (~2001 tok)
- `context-ledger-state.test.ts` — Declares makeLedger (~543 tok)
- `context.test.ts` — Declares ctx (~1222 tok)
- `coordinator-state.test.ts` — Declares state (~791 tok)
- `coordinator.test.ts` — WorkerRuntimeFactory: fakeTool, makeRegistry, resultFor (~2588 tok)
- `delivery-gate.test.ts` — Declares state (~676 tok)
- `execution-guidance.test.ts` — Declares guidance (~473 tok)
- `failure-classifier.test.ts` — Declares errors (~1068 tok)
- `file-history.test.ts` — Declares TMP (~742 tok)
- `impact-hint.test.ts` — Exports a, b, mod (~524 tok)
- `intent-extractor.test.ts` — Declares Intent (~812 tok)
- `loop-evidence.test.ts` — Captures a snapshot of evidence state during onTurnComplete, before the loop resets the same object (~3445 tok)
- `loop.test.ts` — Creates a mock client that delivers content blocks and then stops (~5646 tok)
- `prediction-error.test.ts` — Declares PredictionAccumulator (~1590 tok)
- `prewarm.test.ts` — API routes: GET (9 endpoints) (~443 tok)
- `repair-pipeline.test.ts` — --- Pipeline skeleton tests --- (~1683 tok)
- `retry-policy.test.ts` — Declares result (~457 tok)
- `session-persist.test.ts` — Declares persist (~1578 tok)
- `task-state.test.ts` — Declares entries (~563 tok)
- `tool-pipeline.test.ts` — ToolPipelineDeps: makeDeps (~1116 tok)
- `trace-store.test.ts` — Declares TraceEvent (~604 tok)
- `trajectory.test.ts` — Declares tr (~518 tok)
- `turn-end.test.ts` — TurnEndDeps: makeDeps (~667 tok)
- `turn-harness.test.ts` — TurnHarnessConfig: makeConfig (~2368 tok)
- `verification.test.ts` — Declares baseRun (~739 tok)
- `work-order.test.ts` — Declares order (~1254 tok)
- `work-queue.test.ts` — Declares order (~762 tok)
- `worker-evidence.test.ts` — Declares result (~579 tok)
- `worker-prompts.test.ts` — Worker prompt/repair/packet construction tests (~2204 tok)
- `worker-session.test.ts` — Headless worker isolation, repair retry, blocked result tests (~4974 tok)

## src/api/

- `client.ts` — Whether the provider has a known bug where tool JSON appears in text content (~3998 tok)
- `deepseek.ts` — Generic factory: create an ApiClient for any provider described by a (~572 tok)
- `factory.ts` — Runtime parameters that vary per-model or per-call, not stored in config (~663 tok)
- `provider.ts` — Describes what a provider supports and how to adapt requests/responses. (~459 tok)
- `sse.ts` — Exports SSEEvent, SSEParser (~635 tok)
- `types.ts` — Exports ContentBlockText, ContentBlockThinking, ContentBlockToolUse, ContentBlockToolResult + 7 more (~552 tok)

## src/api/__tests__/

- `schema-gate.test.ts` (~205 tok)
- `sse.test.ts` — Declares parser (~1419 tok)

## src/compact/

- `auto.ts` — Decide whether automatic compaction should fire. (~1732 tok)
- `constants.ts` — Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+). (~485 tok)
- `index.ts` — Declares CompactionDecision (~104 tok)
- `micro.ts` — MicroCompact: lightweight round-safe truncation without API calls. (~1270 tok)

## src/compact/__tests__/

- `auto.test.ts` — Declares baseConfig (~784 tok)
- `compact.test.ts` — Declares msg (~1646 tok)
- `micro.test.ts` — Declares msgs (~585 tok)

## src/config/

- `default.ts` — Exports DEFAULT_CONFIG (~775 tok)
- `manager.ts` — Exports loadConfig, listProviders, getProvider, getDefaultProvider + 10 more (~3332 tok)
- `schema.ts` — Zod schemas: modelConfigSchema, providerSchema, agentSchema, compactSchema + 2 more (~623 tok)

## src/context/

- `antibody.ts` — Exports AntibodyContext, createAntibodyProposal (~296 tok)
- `claim-budget.ts` — Exports MAX_ACTIVE_CLAIMS, selectEvictionCandidates (~176 tok)
- `claim-export.ts` — Exports ClaimExportData, exportDurableClaims, importClaims (~434 tok)
- `claim-extractor.ts` — Exports ToolResultContext, ClaimExtractionMeta, extractClaimsFromToolResult (~1456 tok)
- `claim-store.ts` — Exports ContextClaimEvent, ClaimFilter, ClaimUseInput, ContextClaimStore (~2811 tok)
- `claims.ts` — Exports ContextClaimKind, ContextClaimScope, ContextClaimStatus, EvidenceKind + 12 more (~1509 tok)
- `conflict-detect.ts` — Exports ClaimConflict, detectConflicts (~415 tok)
- `ledger.ts` — Exports createContextLedger (~359 tok)
- `microcompact.ts` — Exports microcompactToolResults, applyMicrocompact (~926 tok)
- `promotion.ts` — Exports ClaimStatusCounts, evaluatePromotion, claimHasFileEvidence, countClaimsByStatus (~536 tok)
- `reactive-compact.ts` — Exports ReactiveRoundSelectionOptions, CompactBoundaryInput, selectReactiveCompactRounds, createComp (~384 tok)
- `resume-preflight.ts` — Exports runResumePreflight (~682 tok)
- `rounds.ts` — Exports groupIntoRounds, computeInvariantStatus, getSafeCutIndices (~1703 tok)
- `rules-loader.ts` — Exports loadProjectRules (~375 tok)
- `session-memory.ts` — Exports loadSessionMemory, appendSessionMemory, buildSessionMemoryBlock (~599 tok)
- `token-estimate.ts` (~18 tok)
- `types.ts` — ─── Health & Budget ────────────────────────────────────────── (~1066 tok)

## src/context/__tests__/

- `antibody.test.ts` — Declares failure (~589 tok)
- `claim-budget.test.ts` — Declares claim (~648 tok)
- `claim-export.test.ts` — Declares proposal (~995 tok)
- `claim-extractor.test.ts` — Exports MAX_RETRIES, TIMEOUT, PORT, X (~1731 tok)
- `claim-store.test.ts` — tempDir: proposal (~3232 tok)
- `claims.test.ts` — Declares ContextClaim (~1870 tok)
- `conflict-detect.test.ts` — Declares claim (~747 tok)
- `ledger.test.ts` — userText: assistantText (~440 tok)
- `microcompact.test.ts` — userText: assistantText, assistantWithBlocks, userWithBlocks + 4 more (~1539 tok)
- `promotion.test.ts` — Declares claim (~1791 tok)
- `resume-preflight.test.ts` — userText: assistantText, assistantWithBlocks, userWithBlocks + 4 more (~1321 tok)
- `rounds.test.ts` — userText: assistantText, assistantWithBlocks, userWithBlocks + 4 more (~2586 tok)
- `rules-loader.test.ts` — Declares dir (~786 tok)
- `session-memory.test.ts` — Declares dir (~701 tok)

## src/failures/

- `sample.ts` — Exports createFailureSample, redactSecrets (~200 tok)

## src/failures/__tests__/

- `sample.test.ts` — Declares sample (~300 tok)

## src/hooks/

- `registry.ts` — API routes: GET (4 endpoints) (~628 tok)
- `types.ts` — Exports HookEvent, PreToolUseInput, PostToolUseInput, NotificationInput + 6 more (~326 tok)

## src/hooks/__tests__/

- `registry.test.ts` — Declares registry (~840 tok)

## src/mcp/

- `config.ts` — Zod schemas: mcpServerConfigSchema, mcpConfigSchema (~268 tok)
- `manager.ts` — Exports McpToolDef, ConnectedServer, McpManager (~1428 tok)
- `types.ts` — Exports McpConnectionState (~68 tok)
- `wrapper.ts` — Exports mcpToolName, createMcpToolWrapper (~782 tok)

## src/mcp/__tests__/

- `config.test.ts` — Declares config (~541 tok)
- `manager.test.ts` — Declares makeConfig (~1004 tok)
- `wrapper.test.ts` — Declares mcpDef (~1370 tok)

## src/model/

- `capability.ts` — Exports ModelCapabilityCard, recommendModelForTask (~400 tok)
- `routing-metrics.ts` — Exports RoutingEvent, RoutingMetricsCollector (~303 tok)
- `task-inferrer.ts` — Exports TaskInference, ToolCallRecord, inferTaskType (~445 tok)

## src/model/__tests__/

- `capability.test.ts` — Declares card (~250 tok)
- `routing-metrics.test.ts` — Declares m (~503 tok)
- `task-inferrer.test.ts` — Declares result (~583 tok)

## src/prompt/

- `engine.ts` — Build a request. Volatile context is injected as an independent user message (~2504 tok)
- `fingerprint.ts` — Exports PrefixFingerprint, DriftEvent, computeFingerprint, detectDrift (~400 tok)
- `static.ts` — Exports StaticPromptContext, buildSystemPrompt (~946 tok)
- `volatile-git.ts` — Exports formatGitStatus, createGitStatusCache, gitStatusCache (~809 tok)
- `volatile.ts` — Build stable volatile block — excludes per-turn dynamic sections, active claims, and git status (laz (~1877 tok)

## src/prompt/__tests__/

- `engine.test.ts` — Declares makeEngine (~1794 tok)
- `fingerprint.test.ts` — Declares SAMPLE_TOOLS (~1599 tok)
- `static.test.ts` — Declares prompt (~748 tok)
- `volatile.test.ts` — VolatileContext: ledger (~2961 tok)

## src/repo/

- `context-bundle.ts` — Exports buildContextBundle (~350 tok)
- `import-graph.ts` — Exports buildImportGraph (~300 tok)
- `symbol-index.ts` — Exports buildSymbolIndex (~400 tok)

## src/repo/__tests__/

- `symbol-index.test.ts` — Declares idx (~250 tok)

## src/server/__tests__/

- `server.test.ts` — ── SseStream ────────────────────────────────────────────── (~1937 tok)

## src/tools/

- `bash.ts` — Exports BASH_TOOL (~1365 tok)
- `default-registry.ts` — Exports createDefaultToolRegistry (~398 tok)
- `delegate-batch.ts` — Zod schemas: taskSchema, inputSchema (~898 tok)
- `delegate-task.ts` — Zod schemas: delegateTaskInputSchema (~1383 tok)
- `diff.ts` — Exports DIFF_TOOL (~1291 tok)
- `edit.ts` — Exports EDIT_FILE_TOOL (~942 tok)
- `git.ts` — Exports GIT_TOOL (~1038 tok)
- `glob.ts` — /*.ts") (~1317 tok)
- `grep.ts` — Exports GREP_TOOL (~2330 tok)
- `output-store.ts` — Exports ToolOutputMeta, persistRawOutput, buildModelOutput, buildUiOutput (~794 tok)
- `path-validate.ts` — Exports ValidatedPath, InvalidPath, PathValidationResult, validatePathSafe, validatePath (~241 tok)
- `process-tracker.ts` — Exports track, killAll, getActiveCount (~322 tok)
- `read-file.ts` — TUI display: head + tail with line numbers, compact for large files. (~1530 tok)
- `recall.ts` — Exports RecallContext, createRecallTool (~720 tok)
- `registry.ts` — Exports ToolRegistry (~304 tok)
- `run-tests.ts` — Exports RUN_TESTS_TOOL (~3052 tok)
- `todo.ts` — Zod schemas: todoItemSchema, todoActionSchema (~880 tok)
- `truncation.ts` — Exports truncateContent (~112 tok)
- `types.ts` — Content sent to model as tool_result (~270 tok)
- `undo.ts` — Exports createUndoTool (~629 tok)
- `web-fetch.ts` — API routes: GET (1 endpoints) (~1266 tok)
- `write-file.ts` — Exports WRITE_FILE_TOOL (~508 tok)

## src/tools/__tests__/

- `default-registry.test.ts` — Default registry: core tools, delegate_task exclusion tests (~1486 tok)
- `delegate-task.test.ts` — Delegate task tool: input validation, coordinator call tests (~2492 tok)
- `diff.test.ts` — makeParams: git (~887 tok)
- `edit.test.ts` — TEST_DIR: makeParams (~832 tok)
- `git.test.ts` — Declares TMP (~802 tok)
- `glob.test.ts` — /*.ts' })) (~1200 tok)
- `grep.test.ts` — Exports helper (~1243 tok)
- `output-store.test.ts` — Declares meta (~1015 tok)
- `path-validate.test.ts` — Declares result (~621 tok)
- `recall.test.ts` — RecallContext: proposal (~1516 tok)
- `registry-filter.test.ts` — filterToolRegistry: allowlist, unknown tool, isolation tests (~1819 tok)
- `run-tests.test.ts` — makeParams: setupProject (~993 tok)
- `todo.test.ts` — Declares result (~596 tok)
- `undo.test.ts` — Declares TMP (~672 tok)
- `web-fetch.test.ts` — Declares result (~783 tok)

## src/tui/

- `agent-status.tsx` — SPINNER_FRAMES (~1461 tok)
- `app.tsx` — THINKING_FLUSH_MS (~9578 tok)
- `assistant-message.tsx` — AssistantMessage (~212 tok)
- `base-text-input.tsx` — Get line/column info from a flat cursor position in a multi-line string (~2889 tok)
- `block-stream-writer.ts` — Exports BlockStreamConfig, BlockStreamWriter (~729 tok)
- `error-boundary.tsx` — Increment to force remount children after error recovery (~267 tok)
- `group-logs.ts` — Exports groupLogs (~332 tok)
- `history-replay.ts` — Exports ReplayResult, replayMessagesToLogEntries (~527 tok)
- `history.ts` — Exports MAX_HISTORY, loadHistory, nextHistoryAfterSubmit, appendHistory (~251 tok)
- `input.tsx` — COMMANDS (~662 tok)
- `log-state.ts` — Exports LogEntryType, LogEntry, createLogEntry, appendLogInPlace + 3 more (~650 tok)
- `phase-tracker.ts` — Exports Phase, LastAction, PhaseTracker (~486 tok)
- `ring-buffer.ts` — Exports RingBuffer, createRingBuffer (~278 tok)
- `slash-commands.ts` — Exports SlashHandlerContext, formatContextClaimsCommand, resolveAppPromptInput, handleSlashCommand (~6774 tok)
- `slash-hint.tsx` — SlashHint (~319 tok)
- `status-bar.tsx` — tokenBar (~1255 tok)
- `stream.tsx` — StreamOutput (~124 tok)
- `summary-bar.tsx` — truncate (~1249 tok)
- `system-message.tsx` — SystemMessage (~137 tok)
- `theme.ts` — Exports RivetTheme, ThemeName, setTheme, getActiveThemeName, getTheme (~887 tok)
- `thinking.tsx` — MAX_THINKING_DISPLAY (~878 tok)
- `tool-card.tsx` — MAX_COLLAPSED_LINES (~485 tok)
- `tool-family.ts` — Exports ToolFamily, ToolFamilyInfo, getToolFamily, getGroupSummary (~570 tok)
- `tool-group.tsx` — ToolGroup (~318 tok)
- `use-terminal-size.ts` — Exports TerminalSizeSnapshot, getTerminalSizeSnapshot, useTerminalSize (~209 tok)
- `user-message.tsx` — UserMessage (~137 tok)

## src/tui/__tests__/

- `assistant-message.test.ts` (~103 tok)
- `base-text-input.test.ts` — Replicate the helper functions from base-text-input.tsx for testing (~1532 tok)
- `group-logs.test.ts` — Declares LogEntry (~1017 tok)
- `history-replay.test.ts` — Declares result (~763 tok)
- `interview.test.ts` — INTERVIEW_MARKER_RE: parseInterviewMarker, clarityColor, clarityTrend, formatTok (~1521 tok)
- `log-state.test.ts` — Declares LogEntry (~1260 tok)
- `phase-tracker.test.ts` — Declares pt (~1177 tok)
- `ring-buffer.test.ts` — Declares buf (~632 tok)
- `slash-commands.test.ts` — SlashHandlerContext: makeCtx (~700 tok)
- `status-bar.test.ts` — contextColor: roundsColor, usageColor, cacheColor, cacheStatusColor (~577 tok)
- `summary-bar.test.ts` — Declares state (~888 tok)
- `system-message.test.ts` (~97 tok)
- `theme.test.ts` — Declares theme (~331 tok)
- `tool-family.test.ts` — Declares f (~495 tok)
- `tool-group.test.ts` (~95 tok)
- `use-terminal-size.test.ts` — Declares first (~113 tok)
- `user-message.test.ts` (~93 tok)

## src/tui/cockpit/

- `context-panel.tsx` — formatClaimCounts (~891 tok)
- `index.ts` — Declares Panel (~138 tok)
- `mcp-panel.tsx` — statusIcon (~484 tok)
- `model-panel.tsx` — ModelPanel (~889 tok)
- `rail.tsx` — statusIndicator (~391 tok)
- `state.ts` — Exports CockpitSnapshotSources, buildCockpitSnapshot (~1752 tok)
- `types.ts` — Exports Panel, PANELS, PANEL_LABELS, CockpitContextLayerView + 5 more (~776 tok)
- `verification-panel.tsx` — statusIcon (~764 tok)

## src/tui/cockpit/__tests__/

- `panels.test.ts` — render: innerFn (~1977 tok)
- `state.test.ts` — makeAgent: makeSession, makeMcpManager (~1162 tok)

## src/types/

- `gradient-string.d.ts` — Gradient: gradient, gradient (~69 tok)
