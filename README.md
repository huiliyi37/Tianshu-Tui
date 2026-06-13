# Rivet

A terminal coding agent powered by DeepSeek V4, with prefix cache optimization for the 1M context window. Ink 6 + React TUI, streaming responses, tool execution loop.

## Status

Cache Optimization (56% → 99.6%) + Convergence Detection + Seed Capsules + ProfileRegistry + Plan Mode + TUI Polish — **~2400 tests**, typecheck/build clean.

### 2026-06-02 — Cache Optimization + Convergence + Seed Capsules + TUI Polish

**Cache Optimization (四轮迭代):** 从 56% 崩溃到 99.6% 稳态。Round 1: Standalone Appendix (85%). Round 2: Cache-Friendly Ordering (98.3%). Round 3: Frozen Appendix (~99%, 只改 30 行). Round 4: 长会话验证 99.6%. DeepSeek prefix cache miss 是 hit 的 50× 成本，这是单次最高影响力优化。

**Convergence Detector:** 多信号停滞检测 — 工具指纹重复、振荡惩罚、交付感知完成信号。当收敛 + doomLoop blocked 同时触发时自动完成。

**Seed Capsules (天璇 + 天府):** 跨会话认知方法持久化。Opus 4.6 和 DeepSeek V4-PRO 的思维模式以结构化胶囊在启动时加载，无需共享内存状态。

**ProfileRegistry + Plan Mode:** 统一 worker profile 管理 (`.rivet/agents/` 加载) + `/plan-mode`/`/plan-approve` 交互式审批流程。

**Bash 安全加固:** 注入/destructive-extended/sed-bypass 模式检测 + 环境变量清理。

**DeepSeek V4 cache 报告修复:** `prompt_tokens_details.cached_tokens` fallback + prefixCache preset 从 `none` 改为 `deepseek-native`。

**TUI 打磨:** Panelized SlashHint/pendingApproval、domain colors + separator、left-border styling、新 logo + RIVET branding。

**全局重试超时:** `maxTotalDurationMs` 防止 60 分钟无限重试挂起。

See `CHANGELOG.md` for full details.

### 2026-05-20 — Self-Regulating Safety + Three-Authority Coroutine + Cache Engine

**Ice Mirror Cache Engine (冰鉴):** 双区域冻结/工作布局，`FieldHabituationTracker` 追踪字段变化，智能决定何时更新 FROZEN 区域。Cache hit ~5% → 90%+。

**Append-Only Artifact Log:** Tool output 从全文注入改为摘要引用 + 磁盘 artifact。上下文增长速度降低 90%+。

**Self-regulating approval:** `assessToolRisk()` consumes Sensorium 6D state vector. High confidence + low risk → auto-approve. Low confidence → risk escalated.

**Three-layer config:** `loadConfig()` resolves defaults → user → project → session overlay.

**Provider-aware compaction:** `compactThresholds()` selects cache-preserving / balanced / aggressive ratios per provider.

See `CHANGELOG.md` for full details.

## Quick Start

```bash
npm install && npm run build

# Set API key (pick one method)
export DEEPSEEK_API_KEY=sk-xxx          # via env
rivet config set-key deepseek sk-xxx # via CLI (saved to ~/.rivet/config.json)

# Start
node dist/main.js
# or after npm install -g:
rivet
```

## Architecture

```
src/
├── main.tsx              Entry: CLI routing → config → tools → prompt engine → agent → TUI
├── headless.ts           Headless mode: -p/--print with text/JSON output, no Ink
├── onboarding.ts         First-run onboarding sentinel state and dismissal helpers
├── validation.ts         Shared input validation (sessionId regex)
├── agent/
│   ├── loop.ts           Agent loop: LLM call → tool execution → repeat
│   ├── context.ts        Session state: messages, usage, turn count
│   ├── session-persist.ts JSONL session persistence + recoverable restore + turn snapshots + eviction (~/.rivet/sessions/)
│   ├── checkpoint.ts     Per-project git checkpoint + rollback v2 (agent-owned files only)
│   ├── file-history.ts   Per-file snapshot backup + rewind (undo backbone)
│   ├── evidence.ts       File tracking + test result badge + impacted files/tests
│   ├── delivery-gate.ts  Delivery gate: blocks unverified changes from delivery
│   ├── failure-classifier.ts  Test failure categorization + fix suggestions
│   ├── verification.ts   VerificationState: passed/failed/blocked tracking
│   ├── work-order.ts     WorkOrder/WorkerResult types + zod schemas
│   ├── work-queue.ts     Priority queue with dedupe + dependency blocking
│   ├── worker-session.ts Headless WorkerSession with independent context
│   ├── worker-prompts.ts Decomposition + result-aggregation prompts
│   ├── coordinator.ts    DelegationCoordinator: budget gate, model routing, batch dispatch
│   ├── coordinator-state.ts Lifecycle event tracking + failure budget
│   ├── aggregation.ts    4 aggregation policies (primary_decides, all_required, etc.)
│   ├── adaptive-routing.ts Per-profile per-model pass rate + latency scoring
│   ├── intent-extractor.ts Intent classification from user input
│   ├── prewarm.ts        Speculative pre-warming cache
│   ├── trace-store.ts    Structured event tracing (doom loop detection)
│   ├── strategy-shift.ts Doom-loop strategy suggestion (4 pattern detectors)
│   ├── approval-risk.ts  Tool risk assessment (doom loop, path traversal, destructive commands)
│   ├── permissions.ts  Allowlist pattern matching for approval short-circuit
│   ├── turn-harness.ts   Retry loop + trajectory recording for tool execution
│   └── task-state.ts     Task progress extraction from trajectory + model text
│   ├── import-graph.ts   Static import graph builder + reverse deps + invalidation
│   ├── impact-hint.ts    Edit impact analysis (affected files + related tests)
│   ├── delivery-gate.ts  Delivery gate: computes delivery status from evidence state
├── api/
│   ├── client.ts         Streaming API client with retry (exp backoff 1s/2s/4s)
│   ├── deepseek.ts       DeepSeek V4 provider: dual-format usage mapping
│   ├── provider.ts       ProviderCapabilities abstraction (thinking, cache, effort)
│   ├── sse.ts            SSE parser with id/retry field support
│   └── types.ts          Message, ContentBlock, Usage, ToolDefinition types
├── hooks/
│   ├── types.ts          HookEvent, HookHandler, PreToolUse/PostToolUse/Notification/SubagentStop/UserPromptSubmit/PreCompact types
│   └── registry.ts       HookRegistry: register, fire, input chaining, block support, error isolation
├── prompt/
│   ├── engine.ts         PromptEngine: frozen system prompt + volatile context + XML protocol
│   ├── static.ts         System prompt builder with 天枢 persona
│   ├── volatile.ts       Volatile context: .rivet.md, git status, ledger, escaped repair/session-memory blocks
│   ├── volatile-git.ts   Non-blocking git status: stale cache + async refresh
│   ├── context-layer.ts  Typed context layer model: stability, channel, fingerprint, stable digest
│   ├── fingerprint.ts    SHA-256 fingerprint for cache drift detection
│   └── cache-diagnostic.ts  Cache miss reason analysis (5 categories)
├── model/
│   ├── capability.ts     ModelCapabilityCard + recommendModelForTask scoring
│   ├── task-inferrer.ts  Task type inference from tool call patterns
│   └── routing-metrics.ts Routing event tracking + stats
├── repo/
│   ├── symbol-index.ts   Regex-based symbol extraction
│   ├── import-graph.ts   Relative import edge graph
│   └── context-bundle.ts Task context assembly (symbols + tests + risks)
├── tools/
│   ├── bash.ts           Shell execution (detached spawn), live output streaming, process-tree timeout cleanup
│   ├── edit.ts           Search-and-replace with uniqueness check
│   ├── read-file.ts      File reading with offset/limit, .gitignore filter, three-layer output
│   ├── write-file.ts     File creation/overwrite
│   ├── grep.ts           Pattern search (ripgrep first, native fallback)
│   ├── glob.ts           File discovery with **/*/?/{a,b} support
│   ├── diff.ts           Git diff with three-layer output
│   ├── run-tests.ts      Test runner with framework detection + parsing
│   ├── git.ts            Structured git: status, diff_summary, log, stash, commit (spawnSync, 50KB truncation)
│   ├── todo.ts           Session-scoped task list with Zod validation (backed by TodoStore)
│   ├── todo-store.ts     Worker-scoped todo state container (isolated per worker)
│   ├── web-fetch.ts      URL fetch with turndown HTML→Markdown, SSRF protection (redirect-safe), per-hop timeout
│   ├── undo.ts           File-level undo via snapshot rewind (preview + confirm)
│   ├── inspect-project.ts Project summary: language, framework, scripts
│   ├── repo-map.ts       Annotated file tree with entry/test/config markers
│   ├── related-tests.ts  Test file inference for source paths
│   ├── output-store.ts   Three-layer: raw→disk, compressed→LLM, summary→TUI
│   ├── registry.ts       Tool registration, approval gating, allowlist filtering
│   ├── default-registry.ts  Default tool registry factory (11 core tools)
│   ├── delegate-task.ts  delegate_task tool: Phase 1 read-only worker delegation
│   ├── gitignore.ts      .gitignore parser + default ignore patterns
│   ├── process-kill.ts    Process-group kill helper with child.kill fallback
│   ├── process-tracker.ts Child process tracker (killAll on abort/timeout cleanup)
│   ├── path-validate.ts  Path traversal protection
│   └── truncation.ts     Output truncation (head + tail)
├── compact/
│   ├── micro.ts          Micro-compact: round-safe truncation with early-return optimization
│   ├── auto.ts           Smart compact: reactive round selection + boundary message + summary quality gate
│   └── constants.ts      Compaction thresholds per context window size
├── context/
│   ├── compact-policy.ts Progressive ratio-based compaction (tier 0-4) + circuit breaker
│   ├── anchor-registry.ts Pinned structural anchors with budget enforcement
│   ├── persistent-store.ts SHA-256 cold storage archive with disk limit
│   ├── pressure-monitor.ts PSI-style pressure/thrashing detection
│   ├── proactive-inject.ts Anchor-to-XML active-constraints injection
│   ├── rounds.ts         API round grouping + invariant validation
│   ├── ledger.ts         Context Ledger with health levels
│   ├── resume-preflight.ts Repair broken message histories
│   ├── session-memory.ts Per-session memory sidecar
│   ├── reactive-compact.ts Compact round selection + boundary message
│   ├── microcompact.ts   Microcompact tool results (preserve API rounds)
│   ├── claims.ts         Context claim types, proposal, prompt eligibility, XML rendering (20-cap)
│   ├── claim-store.ts    JSONL append-only event store with incremental projection
│   ├── claim-extractor.ts Tool results → typed claim proposals with per-kind TTL
│   ├── promotion.ts      Claim lifecycle: active → durable_candidate → durable
│   ├── antibody.ts       Antibody claim generation from failure patterns
│   ├── conflict-detect.ts Detects contradictory file-evidence claims
│   └── types.ts          Context health, budget, anchor, session memory types
├── failures/
│   └── sample.ts         Redacted failure sample library for testing
├── commands/
│   └── loader.ts         Custom slash command loader from .rivet/commands/*.md
├── config/
│   ├── schema.ts         Zod config schema (provider, agent, compact, cache, mcp)
│   ├── default.ts        Default config: DeepSeek V4 Pro/Flash
│   └── manager.ts        CLI config manager (rivet config <command>)
├── mcp/
│   ├── config.ts         MCP server config schema (stdio/SSE validation)
│   ├── wrapper.ts        MCP tool → Rivet Tool adapter (mcp__<server>__<tool> naming, __ sanitization, error classification)
│   ├── manager.ts        Connection lifecycle, parallel tool discovery, timeouts, degraded state
│   ├── failure-classifier.ts MCP error taxonomy (config/auth/network/protocol/tool_error, retryable hints)
│   └── types.ts          McpConnectionState type (with lastErrorClass)
└── tui/
    ├── app.tsx            Main app: slash commands, approval UI, cockpit, live tool output
    ├── input.tsx          Input bar with cursor, history, Ctrl+A/E/W/U
    ├── base-text-input.tsx Full-featured text input with history nav
    ├── status-bar.tsx     Model, cache hit rate, cost, token bar, theme colors
    ├── summary-bar.tsx    Live 3-line cockpit: phase, context%, last action, risk, token/cost
    ├── phase-tracker.ts   Tool→phase state machine (searching/coding/testing/…)
    ├── theme.ts           Truecolor/fallback color palette with tool-specific colors
    ├── stream.tsx         Streaming text output (memoized)
    ├── stream-window.ts   Bounded live stream tail window for React state
    ├── block-stream-writer.ts Semantic break-point streaming (paragraph/newline/space boundaries)
    ├── history-replay.ts  Session history visual replay bridge (Message[] → LogEntry[])
    ├── thinking.tsx       Thinking block with Tab expand/collapse
    ├── tool-card.tsx      Tool execution display with theme-colored borders
    ├── log-state.ts       Log entry types, state management, output summarization
    ├── markdown-render.tsx Markdown parser + Ink renderer (inline/block, syntax highlight)
    ├── diff-render.tsx    Unified diff detection + colorized rendering (+green/-red)
    ├── pager.tsx          Interactive scroll pager (/scroll) + ScrollBuffer
    ├── render-entry.tsx   Shared log entry renderer (tool/checkpoint/evidence/text)
    ├── history.ts         Command history persistence
    ├── error-boundary.tsx React error boundary (catch without crash)
    └── cockpit/           Multi-panel cockpit module
        ├── types.ts       Panel type + PANELS + PANEL_LABELS + CockpitSnapshot
        ├── state.ts       buildCockpitSnapshot aggregator + computePanelStatuses
        ├── rail.tsx       CockpitRail tab navigation with ok/warn/error status indicators
        ├── trace-panel.tsx      TraceEvent visualization (color-coded status)
        ├── verification-panel.tsx Evidence display (files read/modified, impacted files/tests, delivery status)
        ├── context-panel.tsx    Context ledger details (token bar, rounds, compaction, context layers)
        ├── safety-panel.tsx     Doom loop + risk assessment + strategy shift + fingerprint diversity
        ├── model-panel.tsx      Model name, cache hit rate, token breakdown, cost, routing reason
        ├── mcp-panel.tsx        MCP server status (connected/error/tool count)
        ├── approval-risk-card.tsx Inline risk card (color-coded border)
        └── index.ts       Barrel export
```

### Data Flow

```
User input → App.handleSubmit
  ├─ /onboarding dismiss? → dismiss onboarding → skip agent
  ├─ Slash command? → handle built-in (/help, /exit, ...) → if unknown, resolve custom command from .rivet/commands/
  └─ Agent loop:
       PromptEngine.buildRequest(messages, toolHistory)
         → static system prompt (frozen, cache anchor)
         → volatile context (.rivet.md, git status, working set, tool-history)
         → per-turn tool history injected into last user message
       ApiClient.stream(request, callbacks)
         → SSE parse → content blocks (text, thinking, tool_use)
         → retry on 429/502/503/529 (exp backoff)
         → Intent extraction every 500 chars → speculative file pre-read
       Tool execution (if tool_use blocks)
         → PreToolUse hook (input modification / block)
         → approval check → prewarm cache fast-path for read_file
         → spawn/exec → result → PostToolUse hook (result modification)
         → cache invalidation for writes
         → tool history recorded (last 5, injected into next volatile context)
         → live output streaming via onOutput callback
         → child process tracked (killAll on SIGINT/SIGTERM)
       Loop until no tool_use or maxTurns reached
```

### Prefix Cache Strategy

System prompt is frozen at construction time and never changes within a session. Volatile context (git status, working set) is injected as separate user messages. This produces a consistent prefix structure across turns:

```
Turn 1: [system, user(<context>), user("hello")]
Turn 2: [system, user(<context>), user("hello"), assistant, user(<context>), user("read")]
```

DeepSeek's prefix cache matches on complete prefix, so the frozen system prompt + early turns cache-hit every subsequent request.

### Cache-first Context Layers

The prompt is split into 6 logical layers with explicit stability contracts. Physical channels remain `system + tools + volatile user message` for DeepSeek prefix-cache compatibility:

| Layer | Content | Stability | Fingerprint |
|-------|---------|-----------|-------------|
| L1 | Frozen system prompt | stable | included |
| L2 | Tool definitions (stable-sorted) | stable | included |
| L3 | Project instructions + git status | stable-volatile | included |
| L4 | Session memory + working set | stable-volatile | included/partial |
| L5 | Tool history, task progress, behavior mirror, decisions | dynamic | excluded |
| L6 | Current user request | dynamic | excluded |

Layers L1-L4 form the stable volatile block (frozen at construction, participates in `PrefixFingerprint.stableVolatileSha256`). Layers L5-L6 are injected only into the latest turn's volatile context, never polluting the cached prefix. `PromptEngine.getContextLayerReport()` exposes per-layer stability, channel, fingerprint policy, and token estimates for diagnostics.

### Cache Safety

Rivet uses several local caches to improve DeepSeek prefix-cache behavior and reduce repeated filesystem work. Cache layers must not bypass tool security boundaries:

- `read_file` and speculative prewarm share the same path validation and gitignore filtering (`readFilePayload`).
- Prewarm cache keys are canonical absolute paths and are invalidated after `edit_file` / `write_file`.
- Prewarm is used only for full-file reads; ranged reads with `offset` or `limit` execute the normal tool path.
- `.rivet.md` and git status caches are scoped by cwd.
- Prefix fingerprints include system prompt, tool definitions, and stable volatile context.

### Multi-Session Isolation

Each Rivet TUI launch generates a unique session ID (UUID v4). Session files, checkpoints, and memory are scoped to this ID, so multiple TUI instances can run in parallel without interfering:

- Session JSONL: `~/.rivet/sessions/<sessionId>.jsonl` — unique per launch
- Checkpoints: `~/.rivet/checkpoint-<sessionId>.json` — unique per launch
- Checkpoint index: `~/.rivet/checkpoint-index-<cwd-slug>.json` — shared, lists all sessions with checkpoints for a directory
- Rollback: `/rollback` operates on the current session's checkpoint; legacy cwd-scoped checkpoints are used as fallback

For maximum isolation (separate git working trees), use git worktrees:
```bash
git worktree add ../project-feature-a feature-a
cd ../project-feature-a && rivet
```

## Features

- **Prefix cache optimization** — Frozen system prompt + structured message ordering
- **Streaming TUI** — Ink 6 (React for CLI), 50ms render batching (~20fps)
- **17 builtin tools** — bash, diff, edit_file, read_file, write_file, grep, glob, run_tests, git, todo, web_fetch, undo, inspect_project, repo_map, related_tests, lsp_goto_definition, lsp_find_references
- **Non-blocking git status** — Stale cache + async refresh, no event loop blocking
- **Approval workflow** — y/n confirmation for dangerous operations
- **Session persistence** — JSONL append, resume on restart, compact on exit
- **Auto-compaction** — Triggers at 800K tokens, LLM summarization with micro-compact fallback
- **Smart compact** — LLM-based conversation summarization preserves context across long sessions
- **Incremental token accounting** — O(1) per-turn token estimates via session-level tracking
- **Render batching** — 50ms batched flush for text, thinking, and tool output (~20fps)
- **Provider abstraction** — ProviderCapabilities for multi-provider support
- **Dual-format usage** — Reads both DeepSeek native and Anthropic compat fields
- **Three-layer output** — Raw persistence + model compression + UI summary for large tool outputs
- **Auto-checkpoint** — Git checkpoint created before first file modification each turn
- **Trust Cockpit** — Evidence badge (files read/modified, tests), checkpoint/rollback, raw output tracing
- **Test failure classifier** — Categorizes failures (type_error/assertion/timeout/…) with fix suggestions
- **Cache diagnostics** — Hit rate color coding (green ≥80%, yellow ≥40%, red <40%), automatic miss reason analysis, per-turn cache history tracking
- **Cache-aware pricing** — Cache hit tokens priced at 1/10 rate (DeepSeek V4 promo), savings displayed in `/debug cache`
- **Compaction cache anchor** — First 2 messages preserved as cache anchor after compaction, stable XML summary header
- **Truncated JSON recovery** — Recovers partial tool_use JSON from streaming
- **Slash commands** — /help /exit /compact /model /clear /rollback /sessions /resume /verbose /debug /evidence /undo /auto /mcp /context /memory /theme /cockpit /interview /effort
- **Reasoning effort** — `/effort` controls reasoning depth: `off` | `low` | `medium` | `high` | `max`; persists for the session, `max` for full thinking on every turn
- **Config CLI** — Manage API keys, providers, models, MCP servers from terminal
- **MCP client** — Model Context Protocol: connect external tool servers via stdio or SSE, auto-discover tools, register as `mcp__<server>__<tool>` (with `__` sanitization), parallel init, approval heuristics, 5-class error classifier (config/auth/network/protocol/tool_error), `/mcp` + `/debug mcp` status
- **LSP integration** — Language Server Protocol: `lsp_goto_definition` and `lsp_find_references` tools powered by typescript-language-server, symbol-level navigation replaces blind grep for TypeScript projects
- **.gitignore filter** — Skips node_modules, .git, build artifacts
- **Headless mode** — `-p`/`--print` flag runs AgentLoop without Ink; `--json` returns structured JSON with success/text/usage/error
- **Permission allow rules** — Configurable allowlist with exact, wildcard, and pattern matching; allowlisted tools skip approval while preserving risk tracking
- **Cost/token display** — Live input/output/cache token counts and estimated cost in SummaryBar; derived from SessionContext usage, no duplicate counting
- **Custom slash commands** — Project-local `.rivet/commands/*.md` with `$ARGUMENTS` interpolation; resolved after built-in slash commands
- **First-run onboarding** — Explicit sentinel-based detection; guidance panel with setup instructions; `/onboarding dismiss` never intercepts normal input
- **Graceful shutdown** — SIGINT/SIGTERM → abort agent + persist session + kill children
- **ErrorBoundary** — React errors caught without crashing the process
- **Config validation** — Zod schema with deep merge over defaults
- **Subagent orchestration** — Typed WorkOrder/WorkerResult, headless WorkerSession, tool allowlist enforcement, batch dispatch with aggregation
- **Write-capable workers** — Patcher profile with edit_file, write_file, bash, run_tests; patchSummary in results
- **Adaptive model routing** — Per-profile per-model pass rate + latency composite scoring, history-capped at 100 entries
- **Work order queue** — Priority queue with dedupeKey guard, dependency blocking, max concurrency control
- **Aggregation policies** — primary_decides, all_required, first_success, majority vote
- **Coordinator state** — Lifecycle events (queued/running/passed/failed/blocked/escalated), failure budget escalation
- **Progressive context engine** — API round grouping, context ledger with health levels, resume preflight repair
- **Session memory** — Per-session sidecar that survives compaction; `/memory` CRUD
- **Reactive compact** — Selects API-invariant rounds for compaction, preserves cache anchors
- **Compact policy** — Progressive tier decision + circuit breaker (3 consecutive failures → skip)
- **TUI cockpit** — Multi-panel cockpit with 7 views (Summary, Trace, Verify, Context, Safety, Model, MCP), `/cockpit [panel]` sub-mode navigation, doom loop detection, risk assessment, unified CockpitSnapshot aggregator with panel status indicators (●/◐)
- **Theme system** — Truecolor palette (cyan/purple/green) with 256-color fallback, tool-specific border colors
- **Gradient banner** — Startup banner with gradient-string
- **XML protocol layer** — Volatile context uses structured XML tags for cache-stable injection
- **Speculative pre-warming** — Intent-based prompt pre-warming cache
- **Input validation** — Shared sessionId regex in `src/validation.ts`, path boundary enforcement
- **天枢 persona** — "Don't Guess — Verify" workflow, design-doc-first, TDD guidance
- **Claim extractor** — Automatic claim extraction from tool results: read_file→file_observation (30min), run_tests→failure_pattern/verification_fact (2h/1h), bash→security_finding (4h); grep/glob skipped
- **Claim promotion** — Two-stage lifecycle: active→durable_candidate (3 consumers), durable_candidate→durable (5 consumers + 10min age)
- **Cross-session durable claims** — Durable claims survive session restart with 0.9 confidence decay; injected on TUI startup and goal loop launch
- **Claim budget cap** — MAX_PROMPT_CLAIMS=20 limits active claims in prompt, sorted by fitness
- **Antibody claims** — Failure patterns boost approval-risk for repeat tool failures
- **Conflict detection** — Contradictory file-evidence claims auto-detected and marked conflicted
- **Three-layer read_file** — Raw persistence + model compression + line-numbered TUI preview (50 lines)
- **Live tool output** — Batched streaming display (50ms flush), no more silent tool execution
- **Safe rollback** — Checkpoint v2: only reverts agent-owned files, protects user pre-existing changes, confirmation token gating
- **Path boundary enforcement** — glob/grep/diff reject `..` traversal and absolute paths outside project
- **Symlink cycle protection** — realpath + visited set prevents infinite directory traversal
- **Search output caps** — Global max_results enforcement on grep (ripgrep streaming kill + native cap)
- **Targeted test runs** — run_tests filter constructs safe argv (no sh -c), outputs VerificationMetadata
- **Verification engine** — VerificationState tracks passed/failed/blocked, evidence badge uses buildFinalVerificationReport
- **Tool safety policy** — Unified `assessToolRisk` evaluates destructive commands, force push, path traversal, rollback/undo; outputs structured `RiskAssessment` with reasons and suggestedAction; feeds approval prompts, hooks, and cockpit safety panel
- **Evidence delivery gate** — `DeliveryVerificationStatus` (verified/failed/blocked/unverified) computed from EvidenceTracker state; badge surfaces unverified-change warnings when no relevant verification ran after edits; single worker results gated through `aggregateResults()`
- **Repo intelligence** — Lightweight import graph (regex-based, 1000-file cap) with reverse dependency lookup; impact hint generated after each edit showing affected files and related tests; impact info surfaced in evidence badge
- **Model capability routing** — ModelCapabilityCard + recommendModelForTask scoring per task type; TaskInferrer infers task from tool call patterns (code_edit, test_failure_diagnosis, risky_refactor, repo_summarization); per-turn model switching integrated into AgentLoop; routing reason visible in volatile context and cockpit
- **Doom-loop strategy shift** — `suggestStrategyShift()` detects 4 trajectory patterns (repeated failures, unverified writes, transient errors, generic repetition) and injects strategy suggestions when doom-loop is detected
- **MCP failure classifier** — 5-class error taxonomy (config, auth, network, protocol, tool_error) with retryable hints and user-facing suggestions; error class annotated on MCP tool results
- **Failure sample library** — createFailureSample with automatic secret redaction (sk-* patterns)
- **Raw output path safety** — SHA-256 hashed filenames, no toolUseId in path
- **Agent hooks** — PreToolUse/PostToolUse/Notification/SubagentStop/UserPromptSubmit/PreCompact lifecycle hooks; input chaining, block support, error isolation (handler errors never crash agent loop)
- **Structured git tool** — status, diff_summary, log (maxCount), stash, commit actions via spawnSync (no shell injection); 50KB output truncation; approval-gated commits
- **Todo tracking** — Worker-scoped TodoStore class for concurrency safety; Zod validation; read/write actions, status icons
- **Web fetch** — URL fetching with turndown HTML→Markdown conversion (script/style stripped), SSRF protection (private IP blocking), 15s timeout, 50K truncation
- **File-level undo** — Per-file snapshot backup system; versioned backups in `~/.rivet/file-history/{sessionId}/`, preview + confirm workflow, orphaned backup cleanup
- **SSRF protection** — Per-hop DNS resolution + private IP detection (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, fc/fd/fe80) validated on every redirect, max 5 hops
- **Markdown rendering** — Block parser (headers, code blocks, lists, blockquotes, tables, HR) + inline tokenizer (bold, italic, code, links), minimal syntax highlighting for JS/TS/Python/Go/Rust/Bash
- **Diff colorizer** — Unified diff detection with signal-based heuristics, colorized output (add=green, del=red, hunk=gray, header=yellow), auto-truncation
- **Scroll pager** — `/scroll` command with vi-style navigation (j/k/PgUp/PgDn/g/G/q/Esc), 500-entry ScrollBuffer, 100-item Static cap to prevent terminal buffer overflow
- **Context layer model** — Typed context layers with stability/channel/fingerprint metadata, stable digest for cache diagnostics, CockpitContextLayerView in context panel
- **Pastel theme** — Soft, pleasant color palette (default); switchable to cyberpunk via `/theme cyberpunk`
- **Rendering optimization** — Memoized cockpit snapshot, bounded staticItems ring buffer (500 cap)
- **Memory safety** — SessionContext collections capped at 500 entries (filesRead, filesModified, testResults, cacheHistory)
- **Braille sparkline** — Context token trend visualization in SummaryBar (last 20 turns)
- **Spinner animation** — Rotating braille spinner in AgentStatus during streaming

## Configuration

### Using the CLI (recommended)

```bash
# Interactive provider setup (TTY only)
rivet config

# List providers and API key status
rivet config providers

# Configure DeepSeek using an environment variable
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default

# Configure GLM using an environment variable
rivet config setup glm --key-env ZHIPU_API_KEY

# Override MiMo gateway URL
rivet config setup mimo --key-env MIMO_API_KEY --url https://token-plan-sgp.xiaomimimo.com/v1

# Override MiniMax model and make it default
rivet config setup minimax --key-env MINIMAX_API_KEY --model MiniMax-M2.8 --alias m28 --context-window 300000 --max-tokens 64000 --default

# Configure Codex OAuth provider; login happens on first run with --provider codex
rivet config setup codex --default

# Direct updates for existing providers
rivet config set-url deepseek https://api.deepseek.com/v1
rivet config set-model deepseek deepseek-v4-pro 1000000 163000 v4-pro
rivet config set-key-env deepseek DEEPSEEK_API_KEY

# Approval mode: skip all interactive approval prompts for trusted developer workspaces
rivet config set-approval dangerously-skip-permissions

# Restore recommended smart-safe approval mode
rivet config set-approval auto-safe

# Show full config
rivet config show
```

### Manual config file

Place `~/.rivet/config.json` (optional, uses built-in provider presets if missing). The file may contain only overrides; defaults are deep-merged before validation:

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          { "id": "deepseek-v4-pro", "contextWindow": 1000000, "maxTokens": 64000 }
        ]
      }
    }
  },
  "agent": { "maxTurns": 50, "approval": "auto-safe" },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

Approval modes:

| Value | Behavior |
|---|---|
| `auto-safe` | Recommended default: low-risk actions can proceed automatically; high-risk actions still ask. |
| `manual` | Ask whenever a tool declares approval is required. |
| `auto-accept` | Auto-accept normal approval prompts for compatibility. |
| `dangerously-skip-permissions` | Skip all interactive approval prompts, including high-risk commands and bash writes. Use only in trusted workspaces. |

For one session only, start with:

```bash
rivet --dangerously-skip-permissions
```

See `docs/dangerously-skip-permissions.md` for the full safety boundary.

### MCP Server Configuration

Connect external tool servers via Model Context Protocol:

```bash
# Add a local MCP server (stdio transport)
rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp

# Add a remote MCP server (SSE transport)
rivet config mcp add-sse ctx7 http://localhost:3001/sse

# List configured servers
rivet config mcp list

# Enable/disable without removing config
rivet config mcp disable fs
rivet config mcp enable fs

# Remove a server
rivet config mcp remove fs
```

MCP tools appear as `mcp__<serverId>__<toolName}` and are auto-discovered at startup. Use `/mcp` or `/debug mcp` to check connection status.

### Multi-Provider Configuration

Rivet supports multiple model providers with different authentication methods:

| Provider | Protocol | Auth | Models |
|----------|----------|------|--------|
| DeepSeek | OpenAI-compatible | API key | deepseek-v4-pro, deepseek-v4-flash |
| **Claude** | **OpenAI-compatible proxy** | **API key (`CLAUDE_API_KEY`)** | **opus-4-7, opus-4-6, sonnet-4-5** |
| GLM | OpenAI-compatible | API key | glm-5.2 |
| Codex (GPT-5.5) | Codex Responses | OAuth PKCE | gpt-5.5 |
| MiniMax | OpenAI-compatible | API key | MiniMax-M2.7 |
| MiMo | OpenAI-compatible | API key | mimo-v2.5-pro, mimo-v2.5 |
| OpenCode Go | OpenAI-compatible | API key | aggregated models |

#### Claude via CLI Proxy

Claude models are accessed through a local CLI proxy (`cc-switch`) that translates OpenAI-compatible requests to Anthropic Messages API. All three models support 1M context window, 128K max output, and extended thinking with `reasoning_effort: max`.

```bash
# Prerequisites: cc-switch proxy running at http://127.0.0.1:8891
# API key from CC_SWITCH_PROXY_API_KEY environment variable

# Start with Claude Opus 4-7 (strongest reasoning)
node dist/main.js --provider claude --model claude-opus-4-7

# Use alias shorthand
node dist/main.js --provider claude --model opus-4-7

# Switch inside a running session
/model claude/claude-opus-4-7
/model claude/opus-4-6
/model claude/sonnet-4-5
```

Extended thinking is enabled by default with `budget_tokens` scaled to the full 128K output budget at `max` reasoning effort. The proxy handles Anthropic-native thinking format translation.

#### Codex OAuth Login

Codex uses OAuth PKCE authentication with the ChatGPT subscription (not API billing):

```bash
# First run triggers browser login
node dist/main.js --provider codex --model gpt-5.5

# Token saved to ~/.rivet/auth/codex.json, auto-refreshes at 55 min
# Subsequent runs use saved token automatically
```

#### API Key Providers

Set environment variables for API key providers:

```bash
export MINIMAX_API_KEY="your-key"
export MIMO_API_KEY="your-key"
export OPENCODE_GO_API_KEY="your-key"
```

#### Worker Routing (Sub-Agent Model Selection)

Configure different providers for main agent vs sub-agents in `~/.rivet/config.json`:

```json
{
  "workers": {
    "profiles": {
      "capable": { "provider": "codex", "model": "gpt-5.5" },
      "cheap": { "provider": "minimax", "model": "MiniMax-M2.7" },
      "mid": { "provider": "mimo", "model": "MiMo-V2.5-Pro" }
    },
    "routing": {
      "code_edit": "capable",
      "risky_refactor": "capable",
      "repo_summarization": "cheap",
      "test_failure_diagnosis": "cheap"
    }
  }
}
```

Task types: `code_edit`, `risky_refactor`, `repo_summarization`, `test_failure_diagnosis`, `compaction`.
Compaction is always handled by the main agent's own model (`compact.model`), not delegated.

#### CLI Arguments

```bash
node dist/main.js                                    # Use default provider
node dist/main.js --provider codex --model gpt-5.5   # Specific provider + model
node dist/main.js --provider minimax --model MiniMax-M2.7
```

#### TUI Model Switching

Inside a session, use `/model list` to show configured providers and models, then switch by model id or alias:

```
/model list
/model gpt-5.5
/model MiniMax-M2.7
/model mimo-v2.5-pro
/model v4-pro
```

## Slash Commands (in TUI)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/exit` `/quit` | Save session and exit |
| `/compact` | Compact conversation context now |
| `/model [name\|list]` | Show or switch model |
| `/verbose` | Toggle verbose tool output (20 → 200 lines) |
| `/debug [prompt\|fingerprint\|cache\|mcp]` | Debug prompt, cache fingerprint, cache stats, or MCP connections |
| `/clear` | Clear screen (visual only) |
| `/sessions` | List all saved sessions |
| `/resume <number>` | Restore a saved session |
| `/rollback` | Preview changes since checkpoint (`/rollback confirm` to execute) |
| `/undo` | Undo last file change (preview diff, `confirm` to restore) |
| `/evidence` | Show last turn evidence summary |
| `/context` | Show context ledger: health, tokens, API round safety, compact events, claims |
| `/context antibodies` | Show antibody claims (failure patterns boosting risk) |
| `/context conflicts` | Show conflicted claims (contradictory file evidence) |
| `/memory` | List session memory entries |
| `/memory <text>` | Save a manual session memory entry |
| `/cockpit [summary\|trace\|verify\|context\|safety\|model\|mcp\|off]` | Toggle or switch cockpit panel (Esc to collapse) |
| `/mcp` | Show MCP server connection status |
| `/scroll` | Browse output history with scrolling (j/k/PgUp/PgDn/g/G/q) |
| `/onboarding dismiss` | Dismiss first-run onboarding guide |
| `/theme [pastel\|cyberpunk\|list]` | Switch color theme |

## User Manual

### First Time Setup

```bash
# 1. Install dependencies
npm install && npm run build

# 2. Configure your DeepSeek API key (one of):
export DEEPSEEK_API_KEY=sk-xxx
# or save persistently:
node dist/main.js config set-key deepseek sk-xxx

# 3. Launch
node dist/main.js
```

### Basic Usage

Type your request in the input bar and press Enter. Rivet will:
1. Understand your request and plan an approach
2. Read files, search code, and make edits as needed
3. Run tests to verify changes
4. Show an evidence summary when done

### Understanding the Status Bar

```
deepseek-v4-pro  cache:98.7%  ctx:healthy  rounds:safe  ¥0.15  ████░░░░░░  125K/1M (12%)
│                │            │            │             │      │            └── context usage
│                │            │            │             │      └── token budget bar (color: green/yellow/red)
│                │            │            │             └── estimated cost (cache discount applied)
│                │            │            └── API round invariant (green=safe, red=broken)
│                │            └── context health (green=healthy, yellow=warning/compacting, red=critical)
│                └── cache hit rate (green ≥80%, yellow ≥40%, red <40%)
└── current model
```

### Context Cockpit

Rivet tracks context health in real time. The status bar shows:

- **`ctx:<state>`** — `healthy`, `warning`, `compacting`, or `critical` based on token usage
- **`rounds:safe`** / **`rounds:!`** — whether all API message rounds pass invariant checks
- **`/context`** — detailed view: token sections, round diagnostics, compact history

During streaming, a live **SummaryBar** appears showing:

```
◆ search for routing → searching │ ▓▓░░░ 45% │ 12s
├ last: read_file loop.ts → ✓
└ step 3 │ risk: none
```

- **Phase tracker** — Maps tool names to phases: searching (read/grep/glob), coding (edit/write), testing (run_tests), running (bash). Debounced: requires 2 consecutive same-type tools before switching phase.
- **Context bar** — Visual token usage with color coding (cyan → yellow → red). **Bold** at ≥95%.
- **Last action** — Shows which tool ran last and whether it succeeded
- **Risk indicator** — `medium` when bash runs without auto-approve, otherwise `none`

Type `/cockpit` to toggle the expanded cockpit panel, or `/cockpit <panel>` to open a specific view:

| `/cockpit` sub-command | Panel | Shows |
|---|---|---|
| `summary` (default) | SummaryBar | Live phase, context%, last action, risk, panel status indicators |
| `trace` | TracePanel | Tool execution events with color-coded status and duration |
| `verify` | VerificationPanel | Files read/modified counts, impacted files/tests, test results, delivery status |
| `context` | ContextPanel | Token bar, API rounds, compaction state, compact history, context layers |
| `safety` | SafetyPanel | Doom loop level, risk level + reasons, strategy shift suggestion, fingerprint diversity |
| `model` | ModelPanel | Model name, cache hit rate bar, token breakdown, cost, routing reason |
| `mcp` | McpPanel | MCP server status (connected/error/tool count) |
| `off` | — | Collapse cockpit |

Press **Esc** to collapse the cockpit from any panel.

### Cockpit State and Capability Ledger

Cockpit panels are driven by a single `CockpitSnapshot` built by `buildCockpitSnapshot()` so safety, verification, context, model, and MCP status agree on the same turn state. The cockpit rail summarizes each panel area as ok, warn, error, or idle via `panelStatuses`.

Core capability progress is tracked in `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`. A capability is only marked **Verified** after targeted behavior tests and full validation pass; design and plan documents alone do not imply implementation completion.

### Subagent Orchestration

Rivet can delegate sub-tasks to independent worker sessions:

- **Work orders** — Typed objectives (code_search, review, verify, patch_proposal) with budget constraints
- **Tool isolation** — Read-only workers (read_file, glob, grep, diff) or write workers (adds edit_file, write_file, bash, run_tests)
- **Adaptive routing** — Workers track per-model pass rate and latency; best model is auto-selected for each profile
- **Batch dispatch** — Multiple work orders run concurrently with aggregation (majority vote, all_required, first_success, or primary_decides)
- **Coordinator state** — Lifecycle events tracked with failure budget escalation (3 consecutive failures triggers escalation)

### Progressive Context Engine

The context engine manages long conversations safely:

- **API round grouping** — Messages are grouped into assistant+user rounds and validated for API compliance
- **Context ledger** — Tracks token budget, health state, API invariant status, and compact events per turn
- **Resume preflight** — When restoring a session, broken rounds are detected and synthetic tool results are inserted to restore API compliance
- **Reactive compact** — Compaction selects only API-invariant rounds, preserving cache anchors and recent context
- **Compact policy** — Progressive tier decision with circuit breaker: 3 consecutive compaction failures disables auto-compact

### Speculative Pre-warming

During streaming responses, Rivet detects file paths in the model's output and pre-reads them into cache before the model issues a `read_file` tool call:

- Intent extraction runs every 500 characters of streaming text
- Detected file paths (src/\*, config/\*, docs/\*, etc.) are pre-read into a TTL cache (30s expiry, 20 entries max)
- When a `read_file` tool call arrives, cached files return instantly (fast-path)
- Cache is invalidated on `write_file` / `edit_file` to prevent stale data
- Files larger than 100KB are skipped to avoid blocking the event loop

### Agent Hooks

The hook system allows intercepting tool execution at lifecycle points:

- **PreToolUse** — Runs before each tool call. Can modify the tool input (e.g. auto-format paths) or block execution entirely (e.g. security policy)
- **PostToolUse** — Runs after each tool call. Can modify the result (e.g. redact secrets from output)
- **Notification** — Receives informational events (e.g. status changes)
- **SubagentStop** — Receives worker completion events
- **UserPromptSubmit** — Runs before user prompt is sent. Can modify or block the prompt (e.g. content filtering)
- **PreCompact** — Runs before context compaction. Receives turn/message counts for logging or state preservation

Hooks are synchronous and execute in registration order. Handler errors are caught and isolated — a broken hook never crashes the agent loop. PreToolUse supports input chaining and short-circuit blocking.

### Structured Git Tool

The `git` tool provides type-safe git operations without raw shell commands:

- **status** — Show working tree status, current branch, and file changes
- **diff_summary** — Show diff stats for staged and unstaged changes
- **log** — Show recent commit history (default 20, configurable with `maxCount`, clamped to 1-100)
- **stash** — Stash current working directory changes
- **commit** — Stage all changes and commit with a message (requires approval)

Commit messages are passed via `spawnSync` args array — never interpolated into a shell string — preventing command injection. All output is truncated at 50KB to prevent context window overflow.

### Todo Tracking

The `todo` tool maintains a session-scoped task list:

- **write** — Replace the entire list with a new one (validated via Zod)
- **read** — Return the current list with status icons (✓ completed, ► in progress, ○ pending)

Useful for multi-step tasks where the agent needs to track its own progress.

### Web Fetch

The `web_fetch` tool retrieves web content:

- URL validation (http/https only) and DNS resolution
- **SSRF protection** — Per-hop DNS + private IP blocking on every redirect (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, fc/fd/fe80)
- **Redirect-safe** — Manual redirect following with DNS validation at each hop (max 5 redirects)
- HTML content is converted to Markdown via `turndown` (links, headings, code blocks, tables preserved; script/style stripped)
- Per-hop 10s fetch timeout, 15s body read timeout, 50K character truncation limit
- Requires user approval for all requests

### File-Level Undo

The undo system captures file snapshots before each modification:

- Every `write_file` / `edit_file` creates a versioned backup in `~/.rivet/file-history/{sessionId}/`
- Backups are SHA-256 hashed filenames, up to 100 snapshots retained
- Orphaned backups (files not referenced by any snapshot) can be cleaned via `cleanupOrphans()`
- `undo` tool shows a preview (files changed, +/- lines) before restoring
- `undo confirm` restores files to their pre-modification state

### Worker Safety

Worker sessions enforce a timeout budget (`timeoutMs` from the work order) — if a worker runs too long, it is automatically aborted via `AbortController`. The batch dispatch respects `maxWorkers` concurrency (chunked by the limit, not unbounded).

### Attention Anchor Dispersal

Three-layer passive context injection prevents attention collapse during complex tasks:

- **Layer 1 — Recent commits**: `git log --oneline -5` injected as `<recent-commits>` in volatile context, giving the model awareness of recent project activity.
- **Layer 2 — Behavior mirror**: Detects repetition anti-patterns (same error recurring, same file edited 3+ times, edits without verification). Injected as `<behavior-mirror>` questions that prompt the model to reconsider its approach.
- **Layer 3 — Decision anchors**: Extracts decision statements from model output ("I'll use...", "approach:", "方案是"). Injected as `<decisions>` so the model can reference and build on its own prior choices across turns.

All three layers activate after turn 3 and are injected only in the fresh volatile block (not frozen prefix).

### Execution Resilience

The `TurnHarness` wraps all tool execution with automatic retry and trajectory recording:

- **Transient retry**: Network errors (ECONNRESET, ETIMEDOUT, etc.) and flaky failures are automatically retried up to `maxRetries` times (default: 2). Non-transient errors (type errors, assertions) fail immediately. Each `FailureClassification` now includes a `retryable` boolean for programmatic policy decisions.
- **Trajectory recording**: Every tool execution is recorded with duration, status, and error class. Stats are exposed via `agent.getTrajectoryStats()` and reflected in the SummaryBar step count.
- **Doom loop detection**: Tool call fingerprints are tracked via `TraceStore`. When identical calls repeat 2+ times (warn) or 3+ times (blocked), tool execution is blocked entirely — the tool returns an error without executing, forcing the agent to change strategy.
- **Strategy shift**: When doom-loop is detected, `suggestStrategyShift()` analyzes the trajectory for patterns (repeated failures, unverified writes, transient errors) and injects a `<strategy-shift>` suggestion into the volatile context, guiding the model toward a different approach.
- **Risk assessment**: `assessToolRisk()` evaluates doom loop level, path traversal, destructive commands, and write operations to produce a risk level (none/low/medium/high).
- **Task-state injection**: After turn 3, `extractTaskState()` derives completed/current/remaining steps from the trajectory and model text. This is injected as `<task-progress>` in the volatile context block, giving the model implicit awareness of its own progress.
- **Retry hint**: When all retries fail, a hint is appended: `[All N retries failed. Error class: X. Consider alternative approach.]`

### Sub-agent Evidence Contract

Sub-agent workers must return structured evidence in their `WorkerResult`:

- **evidenceStatus**: `verified | failed | blocked | unverified` — defaults to `unverified`. Implementation results that change files without running verification are automatically blocked by the aggregation layer.
- **changedFiles**: exact file paths modified by the worker
- **risks**: unresolved concerns or follow-up risks
- **verification**: command, status, scope, and exit code when tests were run

The aggregation `evidenceGate` blocks any worker result that changed files without verified evidence before any aggregation policy is applied.

### Model Routing

Rivet can automatically switch between models based on the inferred task type each turn:

- **Task inference**: `TaskInferrer` analyzes the last 10 tool calls to determine the current task type:
  - `code_edit` — when edit_file/write_file are used
  - `test_failure_diagnosis` — when run_tests shows failures
  - `risky_refactor` — when multiple files are edited and tests are run
  - `repo_summarization` — when search tools are used extensively (≥3 calls with no edits)
- **Model selection**: `recommendModelForTask()` scores available models against the task type using `ModelCapabilityCard` profiles
- **Routing visibility**: The routing reason is shown in the cockpit Model panel and injected into the volatile context as `<routing-reason>`
- **Metrics**: Routing events are tracked via `RoutingMetricsCollector` for diagnostics
- **Safety**: Model switching requires `getCurrentModel` to be configured; failures in the switch callback are non-fatal

### Repo Intelligence

Rivet builds a lightweight import graph to track code impact:

- **Import graph**: Regex-based static analysis of relative imports across the project (capped at 1000 files). Built lazily on first edit.
- **Impact hints**: After each `edit_file`/`write_file`, `generateImpactHint()` computes which files and tests are affected by the change. The hint is injected as `<impact-hint>` in the volatile context.
- **Evidence integration**: Impacted files and related tests are surfaced in the evidence badge via `trackImpact()`.
- **Invalidation**: The graph is incrementally updated when files change via `invalidateFile()`.

### Session Memory

Session memory survives across compaction. Use it to bookmark decisions or preferences:

- `/memory` — List all entries for the current session
- `/memory Always use pnpm for this project` — Save a note
- Memory entries are automatically injected into the volatile context block sent to the model
- Memory is reflected in the context ledger via `getSessionMemoryState()`

### Context Claims

Rivet automatically extracts context claims from tool results to maintain awareness across turns:

**Automatic extraction (no user action needed):**
- **File observations** — Every `read_file` creates a `file_observation` claim (30min TTL) tracking what files the agent has seen
- **Test failures** — `run_tests` failures create `failure_pattern` claims (2h TTL) so the agent remembers past breakages
- **Test passes** — Successful test runs create `verification_fact` claims (1h TTL)
- **Security findings** — `npm audit` or security-related output creates `security_finding` claims (4h TTL)

**Claim lifecycle:**
1. Claims start as `active` and are injected into every prompt
2. After 3 unique consumers → promoted to `durable_candidate`
3. After 5 unique consumers + 10 minutes → promoted to `durable`
4. **Durable claims survive session restart** — loaded with 0.9 confidence decay when you resume
5. Claims with file evidence are marked `stale` when the file is modified

**Budget control:** At most 20 claims are injected into the prompt, sorted by fitness (security > failure > verification > observation).

**Antibody detection:** Failure patterns create "antibody" claims that boost risk assessment on repeated failures, helping the agent avoid repeating mistakes.

**Conflict detection:** When two claims have contradictory file evidence for the same path, the older one is marked `conflicted` and excluded from the prompt.

Use `/context` to see current claims, `/context antibodies` for antibody claims, or `/context conflicts` for conflicted claims.

### Scrollback History

When output scrolls off screen, use `/scroll` to browse history:

- **j/k** or **↑/↓** — Scroll one line
- **PgUp/PgDn** or **b/Space** — Scroll one page
- **g** — Jump to top; **G** — Jump to bottom
- **q** or **Esc** — Close pager

The ScrollBuffer retains up to 500 entries. The Static display (terminal scrollback) caps at 100 items to prevent buffer overflow.

### Markdown and Diff Rendering

Tool output and model responses are automatically enhanced:

- **Markdown**: Headers, code blocks (with syntax highlighting for JS/TS/Python/Go/Rust/Bash), lists, blockquotes, tables, bold/italic/code/links
- **Diff**: Unified diff output is auto-detected and colorized — additions in green, deletions in red, file headers in yellow, hunk markers in gray

### Onboarding

On first run, Rivet shows an onboarding panel with setup guidance:

- Configure a provider key: `rivet config set-key <provider> <api-key>`
- Try `/help` for commands, `/model list` for models, `/mcp` for server status
- Run `/onboarding dismiss` when ready — this writes a sentinel to `~/.rivet/onboarding-dismissed`

Subsequent launches skip onboarding. The sentinel is separate from config existence, so you can wipe config without re-triggering onboarding.

### Slash Commands Quick Reference

| Command | What it does |
|---------|-------------|
| `/help` | Show all available commands |
| `/model list` | Show available models, current model, and cost |
| `/model <name>` | Switch to a different model |
| `/compact` | Compact conversation to free context space |
| `/debug cache` | Show detailed cache stats: hit rate, tokens, savings |
| `/debug fingerprint` | Show prompt fingerprint and drift detection |
| `/debug mcp` | Show MCP server connection details |
| `/debug prompt` | Show current system prompt preview |
| `/verbose` | Toggle between 20-line and 200-line tool output |
| `/rollback` | Preview changes since last checkpoint |
| `/rollback confirm` | Discard all changes since last checkpoint |
| `/undo` | Preview last file change undo (diff stats) |
| `/undo confirm` | Restore files to previous snapshot |
| `/sessions` | List saved sessions |
| `/resume <N>` | Restore a saved session |
| `/evidence` | Show last turn evidence (files read, modified, tests) |
| `/context` | Show context health, tokens, rounds, claims |
| `/context antibodies` | Show antibody claims (failure→risk boosters) |
| `/context conflicts` | Show conflicted file-evidence claims |
| `/memory` | List session memory entries |
| `/memory <text>` | Save a manual session memory entry |
| `/cockpit [summary\|trace\|verify\|context\|safety\|model\|mcp\|off]` | Toggle or switch cockpit panel (Esc to collapse) |
| `/clear` | Clear screen |
| `/scroll` | Browse output history (j/k/PgUp/PgDn/g/G/q/Esc) |
| `/onboarding dismiss` | Dismiss first-run onboarding guide |
| `/theme [pastel\|cyberpunk\|list]` | Switch color theme |
| `/onboarding dismiss` | Hide the first-run setup guide (persisted across sessions) |
| `/exit` | Save session and exit |

### How Cache Works

Rivet optimizes DeepSeek V4's prefix cache to minimize cost:

- **L1 System prompt** is frozen at startup and never changes → always hits cache
- **L2 Tool definitions** are stable-sorted → only changes when tools are added/removed
- **L4 Volatile context** (git status, cwd, .rivet.md) changes per turn but is isolated from the cached prefix

When you see `cache:98.7%` in green, it means 98.7% of input tokens were served from cache at 1/10 the normal price.

**Cache diagnostic notifications:**
- `💡 Compaction ran — message history restructured, partial cache miss expected` — Normal after context compaction
- `⚠️ Cache drift: system prompt + tool definitions changed — prefix invalidated` — Something changed the frozen prefix (unusual)
- `💡 Low cache hit (28%) — prefix may have been evicted` — Context too long, cache was evicted

### Custom Slash Commands

Define project-local slash commands in `.rivet/commands/`:

```bash
mkdir -p .rivet/commands
echo 'Review this code for bugs and suggest fixes:
$ARGUMENTS' > .rivet/commands/review.md
```

When you type `/review src/agent/loop.ts` in the TUI, `$ARGUMENTS` is replaced with `src/agent/loop.ts` and the resulting text is sent to the agent:

```
Review this code for bugs and suggest fixes:
src/agent/loop.ts
```

Command names must match `[A-Za-z0-9][A-Za-z0-9_-]*`. Non-markdown files, nested directories, and names with spaces are ignored. Built-in slash commands always take priority over custom commands.

### Project Configuration

Place a `.rivet.md` file in your project root. Its contents are automatically included as project instructions:

```markdown
# Project Instructions
- Use pnpm, not npm
- All tests must pass before committing
- Follow conventional commit format
```

### Auto-Checkpoint

Rivet automatically creates a git checkpoint before the first file modification each turn. If something goes wrong:

1. `/rollback` — Preview what would be discarded
2. `/rollback confirm` — Restore to the checkpoint (destructive)

### Session Persistence

Sessions are saved to `~/.rivet/sessions/`. On restart:

1. Rivet detects previous sessions
2. Press `r` to restore, or any key to start fresh
3. Use `/sessions` to list, `/resume <N>` to restore a specific one

### Cost Optimization Tips

- **Long sessions are cheap** — The longer you chat, the higher the cache hit rate
- **Avoid `/clear`** — Clearing logs doesn't clear context; use `/compact` instead
- **Use `run_tests`** — It's cheaper than running bash tests because output is compressed
- **Check `/debug cache`** — Monitor your savings in real-time

## Development

```bash
npm run typecheck              # tsc --noEmit
npm run test                   # Run all tests
npm run build                  # tsup build
npm run dev                    # Watch mode
```

## Open-Source Baseline

The public open-source version of this project lives at github.com/huiliyi37/Tianshu (`/Users/banxia/app/Tianshu`).

- **Baseline snapshot**: rivet `21dace8` → Tianshu `44a26b5` (2026-06-09)
- **Content**: `src/` + build config + 4 user-facing docs + completions; no internal design docs, session logs, star capsules, or task planning
- **License**: Apache-2.0
- **Iteration model**: Tianshu evolves independently from its baseline snapshot. Changes to the public repo are applied as new commits on top of the snapshot, not by re-exporting from rivet.

## Design Documents

- `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md` — Subagent orchestration: Cache-first Bounded Coordinator design
- `docs/superpowers/plans/2026-05-16-rivet-subagent-orchestration-implementation.md` — Phase 1-4 implementation plan
- `docs/superpowers/specs/2026-05-16-rivet-core-business-gap-review.md` — P0-P2 core business gap review (all gaps closed)
- `docs/superpowers/specs/2026-05-16-rivet-p2-model-mcp-repo-intel-design.md` — P2 design: Model Routing + MCP Integration + Repo Intelligence
- `docs/superpowers/specs/2026-05-15-rivet-p2-3-harness-cockpit-design.md` — P2.3 Harness Cockpit design
- `docs/superpowers/plans/2026-05-15-rivet-p2-3-harness-cockpit-implementation.md` — P2.3 implementation plan
- `docs/superpowers/plans/2026-05-15-rivet-p2-2-capability-reliability-layer.md` — P2.2 Capability Reliability Layer plan
- `docs/superpowers/specs/2026-05-15-rivet-open-model-terminal-agent-direction-design.md` — Strategic direction: Trust Cockpit + Open Model Capability Lab
- `docs/superpowers/specs/2026-05-16-tui-gap-closing-design.md` — TUI gap closing design: three-wave roadmap + architecture decisions
- `docs/superpowers/plans/2026-05-16-rivet-wave1-core-gaps.md` — Wave 1 implementation plan: permissions, cost display, headless, custom commands, onboarding
- `docs/superpowers/plans/2026-05-15-rivet-dev-capability-phase3.md` — Phase 3 implementation plan
- `docs/superpowers/plans/2026-05-15-rivet-p2.1-remaining.md` — P2.1 remaining tasks + execution record
- `docs/superpowers/plans/2026-05-15-rivet-performance-optimization.md` — Performance optimization plan
- `docs/analysis/2026-05-15-handoff.md` — Full project handoff document with validation records
- `docs/superpowers/plans/2026-05-16-rivet-gap-closing-hardening.md` — Gap closing hardening plan (hooks isolation, git log/stash, turndown, TodoStore, undo cleanup)
- `docs/superpowers/specs/2026-05-16-rivet-pastel-aesthetic-performance-memory-design.md` — Pastel theme + render perf + memory safety design (deep-brainstorm)
- `docs/superpowers/plans/2026-05-16-rivet-render-perf-memory-bounded-visual-polish.md` — Rendering perf + memory bounds + visual polish implementation plan (7 tasks)
- `docs/analysis/2026-05-16-pastel-theme-render-perf-memory-visual-polish.md` — Work record: pastel theme, ring buffer, bounded collections, sparkline, spinner
- `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md` — Core capability implementation status ledger (19 Verified, 1 Planned, 2 Designed)

## License

MIT
