# Rivet Codebase Index

> Wave 12 · 182 source files · 926 tests · 14 modules

## Entry

`src/main.tsx` → CLI args → config → tools → prompt engine → AgentLoop → Ink TUI

## Modules

### api/ (7 files) — Streaming client + provider abstraction

| File | Lines | Key Exports |
|------|-------|-------------|
| types.ts | 79 | ContentBlock, Message, Usage, MessageRequest, StreamEvent |
| client.ts | 395 | ApiClient (SSE streaming, retry 3x, truncated JSON recovery, schema gate, DeepSeek tool-json bug workaround) |
| sse.ts | 76 | SSEParser (incremental SSE event parsing) |
| deepseek.ts | 58 | createDeepSeekClient, mapDeepSeekUsage |
| provider.ts | 41 | ProviderCapabilities, DEEPSEEK_CAPABILITIES, DEFAULT_CAPABILITIES |
| provider-profile.ts | 24 | getProviderProfile (cache type per provider) |
| cache-strategy.ts | 26 | applyCacheStrategy (exact-prefix / explicit-breakpoint / partial-prefix / block-kv) |

### agent/ (32 files) — Agent loop, session, delegation

| File | Lines | Key Exports |
|------|-------|-------------|
| loop.ts | 547 | AgentLoop: compact → ceiling → claims → stream → tools → turn end → snapshot |
| context.ts | 220 | SessionContext: messages, usage, turn count, file tracking, cache history |
| session-persist.ts | 227 | SessionPersist (JSONL append + turn snapshots + LRU eviction 50) |
| tool-pipeline.ts | 359 | executeToolUse (pre-hooks → repair → approval → checkpoint → harness → post-hooks) |
| turn-end.ts | 76 | processTurnEnd (task state, mirror detection, routing, decisions) |
| turn-harness.ts | 100 | TurnHarness (retry 2x + trajectory recording) |
| coordinator.ts | ~200 | DelegationCoordinator (budget gate, model routing, batch dispatch) |
| coordinator-state.ts | ~80 | WorkerEvent tracking + failure budget |
| work-order.ts | 235 | WorkOrder, WorkerResult + zod schemas |
| work-queue.ts | ~60 | Priority queue with dedupe + dependency blocking |
| worker-session.ts | ~150 | Headless worker with independent context |
| worker-prompts.ts | ~60 | Decomposition + result-aggregation prompts |
| adaptive-routing.ts | 65 | AdaptiveRouter (per-profile per-model scoring) |
| aggregation.ts | 43 | aggregateResults (4 policies) |
| prewarm.ts / prewarm-file.ts | 32+32 | Speculative cache pre-warming via intent extraction |
| checkpoint.ts | 237 | Git checkpoint + rollback v2 (agent-owned files only) |
| file-history.ts | 207 | Per-file snapshot backup + rewind |
| session-fork.ts | 29 | Session fork by line count |
| approval-risk.ts | 130 | assessToolRisk (doom loop, path traversal, destructive) |
| repair-pipeline.ts | ~30 | RepairPipeline with pluggable passes |
| repair-passes.ts | ~40 | fourHorsemenPass, semanticRepairPass |
| repair-hint.ts | ~30 | RepairHintTracker |
| strategy-shift.ts | ~40 | Doom-loop strategy suggestion (4 pattern detectors) |
| behavior-mirror.ts | ~40 | Detect repetitive tool patterns |
| decision-anchor.ts | ~30 | Anchor decisions to trajectory entries |
| evidence.ts | ~60 | File tracking + test result badge + impacted files |
| impact-hint.ts | ~30 | Edit impact analysis |
| import-graph.ts | ~60 | Static import graph + reverse deps |
| task-state.ts | ~30 | Task progress extraction from trajectory |
| execution-guidance.ts | ~40 | Execution guidance from model output |
| delivery-gate.ts | ~30 | Block unverified changes from delivery |
| failure-classifier.ts | ~40 | Test failure categorization |
| verification.ts | ~40 | VerificationState tracking |

### context/ (17 files) — Evolutionary Context Fabric (ECF)

| File | Lines | Key Exports |
|------|-------|-------------|
| types.ts | 161 | ContextLedger, CompactEvent, ContextAnchor, SessionMemoryState, all context types |
| claim-store.ts | 274 | ContextClaimStore: propose/promote/evict claims with fitness/antibody/budget |
| claims.ts | 190 | ContextClaim types, claimProposalFromAnchor, durable claims |
| ledger.ts | 28 | createContextLedger (token budget, API invariant, layer report) |
| rounds.ts | 210 | groupIntoRounds, computeInvariantStatus, getSafeCutIndices |
| compact-policy.ts | 45 | decideCompactTier, recordCompactFailure/Success, tierForRatio |
| anchor-registry.ts | ~60 | AnchorRegistry: user message → context anchors |
| antibody.ts | 33 | createAntibodyProposal (failure → defensive claim) |
| conflict-detect.ts | 44 | detectConflicts between claims |
| claim-budget.ts | 16 | selectEvictionCandidates (MAX_ACTIVE_CLAIMS=50) |
| promotion.ts | 46 | evaluatePromotion, claimHasFileEvidence, countClaimsByStatus |
| claim-extractor.ts | ~40 | Extract claims from tool results |
| claim-export.ts | ~30 | Export/import claims |
| session-memory.ts | ~40 | Per-session memory entries |
| rules-loader.ts | ~30 | Load project-level rules |
| resume-preflight.ts | ~30 | Pre-flight checks for session resume |
| pressure-monitor.ts | ~20 | Context pressure monitoring |

### tui/ (32 files) — Terminal UI (Ink 6 + React)

| File | Lines | Key Exports |
|------|-------|-------------|
| app.tsx | 591 | App component: BlockStreamWriter, PromptQueue, HistoryReplayBridge, cockpit |
| block-stream-writer.ts | 88 | BlockStreamWriter (sync enqueue, 300-800 char semantic breaks, idle 1200ms) |
| history-replay.ts | 49 | replayMessagesToLogEntries (Message[] → LogEntry[]) |
| slash-commands.ts | 500 | All slash command handlers |
| markdown-render.tsx | 397 | Markdown parser + Ink renderer (inline/block, syntax highlight) |
| diff-render.tsx | ~80 | Unified diff detection + colorized rendering |
| cockpit/ | 10 files | Multi-panel dashboard (trace, verify, context, safety, model, MCP) |
| input.tsx | ~80 | Input bar with cursor, history, Ctrl+A/E/W/U |
| base-text-input.tsx | 160 | Full-featured text input with history nav |
| status-bar.tsx | ~60 | Model, cache hit rate, cost, token bar |
| summary-bar.tsx | ~80 | Live 3-line cockpit: phase, context%, risk |
| agent-status.tsx | 153 | Tool call progress display |
| tool-card.tsx | ~60 | Tool execution display with theme borders |
| theme.ts | ~80 | Truecolor/fallback color palette |
| log-state.ts | ~40 | LogEntry types, createLogEntry, summarizeToolOutput |
| command-palette.tsx | ~60 | Ctrl+K command palette |
| pager.tsx | ~80 | Interactive scroll pager (/scroll) |
| onboarding.tsx | ~40 | First-run onboarding panel |

### tools/ (21 files) — Tool implementations

| File | Lines | Tool Name |
|------|-------|-----------|
| bash.ts | 134 | bash — shell command execution |
| read-file.ts | 144 | read_file — file reading with line range |
| write-file.ts | 53 | write_file — file creation |
| edit.ts | 83 | edit_file — search/replace editing |
| git.ts | 140 | git — git operations |
| glob.ts | 175 | glob — file pattern matching |
| grep.ts | 270 | grep — content search (regex + literal) |
| run-tests.ts | 325 | run_tests — test runner with result parsing |
| inspect-project.ts | 299 | inspect_project — project structure analysis |
| repo-map.ts | 193 | repo_map — repository map generation |
| delegate-task.ts | 115 | delegate_task — sub-agent delegation |
| delegate-batch.ts | 75 | delegate_batch — batch delegation |
| undo.ts | 59 | undo — file rollback |
| web-fetch.ts | 182 | web_fetch — URL fetching (SSRF-safe) |
| todo.ts | ~40 | todo — task tracking |
| recall.ts | 67 | recall — context claim recall |
| diff.ts | ~30 | diff — diff viewing |
| gitignore.ts | ~20 | gitignore — gitignore patterns |
| related-tests.ts | ~30 | related_tests — find tests for file |
| registry.ts | 52 | ToolRegistry class |
| default-registry.ts | 36 | createDefaultToolRegistry |

### prompt/ (6 files) — System prompt assembly

| File | Lines | Key Exports |
|------|-------|-------------|
| engine.ts | 214 | PromptEngine: buildRequest, cache fingerprint, active claims |
| fingerprint.ts | 67 | computeFingerprint, checkDrift |
| cache-diagnostic.ts | 86 | diagnoseCacheMiss |
| context-layer.ts | 87 | ContextLayer types, buildContextLayers |
| volatile.ts | 168 | ToolHistoryEntry, VolatileStore |
| static.ts | 85 | Static prompt sections |

### compact/ (4 files) — Context compaction

| File | Lines | Key Exports |
|------|-------|-------------|
| micro.ts | 116 | estimateTokens, estimateMessageTokens, microCompact |
| auto.ts | 181 | shouldAutoCompact, buildSummaryPrompt, smartCompact |
| constants.ts | 65 | AUTO_COMPACT_THRESHOLD, CACHE_ANCHOR_MESSAGES, KEEP_RECENT_MESSAGES |
| index.ts | 15 | Re-exports |

### config/ (3 files)

| File | Lines | Key Exports |
|------|-------|-------------|
| schema.ts | 83 | configSchema (Zod) |
| default.ts | 60 | DEFAULT_CONFIG |
| manager.ts | 334 | runConfigCLI |

### mcp/ (6 files) — Model Context Protocol client

| File | Lines | Key |
|------|-------|-----|
| manager.ts | 152 | McpManager: server lifecycle, tool discovery |
| wrapper.ts | 85 | wrapMcpTool (MCP tool → Rivet Tool) |
| config.ts | 29 | loadMcpConfig |
| types.ts | 9 | McpServerConfig |
| policy.ts | 63 | tool approval policy |
| failure-classifier.ts | 35 | MCP failure classification |

### lsp/ (3 files) — Language Server Protocol client

| File | Lines | Key |
|------|-------|-----|
| rpc.ts | 133 | JSON-RPC message encode/decode + request/response matching |
| manager.ts | 192 | LspManager: typescript-language-server lifecycle, goto-def, find-refs |
| tools.ts | 137 | lsp_goto_definition + lsp_find_references tools |

### model/ (3 files)

| File | Lines | Key |
|------|-------|-----|
| capability.ts | 32 | ModelCapabilityCard, recommendModelForTask |
| routing-metrics.ts | 38 | RoutingMetricsCollector |
| task-inferrer.ts | 43 | inferTaskCapabilities |

### hooks/ (2 files)

| File | Lines | Key |
|------|-------|-----|
| types.ts | 65 | HookEvent, HookHandler, HookRegistry types |
| registry.ts | 122 | HookRegistry (PreToolUse/PostToolUse/Notification/SubagentStop) |

### server/ (4 files) — HTTP API server

| File | Lines | Key |
|------|-------|-----|
| index.ts | 41 | createServer |
| routes.ts | 30 | Route handlers |
| sse-stream.ts | 23 | SSE stream helper |
| prompt-route.ts | 56 | Prompt submission route |

### Root files

| File | Lines | Purpose |
|------|-------|---------|
| main.tsx | 575 | Entry: CLI → config → agent → TUI |
| headless.ts | 115 | Headless mode (-p/--print, --goal); goal autonomy reuses agent/goal-tracker.ts |
| onboarding.ts | 25 | First-run state |
| validation.ts | 9 | assertValidSessionId |

## Data Flow

```
User Input → App.handleSubmit → PromptQueue → AgentLoop.run()
  → compact if needed → enforceContextCeiling → refreshActiveClaims
  → PromptEngine.buildRequest → ApiClient.stream (SSE)
  → onTextDelta → BlockStreamWriter → setStreamingText
  → onToolUse → executeToolUse (pipeline)
  → onTurnComplete → recordTurnSnapshot → SessionPersist
```

## Key Design Decisions

1. **BlockStreamWriter sync enqueue** — React setState is synchronous; async .then() causes data loss on fire-and-forget flush
2. **JSONL append-only + turn snapshots** — Crash recovery without full event sourcing
3. **Agent loop ceiling enforcement** — 95% context window triggers checkpoint-resume
4. **ECF claim lifecycle** — propose → promote → active → stale/evicted, with fitness/antibody/conflict/budget
5. **Tool pipeline extraction** — loop.ts delegates to tool-pipeline.ts + turn-end.ts (815→493L)
