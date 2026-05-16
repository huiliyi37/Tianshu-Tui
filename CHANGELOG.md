# Changelog

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
