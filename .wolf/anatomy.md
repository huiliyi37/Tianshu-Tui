# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-15T20:52:09.410Z
> Files: 164 tracked | Anatomy hits: 0 | Misses: 0

## ../../../.claude/projects/-Users-banxia-app-deepseek-tui-opencode-tui/memory/

- `MEMORY.md` — Memory (~101 tok)
- `project_open_model_agent_goal.md` (~234 tok)
- `project_subagent-phase1-validation.md` — 子代理协同 Phase 1 — 自主执行验证记录 (~487 tok)

## ./

- `.gitignore` — Git ignore rules (~23 tok)
- `CLAUDE.md` — Rivet (~255 tok)
- `config.example.toml` — ~/.opencode/config.toml (~232 tok)
- `package-lock.json` — npm lock file (~19981 tok)
- `package.json` — Node.js package manifest (~164 tok)
- `README.md` — Project documentation (~4800 tok)
- `tsconfig.json` — TypeScript configuration (~153 tok)
- `tsup.config.ts` (~65 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .superpowers/brainstorm/

- `2026-05-15-rivet-open-model-terminal-agent-fragments.json` (~1635 tok)
- `2026-05-16-rivet-glanceable-cockpit-techstyle-fragments.json` (~1123 tok)
- `2026-05-16-rivet-subagent-orchestration-fragments.json` — Rivet subagent orchestration brainstorm fragments (~2146 tok)
- `2026-05-16-rivet-subagent-orchestration-fragments.json` (~2146 tok)
- `2026-05-16-rivet-xml-protocol-speculative-engine-fragments.json` (~1213 tok)

## docs/

- `optimization-design-v2.md` — OpenCode TUI 优化增补设计 (~4002 tok)

## docs/analysis/

- `2026-05-15-handoff.md` — Handoff: Rivet v0.1 — 2026-05-15 (updated P2.2) (~2443 tok)

## docs/superpowers/plans/

- `2026-05-15-rivet-p2-2-capability-reliability-layer.md` — Rivet P2.2 Capability Reliability Layer 实现计划 (~14754 tok)
- `2026-05-15-rivet-p2-3-harness-cockpit-implementation.md` — Rivet P2.3 Harness Cockpit TUI 实现计划 (~13437 tok)
- `2026-05-15-rivet-performance-optimization.md` — Rivet 性能优化与 Claude Code 对标实现计划 (~10205 tok)
- `2026-05-16-rivet-glanceable-cockpit-techstyle-implementation.md` — Rivet Glanceable Cockpit + 科技风视觉层 实现计划 (~6867 tok)
- `2026-05-16-rivet-progressive-context-engine-implementation.md` — Rivet Progressive Context Engine 实现计划 (~18102 tok)
- `2026-05-16-rivet-subagent-orchestration-implementation.md` — Rivet 子代理协同 Phase 1 实现计划 (~14921 tok)
- `2026-05-16-rivet-xml-protocol-speculative-engine-implementation.md` — Rivet XML Protocol Layer + Speculative Pre-warming 实现计划 (~5624 tok)

## docs/superpowers/specs/

- `2026-05-15-rivet-open-model-terminal-agent-direction-design.md` — Rivet 开源模型终端代理方向深度头脑风暴结果 (~2338 tok)
- `2026-05-15-rivet-p2-1-performance-dev-capability-optimization.md` — P2.1：Rivet 性能层与开发能力层优化建议 (~2607 tok)
- `2026-05-15-rivet-p2-3-harness-cockpit-design.md` — Rivet P2.3 Harness Cockpit TUI 设计 (~3319 tok)
- `2026-05-15-system-prompt-expansion-design.md` — OpenCode TUI System Prompt 架构优化 (~791 tok)
- `2026-05-16-rivet-glanceable-cockpit-techstyle-design.md` — Rivet Glanceable Cockpit + 科技风视觉层 设计 (~1897 tok)
- `2026-05-16-rivet-progressive-context-engine-design.md` — Rivet Progressive Context Engine 方案设计 (~3845 tok)
- `2026-05-16-rivet-subagent-orchestration-design.md` — Rivet 主控模型子代理协同能力深度头脑风暴结果 (~7664 tok)
- `2026-05-16-rivet-xml-protocol-speculative-engine-design.md` — Rivet XML Protocol Layer + Speculative Pre-warming 设计 (~2060 tok)

## docs/superpowers/validations/

- `2026-05-16-subagent-phase1-validation.md` — 子代理协同 Phase 1 — 自主执行验证报告 (~1377 tok)

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

- `main.tsx` — Read piped stdin (non-TTY only) as initial input (~2700 tok)
- `validation.ts` — Exports isValidSessionId, assertValidSessionId (~78 tok)

## src/agent/

- `adaptive-routing.ts` — 1 second of avgLatencyMs penalizes 0.1 points of passRate in the composite score (~530 tok)
- `aggregation.ts` — Exports aggregateResults (~363 tok)
- `checkpoint.ts` — Create a checkpoint by recording the current HEAD hash and dirty worktree state. (~1577 tok)
- `context.ts` — Replace all messages (used after compaction) (~1512 tok)
- `coordinator-state.ts` — Cumulative event counts — each completed work order increments queued, running, AND its terminal sta (~490 tok)
- `coordinator.ts` — Exports DelegationRequest, CoordinatorRun, WorkerRuntimeFactory, DelegationCoordinatorConfig + 2 mor (~1221 tok)
- `evidence.ts` — Exports EvidenceState, EvidenceTracker (~483 tok)
- `intent-extractor.ts` — Exports IntentType, Intent, extractIntents (~345 tok)
- `loop.ts` — API routes: GET (1 endpoints) (~4111 tok)
- `prewarm.ts` — Exports PrewarmCache (~323 tok)
- `session-persist.ts` — Append a single message to the session file (~893 tok)
- `trace-store.ts` — Exports TraceEventKind, TraceEventStatus, DoomLoopLevel, TraceEvent + 9 more (~718 tok)
- `verification.ts` — Exports VerificationState, emptyVerificationState, addVerificationRun, summarizeVerification + 2 mor (~514 tok)
- `work-order.ts` — Zod schemas: workOrderKindSchema, workerProfileSchema, aggregationPolicySchema, workOrderScopeSchema (~2145 tok)
- `work-queue.ts` — Exports QueueEntry, WorkOrderQueue (~472 tok)
- `worker-prompts.ts` — buildWorkerPrompt, buildWorkerRepairPrompt, buildPrimaryWorkerPacket (~2263 tok)
- `worker-session.ts` — Headless runWorkerSession: independent SessionContext, repair retry loop (~3544 tok)

## src/agent/__tests__/

- `adaptive-routing.test.ts` — Declares router (~703 tok)
- `aggregation.test.ts` — Declares result (~708 tok)
- `checkpoint.test.ts` — makeTempGitRepo: cleanupRepo (~2001 tok)
- `context-ledger-state.test.ts` — Declares makeLedger (~543 tok)
- `coordinator-state.test.ts` — Declares state (~791 tok)
- `coordinator.test.ts` — WorkerRuntimeFactory: fakeTool, makeRegistry, resultFor (~2588 tok)
- `intent-extractor.test.ts` — Declares Intent (~536 tok)
- `loop.test.ts` — Creates a mock client that delivers content blocks and then stops (~2900 tok)
- `prewarm.test.ts` — API routes: GET (9 endpoints) (~443 tok)
- `trace-store.test.ts` — Declares TraceEvent (~604 tok)
- `verification.test.ts` — Declares baseRun (~739 tok)
- `work-order.test.ts` — Declares order (~1254 tok)
- `work-queue.test.ts` — Declares order (~762 tok)
- `worker-prompts.test.ts` — Worker prompt/repair/packet construction tests (~2204 tok)
- `worker-session.test.ts` — Headless worker isolation, repair retry, blocked result tests (~4974 tok)

## src/api/

- `client.ts` — Optional function to normalize usage fields from provider-specific format to standard Usage (~3020 tok)
- `deepseek.ts` — Generic factory: create an ApiClient for any provider described by a (~572 tok)
- `provider.ts` — Describes what a provider supports and how to adapt requests/responses. (~459 tok)
- `sse.ts` — Exports SSEEvent, SSEParser (~602 tok)
- `types.ts` — Exports ContentBlockText, ContentBlockThinking, ContentBlockToolUse, ContentBlockToolResult + 7 more (~552 tok)

## src/api/__tests__/

- `sse.test.ts` — Declares parser (~1419 tok)

## src/compact/

- `auto.ts` — Decide whether automatic compaction should fire. (~1707 tok)
- `constants.ts` — Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+). (~485 tok)
- `index.ts` — Declares CompactionDecision (~104 tok)
- `micro.ts` — MicroCompact: lightweight round-safe truncation without API calls. (~1270 tok)

## src/compact/__tests__/

- `compact.test.ts` — Declares msg (~1646 tok)

## src/config/

- `default.ts` — Exports DEFAULT_CONFIG (~298 tok)
- `schema.ts` — Zod schemas: modelConfigSchema, providerSchema, agentSchema, compactSchema + 2 more (~588 tok)

## src/context/

- `ledger.ts` — Exports createContextLedger (~315 tok)
- `microcompact.ts` — Exports microcompactToolResults, applyMicrocompact (~926 tok)
- `reactive-compact.ts` — Exports ReactiveRoundSelectionOptions, CompactBoundaryInput, selectReactiveCompactRounds, createComp (~384 tok)
- `resume-preflight.ts` — Exports runResumePreflight (~682 tok)
- `rounds.ts` — Exports groupIntoRounds, computeInvariantStatus, getSafeCutIndices (~1703 tok)
- `session-memory.ts` — Exports loadSessionMemory, appendSessionMemory, buildSessionMemoryBlock (~586 tok)
- `token-estimate.ts` (~18 tok)
- `types.ts` — ─── Health & Budget ────────────────────────────────────────── (~1066 tok)

## src/context/__tests__/

- `ledger.test.ts` — userText: assistantText (~440 tok)
- `microcompact.test.ts` — userText: assistantText, assistantWithBlocks, userWithBlocks + 4 more (~1539 tok)
- `resume-preflight.test.ts` — userText: assistantText, assistantWithBlocks, userWithBlocks + 4 more (~1321 tok)
- `rounds.test.ts` — userText: assistantText, assistantWithBlocks, userWithBlocks + 4 more (~2586 tok)
- `session-memory.test.ts` — Declares dir (~701 tok)

## src/failures/

- `sample.ts` — Exports createFailureSample, redactSecrets (~200 tok)

## src/failures/__tests__/

- `sample.test.ts` — Declares sample (~300 tok)

## src/model/

- `capability.ts` — Exports ModelCapabilityCard, recommendModelForTask (~400 tok)

## src/model/__tests__/

- `capability.test.ts` — Declares card (~250 tok)

## src/prompt/

- `engine.ts` — Build a request. Volatile context is injected as an independent user message (~1661 tok)
- `fingerprint.ts` — Exports PrefixFingerprint, DriftEvent, computeFingerprint, detectDrift (~400 tok)
- `static.ts` — Exports StaticPromptContext, buildSystemPrompt (~946 tok)
- `volatile.ts` — Build the volatile `<context>` block injected into the user message. (~960 tok)

## src/prompt/__tests__/

- `engine.test.ts` — Declares makeEngine (~917 tok)
- `fingerprint.test.ts` — Declares SAMPLE_TOOLS (~1599 tok)
- `static.test.ts` — Declares prompt (~748 tok)
- `volatile.test.ts` — VolatileContext: ledger (~1221 tok)

## src/repo/

- `context-bundle.ts` — Exports buildContextBundle (~350 tok)
- `import-graph.ts` — Exports buildImportGraph (~300 tok)
- `symbol-index.ts` — Exports buildSymbolIndex (~400 tok)

## src/repo/__tests__/

- `symbol-index.test.ts` — Declares idx (~250 tok)

## src/tools/

- `bash.ts` — Exports BASH_TOOL (~1107 tok)
- `default-registry.ts` — createDefaultToolRegistry: 8 core tools factory (~893 tok)
- `delegate-task.ts` — createDelegateTaskTool: Phase 1 read-only worker delegation tool (~2416 tok)
- `diff.ts` — Exports DIFF_TOOL (~1291 tok)
- `edit.ts` — Exports EDIT_FILE_TOOL (~942 tok)
- `glob.ts` — /*.ts") (~1317 tok)
- `grep.ts` — Exports GREP_TOOL (~2330 tok)
- `output-store.ts` — Exports ToolOutputMeta, persistRawOutput, buildModelOutput, buildUiOutput (~794 tok)
- `path-validate.ts` — Exports ValidatedPath, InvalidPath, PathValidationResult, validatePathSafe, validatePath (~241 tok)
- `read-file.ts` — Exports READ_FILE_TOOL (~654 tok)
- `registry.ts` — Exports ToolRegistry (~304 tok)
- `run-tests.ts` — Exports RUN_TESTS_TOOL (~3052 tok)
- `truncation.ts` — Exports truncateContent (~112 tok)
- `types.ts` — Content sent to model as tool_result (~270 tok)
- `write-file.ts` — Exports WRITE_FILE_TOOL (~508 tok)

## src/tools/__tests__/

- `default-registry.test.ts` — Default registry: core tools, delegate_task exclusion tests (~1486 tok)
- `delegate-task.test.ts` — Delegate task tool: input validation, coordinator call tests (~2492 tok)
- `diff.test.ts` — makeParams: git (~887 tok)
- `edit.test.ts` — TEST_DIR: makeParams (~832 tok)
- `glob.test.ts` — /*.ts' })) (~1200 tok)
- `grep.test.ts` — Exports helper (~1243 tok)
- `output-store.test.ts` — Declares meta (~1015 tok)
- `path-validate.test.ts` — Declares result (~621 tok)
- `registry-filter.test.ts` — filterToolRegistry: allowlist, unknown tool, isolation tests (~1819 tok)
- `run-tests.test.ts` — makeParams: setupProject (~993 tok)

## src/tui/

- `agent-status.tsx` — MAX_VISIBLE_ITEMS (~1232 tok)
- `app.tsx` — STREAM_FLUSH_MS (~8541 tok)
- `base-text-input.tsx` — BaseTextInput — uses useState, useEffect, useCallback (~934 tok)
- `history.ts` — Persistent TUI prompt history load/append helpers (~203 tok)
- `input.tsx` — InputBar — uses useState (~208 tok)
- `log-state.ts` — Exports LogEntry, createLogEntry, appendLogInPlace, visibleLogs + 2 more (~586 tok)
- `phase-tracker.ts` — Exports Phase, LastAction, PhaseTracker (~369 tok)
- `status-bar.tsx` — tokenBar (~586 tok)
- `stream.tsx` — StreamOutput (~105 tok)
- `summary-bar.tsx` — truncate (~1240 tok)
- `theme.ts` — Exports RivetTheme, getTheme (~456 tok)
- `thinking.tsx` — ThinkingCollapser — uses useState (~242 tok)
- `tool-card.tsx` — MAX_COLLAPSED_LINES (~456 tok)
- `use-terminal-size.ts` — Exports TerminalSizeSnapshot, getTerminalSizeSnapshot, useTerminalSize (~209 tok)

## src/tui/__tests__/

- `log-state.test.ts` — Declares LogEntry (~803 tok)
- `phase-tracker.test.ts` — Declares pt (~750 tok)
- `status-bar.test.ts` — contextColor: roundsColor, usageColor, cacheColor (~436 tok)
- `summary-bar.test.ts` — Declares state (~888 tok)
- `theme.test.ts` — Declares theme (~331 tok)
- `use-terminal-size.test.ts` — Declares first (~113 tok)

## src/types/

- `gradient-string.d.ts` — Gradient: gradient, gradient (~69 tok)
