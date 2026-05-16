# Changelog

## 2026-05-16 — Capability Ledger Audit + Documentation Update

### Changed

- **Capability ledger audit**: 4 capabilities upgraded from Planned → Verified after codebase verification confirmed full implementation:
  - **P1 Remaining Gaps** — CockpitSnapshot aggregator, doom-loop strategy shift (4 pattern detectors), MCP tool risk rules in approval-risk
  - **Performance Optimization** — Non-blocking volatile-git stale cache, TUI log batching, incremental token accounting, smartCompact wired in main.tsx
  - **Capability Reliability Layer** — Path validation (path-validate.ts), checkpoint v2 (dirty snapshot + confirmation token + agent-owned files), safe output filenames (SHA-256), glob/grep cwd boundary + symlink cycle protection, run_tests safe argv filter, VerificationMetadata
  - **Harness Cockpit** — TraceStore, approval-risk assessment, 6 cockpit panels (trace/verify/context/safety/model/mcp), CockpitRail with status indicators, ModelCapabilityCard

### Updated

- Capability ledger: 18 Verified (was 14), 1 MVP, 1 Planned (Cache Safety), 2 Designed. 694 tests.
- README status line: 694 tests, 18 Verified capabilities, all P0-P2 gaps closed.
- CHANGELOG.md created.

### Known Remaining

- **Cache Safety** (Planned, 0/30) — prewarm bypasses read_file safety boundary, cache key not canonical, volatile cache not per-cwd isolated, fingerprint doesn't cover volatile block
- **Cockpit Techstyle** (MVP, 42/43) — one checklist item unchecked
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
