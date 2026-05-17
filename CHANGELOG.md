# Changelog

## 2026-05-17 — Multi-Provider Adapter (Codex OAuth + MiniMax + MiMo)

### Added
- **Auth module (`src/auth/`)**: AuthProvider interface with ApiKeyAuth and OAuthAuth implementations. OAuthAuth supports full PKCE flow with local callback server (localhost:1455), device flow for headless environments, automatic token refresh (55 min), and atomic token persistence to `~/.rivet/auth/{provider}.json`.
- **CodexClient (`src/api/codex-client.ts`)**: Dedicated client for OpenAI Codex Responses API (`/v1/responses` via `chatgpt.com/backend-api/codex`). Handles the Codex-specific SSE event format (`response.output_item.done` with complete items instead of streaming deltas), extracts text from `output_text` content blocks, reasoning from `summary` items, and function calls.
- **Provider capabilities**: WELL_KNOWN_DEFAULTS for minimax, mimo, opencode-go with thinking support and OpenAI protocol.
- **CLI arguments**: `--provider <name>` and `--model <id>` for selecting provider/model at startup.
- **Worker routing**: Config-driven `workers.profiles` and `workers.routing` in `~/.rivet/config.json` maps CapabilityTask types (code_edit, repo_summarization, etc.) to named worker profiles (capable, cheap, mid) backed by different providers. DelegationCoordinator selects model per-task at runtime.
- **Config schema**: `auth` field on provider (api-key or oauth), `workers` section with profiles and routing.

### Architecture
- **Codex OAuth flow**: `chatgpt.com/backend-api/codex/responses` endpoint (NOT `api.openai.com/v1`). Uses ChatGPT subscription quota, not API quota. Requires `instructions` top-level field, strips unsupported params (max_output_tokens, temperature). Headers: `User-Agent: codex_cli_rs/...`, `Originator: codex_cli_rs`.
- **Provider/protocol/auth orthogonal separation**: Protocol layer (Anthropic/OpenAI/Codex) is independent from auth layer (API key/OAuth). Worker routing operates at a third layer (task type → provider mapping).

### Validated
- 1248 tests passing, typecheck clean, build success
- Codex OAuth login tested end-to-end with ChatGPT Plus account
- Config schema parses all 6 providers with worker routing

---

## 2026-05-17 — Activity Status Layer

### Added
- Activity Status Layer for long Rivet turns: thinking duration/final duration, stale/no-update display, tool/MCP wait labels, conservative large-result analysis status, and low-frequency (1 Hz) projection to existing TUI surfaces.

### Validation
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

---

## 2026-05-17 — Session HA Closure

### Completed
- Merged the Session HA closure work into `main` after resolving the newer cerebellar/thinking helper changes already present on `main`.
- Documented the operational guarantee: interrupted sessions should recover, preserve visible partial work, bound long-running operations, and avoid unbounded live render state.
- Verified the merged result with `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.

### Fixed
- Restore path now repairs interrupted tool transcripts and rolls back to the last valid turn snapshot when needed.
- Stream errors persist partial assistant output before surfacing the error.
- Bash timeouts terminate the process tree instead of only the shell child.
- MCP servers time out hung connect/listTools/callTool operations and expose degraded state.
- Smart compaction rejects empty, oversized, or unsafe summaries and falls back to micro compaction.
- Volatile prompt repair and memory blocks escape untrusted content.
- Live TUI stream rendering keeps a bounded tail window to avoid unbounded React state growth.
- Cerebellar prediction-error and ThinkingCollapser edge cases have focused regression coverage.

## 2026-05-17 — Wave 12: Session High Availability

### Added — BlockStreamWriter
- **Semantic break-point streaming** replaces fixed 80ms setTimeout flush
- Respects paragraph (\n\n) > newline (\n) > space boundaries within configurable char thresholds (min 300, max 800)
- Idle timeout (1200ms) force-flushes remaining buffer
- Ordered block emission via serialized enqueue

### Added — TurnSnapshot
- Turn-level JSONL snapshots appended on every turn completion for crash recovery
- `loadLastSnapshot()` reads last valid snapshot, skipping corrupted lines
- `loadUpToTurn(n)` loads messages up to a specific turn for targeted recovery

### Added — HistoryReplayBridge
- `replayMessagesToLogEntries()` converts persisted Message[] into visual LogEntry[]
- Restored sessions render through full pipeline (tool cards, structured output, error flags)
- Session restore now shows turn count + tool count instead of raw message count

### Added — PromptQueue
- Promise chain serialization prevents concurrent `handleSubmit` race conditions
- Error recovery: catch guarantees `setIsStreaming(false)` to restore UI state

### Added — SessionEviction
- Automatic LRU eviction caps sessions at 50 (oldest removed first)
- Cleans all related files (.jsonl, .meta.json, .snapshots.jsonl, .memory.json, .claims.jsonl)
- Runs on every new session creation

### Inspired By
- Qwen Code: BlockStreamer (semantic streaming), Session snapshots, HistoryReplayer
- OpenCode: session-cache (LRU eviction), terminal-writer (batch scheduling)

---

## 2026-05-17 — Wave 9/10 + ECF Phase 5

### Fixed — Wave 9 Defect Fixes
- **createAgentConfig factory** — Extracted shared config factory eliminating TUI/goal-loop duplication
- **Goal loop parity** — Added `compactClient`, `fileHistory`, `getSessionMemoryState`, `maxWorkers=3` to goal loop
- **loadDurableClaims replay** — `claim_used` events now restore consumers + `lastUsedAt` on durable claims
- **FileHistory path** — Uses `SessionPersist.getBackupDir()` instead of hardcoded path
- **loadProjectRules** — Added try/catch for filesystem errors
- **server tests** — 17 tests covering all 4 server modules (SseStream, createRouter, createRoutes, buildPromptHandler)

### Refactored — Wave 10 Loop Split
- **tool-pipeline.ts** (343L) — Extracted single tool execution: pre-hooks → repair → approval → checkpoint → harness → post-hooks → claim extraction → antibody → evidence → import graph → prewarm
- **turn-end.ts** (76L) — Extracted turn-end processing: task state → mirror detection → model routing → decision extraction → evidence badge
- **loop.ts** — 815→493 lines, delegates to tool-pipeline + turn-end

### Added — Test Coverage (Wave 10)
- compact/auto.ts — 8 tests (shouldAutoCompact + buildSummaryPrompt)
- compact/micro.ts — 7 tests (estimateTokens + microCompact)
- session-persist.ts — 5 tests with env-overridable `RIVET_SESSION_DIR`
- tool-pipeline.ts — 4 tests
- turn-end.ts — 5 tests

### Added — ECF Phase 5: Recall Positive Feedback
- **boostFitness** — `ContextClaimStore.boostFitness(id, delta, cap)` increases claim fitness, capped at max
- **claim_boosted event** — New event type in JSONL for fitness changes; replayed by `loadDurableClaims`
- **Recall consumer tracking** — recall tool records `recall:turn-N` consumer on each matched claim
- **Recall fitness boost** — recall hits boost matched claim fitness by +1 (cap 10), improving prompt projection rank and eviction resistance
- **RecallContext** — `createRecallTool(store, ctx)` accepts optional context for consumer/fitness tracking

### Fixed
- **tool-pipeline** — `run_tests` diagnosis early return now records `repairHintTracker.recordFailure` before returning

## 2026-05-16 — Wave 8 + Evolutionary Context Fabric Phase 2–4B

### Added — Wave 8 Context Fabric Phase 2
- **Claim Extractor** (`src/context/claim-extractor.ts`) — Automatic claim extraction from tool results:
  - `read_file` → `file_observation` claim (30min TTL, deduplicated by path)
  - `run_tests` failure → `failure_pattern` claim (2h TTL)
  - `run_tests` success → `verification_fact` claim (1h TTL)
  - `bash` security output → `security_finding` claim (4h TTL, requires isError)
  - Skip list: grep, glob, diff, inspect_project, repo_map, related_tests, recall (too noisy)
- **AgentLoop wiring** — Claim extraction runs after every tool result; `promoteEligibleClaims()` in `refreshActiveClaims()`
- **Durable promotion** — `durable_candidate → durable` after 5 unique consumers + 10 minutes age (was only `active → durable_candidate`)
- **Cross-session durable claims** — `ContextClaimStore.loadDurableClaims()` static method reads durable claims from previous session JSONL; `SessionPersist.injectDurableClaims()` injects with 0.9 confidence decay on startup/resume
- **Claim budget cap** — `MAX_PROMPT_CLAIMS=20` caps `renderActiveClaimsBlock()` output, sorted by fitness descending

### Added — Evolutionary Context Fabric Phase 2
- **Claim lifecycle** — `markClaimsStaleForFile()` marks file-evidence claims stale on write; `promoteEligibleClaims()` batch promotion; `getStatusCounts()` status histogram
- **Consumer deduplication** — `evaluatePromotion` gates use unique consumer IDs (prevents inflation from repeated `recordClaimUsed`)

### Added — Evolutionary Context Fabric Phase 3
- **Antibody generation** (`src/context/antibody.ts`) — `createAntibodyProposal()` converts `ClassifiedFailure` into `failure_pattern` ClaimProposal; retryable failures get fitness=2, non-retryable get fitness=5; 4-hour TTL
- **Conflict detection** (`src/context/conflict-detect.ts`) — `detectConflicts()` finds contradictory file-evidence claims on same path; excludes semantically identical text; marks older claim as `conflicted`
- **AgentLoop antibody wiring** — Tool error → `classifyFailure` → `createAntibodyProposal` → `claimStore.propose()` for all classifiable (non-unknown) failures
- **AgentLoop conflict wiring** — After new `file_observation` proposals, `detectConflicts()` marks older same-path claims `conflicted`; guarded by `lastConflictCheckCount` to skip when no new claims
- **Approval-risk antibody boost** — `assessToolRisk()` accepts optional 4th param `antibodies: ContextClaim[]`; when antibody evidence mentions the same tool name, risk bumps from `none` to `low`
- **Worker finding evidence** — `delegate_task` claim proposals include `evidence[0].path` from `changedFiles[0]`; confidence mapped: high→0.85, medium→0.7, low→0.55
- **TUI slash commands** — `/context antibodies` lists active failure_pattern claims; `/context conflicts` lists conflicted claims
- **File observation dedup** — `extractClaimsFromToolResult` accepts `existingFileObservations` set; same file path → skip duplicate claim

### Added — Evolutionary Context Fabric Phase 4
- **Project rules loader** (`src/context/rules-loader.ts`) — `.rivet/rules/*.md` loaded as `project_rule` claims (scope=project, status=durable, confidence=1.0, fitness=10); 500-char truncation; fixed sessionId='project' for cross-session dedup
- **Claim budget cap** (`src/context/claim-budget.ts`) — `MAX_ACTIVE_CLAIMS=50`; `selectEvictionCandidates()` evicts lowest fitness→confidence→lastUsedAt; `project_rule`/`user_constraint`/`user_preference` exempt
- **Budget eviction in AgentLoop** — `refreshActiveClaims()` marks excess low-value claims stale before projection
- **/context reload** — Hot-reload project rules from `.rivet/rules/` at runtime
- **Goal loop rules** — Autonomous `--goal` mode also loads project rules on startup

### Added — Evolutionary Context Fabric Phase 4B
- **Recall tool rewrite** (`src/tools/recall.ts`) — Searches claim store by keyword (substring match), kind filter, limit param; replaces old PersistentStore-based recall
- **Claim export/import** (`src/context/claim-export.ts`) — `exportDurableClaims()` writes durable claims to JSON; `importClaims()` reads with 0.8x confidence decay and 'imported' tag
- **/context export** — Exports durable claims to `~/.rivet/exports/<timestamp>.json`
- **/context import** — Imports claims from JSON file with confidence decay

### Removed
- **PersistentStore** (`src/context/persistent-store.ts`) — Dead code; recall tool now uses ContextClaimStore
- `src/context/promotion.ts` — `evaluatePromotion()` now handles both `active → durable_candidate` and `durable_candidate → durable`
- `src/agent/session-persist.ts` — Added `loadPreviousDurableClaims()` and `injectDurableClaims()` methods
- `src/agent/loop.ts` — Wired antibody generation, conflict detection, file observation dedup, and antibody injection into `assessToolRisk`
- `src/agent/approval-risk.ts` — `assessToolRisk()` signature extended with optional `antibodies` parameter (backward-compatible default `[]`)
- `src/tools/delegate-task.ts` — Worker finding claims include file evidence path and confidence-based fitness
- `src/context/claim-store.ts` — Added `loadDurableClaims()` static method; incremental projection from previous session

### Fixed
- **DRY violation** — Duplicated durable claim injection in main.tsx extracted to `SessionPersist.injectDurableClaims()`
- **Duplicate promotion call** — Removed duplicate `promoteEligibleClaims()` at turn end; single call in `refreshActiveClaims()`
- **Lazy conflict detection** — `detectConflicts()` only runs when new `file_observation` proposals appear and claim count changed
- **Conflict text dedup** — Claims with identical normalized text no longer flagged as conflicts (e.g. repeated reads of same file)
- **Security finding false positives** — `bash` + security keywords now requires `isError: true`; clean `npm audit` output skipped
- **Enriched file_observation text** — Claims now include extracted export/function/class names (up to 8 symbols), e.g. `config.ts (42L): MAX_RETRIES, TIMEOUT, loadConfig`
- **Antibody TTL** — Antibody claims expire after 4 hours; previously never expired

### Verified
- 831 tests pass, 0 fail
- npm run typecheck clean
- All 8 ECF Phase 3 acceptance criteria verified

## 2026-05-16 — Wave 5 Trust Infrastructure + Wave 6 Goal Loop + Wave 7 Sub-Agent Wiring

### Added — Wave 5 Trust Infrastructure
- **Tool activation** — Registered inspect_project, repo_map, related_tests, undo tools; autoReasoning + lspEnabled wired into AgentLoop
- **Per-call undo** — FileHistory persistence with ring-buffer GC (50 snapshots max); `/undo` slash command for selective rewind
- **Context visibility** — `/context pin <text>` for manual anchor pinning; pinned anchors displayed in `/context` output
- **AgentLoop public API** — `addAnchor()`, `getLedger()`, `getFileHistory()` methods for TUI access
- **createContextLedger** accepts extraAnchors for user-pinned anchors

### Added — Wave 6 Goal Loop
- **`--goal` CLI flag** — `rivet --goal "text" [--budget N]` launches autonomous goal loop
- **Goal loop core** — Budget-capped iteration (default 100); 3-strike circuit breaker on consecutive API errors
- **Exit condition** — `checkGoalAchieved` with merged text + tool_result context
- **NDJSON streaming** — `--stream-json` outputs `goal_iteration` + `goal_complete` events
- **Tool errors vs API errors** — Tool-level errors don't trigger circuit breaker; only API errors count

### Added — Wave 7 Sub-Agent Wiring
- **delegate_task kind/profile** — Tool schema exposes optional `kind` and `profile` params; `isConcurrencySafe: true`
- **Profile-based tool selection** — `patcher`/`verifier` profiles get `WRITE_WORKER_TOOLS` (edit_file, write_file, bash, run_tests)
- **Failure escalation** — `CoordinatorState.shouldEscalate()` triggers after 3 consecutive non-passed events
- **Worker findings → claims** — `worker_finding` claims extracted from worker results into `ContextClaimStore`
- **Worker inherits active claims** — `WorkerSessionConfig.activeClaims` injected via `PromptEngine.updateActiveClaims()`
- **Goal loop + coordinator** — Goal loop `createAgent` creates `DelegationCoordinator` and registers `delegate_task`
- **delegate_batch tool** — Parallel worker execution (max 5 tasks) with configurable aggregation policy
- **maxWorkers=3** — Write profiles get `maxTurns=8` and larger token budget (8192)

### Verified
- 755+ tests pass
- npm run typecheck clean (0 errors)
- All 7 stories per wave verified (21 total)

## 2026-05-16 — Wave 2 Differentiation + Wave 3 UX Polish + Wave 4 Ecosystem Extension

### Added — Wave 2 Differentiation
- **Session forking** — `/fork` copies current session JSONL to new UUID for exploration branches
- **Approval edit** — `ApprovalResult` type with `editedInput`; AgentLoop backward-compatible
- **Auto reasoning** — Keyword-based effort selection (off/medium/high/max), opt-in via config
- **LSP diagnostics** — tsc output parser + PostToolUse hook for TS/JS file edits
- **HTTP/SSE Runtime API** — Router, SSE stream, GET /status, POST /abort, `rivet serve`

### Added — Wave 3 UX Polish
- **Vim keybindings** — normal/insert/visual state machine; h/l/w/b/0/$/dd/x motions; `/vim` toggle
- **@file autocomplete** — extractAtToken + getCompletions via git ls-files; Tab selection
- **Command palette** — Ctrl-K overlay; fuzzy filterCommands; 18 slash commands
- **External editor** — Ctrl-O spawns $VISUAL/$EDITOR; createTempFile + readAndCleanup
- **Git worktree isolation** — createWorktree/removeWorktree/listWorktrees; `--worktree` CLI

### Added — Wave 4 Ecosystem Extension
- **Streaming JSON** — `--stream-json` NDJSON events (text_delta, tool_use, tool_result, turn_complete)
- **POST /prompt SSE** — Prompt validation + SSE streaming via SseStream in rivet serve
- **Composable CLI** — Stdin pipe detection + auto-JSON for non-TTY stdout

### Verified
- 855 tests pass
- npm run typecheck clean
- 34 capabilities Verified (capability ledger)

## 2026-05-16 — Adaptive Context Fabric (ACF) Phase 1–4

### Added

**Phase 1 — Zero-Overflow Safety Layer:**
- `compactThresholds(contextWindow)` percentage-based thresholds scaling 8K to 1M windows — auto (80%), floor (60%), tool_result max (30%)
- Compaction policy (`src/context/compact-policy.ts`) as sole compact decision source — removed legacy double-AND gate with `shouldAutoCompact`
- Window-relative single `tool_result` size limit applied before early return in microCompact
- `AgentLoop.enforceContextCeiling()` last-resort 95% ceiling with cache-anchor + checkpoint-resume fallback
- Tier 4 reason updated: "emergency truncation required" → "context ceiling exceeded; checkpoint-resume required"

**Phase 2 — Structural Anchors + Cold Storage:**
- `PressureMonitor` PSI-style pressure/thrashing detection — tier, shouldCompact, thrashing (3+ compactions in 4-turn window), task_decomposition suggestion
- `AnchorRegistry` pinned structural anchors for user constraints (regex-based extraction) and decisions, with salience scoring, token budget enforcement, and low-salience eviction
- `PersistentStore` SHA-256 indexed cold storage — archive/retrieve/search with disk limit enforcement (oldest-first eviction)
- `ContextAnchor` extended with `user_constraint` kind

**Phase 3 — Provider-Aware Message Assembly:**
- `ProviderProfile` 6-provider cache profiles (deepseek exact-prefix, anthropic explicit-breakpoint, openai partial-prefix, google/qwen explicit-breakpoint, vllm block-kv)
- `CacheStrategy` provider-aware message assembly — injects `cache_control: { type: 'ephemeral' }` for explicit-breakpoint providers at anchor boundary
- `Message` type extended with optional `cache_control` field

**Phase 4 — Recall + Proactive Injection:**
- `recall` tool — retrieves archived tool results from PersistentStore by keyword/toolName/since/filter
- `buildProactiveContext()` — builds `<active-constraints>` XML block from anchors sorted by salience with token budget

### Changed

- `src/compact/constants.ts` — added `CompactThresholds` interface and `compactThresholds()` function; legacy `AUTO_COMPACT_THRESHOLD`/`MINIMUM_AUTO_COMPACT_TOKENS` preserved
- `src/compact/micro.ts` — `compactToolResultBlock` now receives `contextWindow`; Tier 1 tool_result truncation runs before early-return guard
- `src/agent/loop.ts` — removed `shouldAutoCompact` import and AND gate; calls `enforceContextCeiling()` before every API request
- `src/context/compact-policy.ts` — `tierForRatio` exported; Tier 4 reason changed
- `src/context/types.ts` — `ContextAnchor.kind` union includes `user_constraint`
- `src/api/types.ts` — `Message` interface extended with optional `cache_control`

### Verified

- 736/736 tests passing, typecheck clean, build succeeds
- DeepSeek prefix cache preserved: first 2 messages (CACHE_ANCHOR_MESSAGES=2) never modified
- 128K window test: 320K token fixture compacts to below 95% ceiling with anchors + resume state

## 2026-05-16 — Wave 1 Core Gaps Closed

### Added

- **Permission allow rules** — `src/agent/permissions.ts`: pattern matcher with exact, wildcard, and command-prefix support; `configSchema` extended with `permissions.allow`; `AgentLoop` approval short-circuits for allowlisted tool calls after risk assessment; allowlist does not skip risk tracking
- **Cost/token SummaryBar display** — `SummaryUsage` type with `inputTokens`/`outputTokens`/`cacheReadTokens`/`costUsd`; `summaryUsageFrom()` derives display state from `SessionContext.getTotalUsage()` without duplicate counting; SummaryBar line 3 and JSX render conditional token/cost display
- **Headless mode** — `src/headless.ts` with `parseCliArgs` (`-p`/`--print`, `--json`) and `runHeadless` (avoids Ink, collects output via callbacks, returns structured JSON with success/text/usage/error fields); `main.tsx` pre-Ink branch for headless args
- **Custom slash commands** — `src/commands/loader.ts` loads `.rivet/commands/*.md` in cwd; filters non-markdown, nested paths, and unsafe names (`COMMAND_NAME_RE`); `$ARGUMENTS` interpolation; `resolveAppPromptInput` resolves unknown slash commands after built-in handlers
- **First-run onboarding** — `src/onboarding.ts`: explicit sentinel file `~/.rivet/onboarding-dismissed` (not directory existence); `OnboardingPanel` Ink component with setup guidance; `/onboarding dismiss` only handles explicit command, never intercepts normal input

### Changed

- `src/config/schema.ts` — Extended `agentSchema` with `permissions.allow` array (pattern-matching rules)
- `src/config/default.ts` — Default `agent.permissions.allow: []`
- `src/agent/loop.ts` — Allowlist-aware approval short-circuit preserving risk tracking
- `src/main.tsx` — Headless CLI branch before Ink render; permissions config pass-through
- `src/tui/summary-bar.tsx` — Extended `SummaryState` with optional `usage`; token formatting helpers
- `src/tui/app.tsx` — Usage derivation from session; onboarding state/show/hide; custom command resolution before agent.run

### Verified

- 859 tests pass (was 702)
- npm run typecheck clean
- 5 new test files: permissions, headless, commands-loader, onboarding, schema

## 2026-05-16 — Cache Safety Layer

### Added

- `readFilePayload` shared helper — centralized validatePath + gitignore + offset/limit + truncation for both `read_file` tool and prewarm
- `prewarm-file.ts` — `buildPrewarmValue` (safe file read with size limit) and `canUsePrewarmForRead` (offset/limit guard)
- `PrewarmCache` now uses `PrewarmValue` type with canonical absolute path keys
- Per-cwd volatile caches — `.rivet.md` cache and git status cache both use per-cwd `Map` instead of module-level single values
- Prefix fingerprint covers stable volatile block (`stableVolatileSha256` in `PrefixFingerprint`)

### Fixed

- Prewarm cache bypasses `validatePath` and gitignore filtering → now uses `readFilePayload` for safe reads
- Prewarm cache key uses relative path on set but absolute path on get/invalidate → now uses canonical absolute path throughout
- Volatile caches not isolated by cwd → per-cwd `Map` prevents cross-project leakage
- 5 new tests: path traversal, gitignored files, canonical key, offset/limit bypass, cwd isolation

## 2026-05-16 — Multi-Session Isolation

### Added

- UUID session ID per TUI launch — `getOrCreateSessionId()` generates `crypto.randomUUID()` each time instead of reading from `session-id.txt`
- Session-scoped checkpoints — `checkpointFileForSession(sessionId)` with `CheckpointData.sessionId` field
- Checkpoint index — `checkpoint-index-<cwd>.json` tracks all sessions with checkpoints for a directory (cross-session discovery)
- Rollback session selection — `getRollbackPreview` and `rollbackToCheckpoint` accept optional `sessionId`, fallback to cwd-scoped legacy
- 7 new tests: UUID uniqueness, session-scoped paths, index tracking, selective removal, index deduplication

### Fixed

- Multiple TUI instances sharing the same session ID via `session-id.txt` → each launch gets unique ID
- Checkpoint files keyed by cwd slug → keyed by session ID, eliminates cross-session overwrite
- Session JSONL/memory files no longer conflict (natural isolation via unique session ID)

## 2026-05-16 — Capability Ledger Audit + Documentation Update

### Changed

- **Capability ledger audit**: 4 capabilities upgraded from Planned → Verified after codebase verification confirmed full implementation:
  - **P1 Remaining Gaps** — CockpitSnapshot aggregator, doom-loop strategy shift (4 pattern detectors), MCP tool risk rules in approval-risk
  - **Performance Optimization** — Non-blocking volatile-git stale cache, TUI log batching, incremental token accounting, smartCompact wired in main.tsx
  - **Capability Reliability Layer** — Path validation (path-validate.ts), checkpoint v2 (dirty snapshot + confirmation token + agent-owned files), safe output filenames (SHA-256), glob/grep cwd boundary + symlink cycle protection, run_tests safe argv filter, VerificationMetadata
  - **Harness Cockpit** — TraceStore, approval-risk assessment, 6 cockpit panels (trace/verify/context/safety/model/mcp), CockpitRail with status indicators, ModelCapabilityCard

### Updated

- Capability ledger: 18 Verified (was 14), 1 MVP, 1 Planned (Cache Safety), 2 Designed. 694 tests (now 702).
- README status line updated.
- CHANGELOG.md created.

### Known Remaining

- **CTCL Migration** (Designed) — tool input repair port from external repo
- **Open Source Harness Strategy** (Designed) — no implementation plan yet

## 2026-05-16 — Gap Closing Hardening

### Added

- Hooks error isolation — all `fire*` methods wrapped in try/catch
- `UserPromptSubmit` hook event — prompt chaining + block support
- `PreCompact` hook event — pre-compaction state preservation
- Git `log` action — oneline + decorate, configurable maxCount (1-100)
- Git `stash` action — stash working directory changes
- Git output truncation — 50KB max
- `TodoStore` class — worker-scoped concurrency safety with Zod validation
- `cleanupOrphans()` on FileHistory — removes unreferenced backup files

### Changed

- Web-fetch: regex `htmlToMarkdown()` replaced with turndown library (script/style stripped)
- Todo tool: module-level state → `TodoStore` instance with factory function
- 10 new tests across hooks, git, web-fetch, todo, file-history

## 2026-05-16 — Pastel Theme + Render Perf + Memory Safety

### Added

- Pastel color palette (default) with 256-color fallback
- `/theme [pastel|cyberpunk|list]` command
- Ring buffer for static items (500 cap)
- SessionContext collections bounded at 500 entries
- Braille sparkline for context token trend (last 20 turns)
- Rotating braille spinner in AgentStatus
- Memoized cockpit snapshot computation

## 2026-05-16 — Multi-pass Repair Pipeline

### Added

- 4-pass repair pipeline: syntax fix, type fix, import fix, semantic repair
- Schema gate strips invalid tool-use JSON before LLM retry
- Adaptive repair hint injection based on failure class
- Integration test covering full pipeline

## 2026-05-16 — Sub-agent Orchestration (Phase 1-4)

### Added

- WorkOrder/WorkerResult types with zod schemas
- Headless WorkerSession with independent context
- Priority queue with dedupe + dependency blocking
- 4 aggregation policies (primary_decides, all_required, first_success, majority)
- DelegationCoordinator with budget gate and batch dispatch
- Evidence status contract (verified/failed/blocked/unverified)
- Delivery gate blocks unverified worker results

## 2026-05-15 — P2 Capability Building

### Added

- MCP client (stdio/SSE, tool discovery, 5-class error classifier)
- Per-turn model routing (TaskInferrer + RoutingMetricsCollector)
- Repo intelligence (import graph + impact hint)
- Verification engine (VerificationState tracking)
- Failure sample library with secret redaction
- Cache diagnostic system (hit rate, miss reasons, drift detection)
- Progressive context engine (rounds, ledger, resume-preflight, session-memory)
