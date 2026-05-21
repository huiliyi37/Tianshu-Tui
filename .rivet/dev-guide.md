# 天枢开发指南

本文档是天枢 TUI 项目的内部开发文档。不随产品发布。模型在开发天枢本身时按需读取。

## Architecture

```
src/
├── main.tsx              CLI entry: config → tools → prompt engine → agent → TUI
├── agent/
│   ├── loop.ts           Agent loop: LLM call → tool execution → repeat
│   ├── context.ts        Session state (messages, usage, turn count)
│   ├── checkpoint.ts     Per-project git checkpoint + rollback
│   ├── evidence.ts       File tracking + test result badge
│   ├── failure-classifier.ts  Test failure categorization + fix suggestions
│   └── session-persist.ts     JSONL session persistence (~/.rivet/sessions/)
├── api/
│   ├── client.ts         Streaming API with retry (exp backoff 1s/2s/4s)
│   ├── deepseek.ts       DeepSeek V4 usage field mapping
│   ├── provider.ts       ProviderCapabilities abstraction
│   ├── sse.ts            SSE parser
│   └── types.ts          Message, ContentBlock, Usage, ToolDefinition
├── prompt/
│   ├── engine.ts         PromptEngine: frozen system prompt + volatile context
│   ├── static.ts         System prompt builder (this file's behavior contract)
│   ├── volatile.ts       Volatile context: .rivet.md, git status, working set
│   ├── volatile-git.ts   Non-blocking git status with stale cache
│   ├── fingerprint.ts    SHA-256 cache drift detection
│   └── cache-diagnostic.ts  Cache miss reason analysis
├── tools/
│   ├── bash.ts / edit.ts / read-file.ts / write-file.ts  Core file I/O
│   ├── grep.ts / glob.ts       Code search
│   ├── diff.ts / run-tests.ts  Verification (both use three-layer output)
│   ├── inspect-project.ts / repo-map.ts / related-tests.ts  Project understanding
│   ├── output-store.ts         Three-layer: raw→disk, compressed→LLM, summary→TUI
│   ├── registry.ts             Tool registration + approval gating
│   └── truncation.ts / path-validate.ts / process-tracker.ts  Utilities
├── compact/
│   ├── auto.ts           800K threshold, 500K floor
│   ├── micro.ts          Micro-compact: Tier 1 tool_result truncation + Tier 2 round removal
│   └── constants.ts      Percentage-based thresholds (8K–1M), cache anchor count
├── context/
│   ├── compact-policy.ts  Ratio-based progressive compaction (0.6/0.78/0.88/0.95 tiers)
│   ├── anchor-registry.ts Pinned structural anchors with budget enforcement
│   ├── persistent-store.ts Cold-storage archive/search with disk limit
│   ├── pressure-monitor.ts PSI-style pressure/thrashing detection
│   └── proactive-inject.ts Anchor-to-XML active-constraints injection
├── config/
│   ├── schema.ts         Zod config schema
│   └── manager.ts        CLI config manager (rivet config <cmd>)
└── tui/
    ├── app.tsx            Main app: slash commands, approval, render batching
    ├── tool-card.tsx      Tool execution display (rawPath links)
    ├── status-bar.tsx     Model, cache rate, cost, token bar
    ├── stream.tsx / thinking.tsx  Streaming output + thinking blocks
    └── log-state.ts       LogEntry types + state management
```

## Files to Read First

| Task | Files to read |
|------|--------------|
| Add a tool | `src/tools/types.ts` → `src/tools/registry.ts` → an existing tool like `src/tools/grep.ts` → `src/main.tsx` (register) → `src/prompt/static.ts` (tool list) |
| Change system prompt | `src/prompt/static.ts` → `src/prompt/engine.ts` → `src/prompt/volatile.ts` |
| Fix agent loop behavior | `src/agent/loop.ts` → `src/agent/context.ts` → `src/tui/app.tsx` |
| Fix TUI rendering | `src/tui/app.tsx` → `src/tui/log-state.ts` → relevant component file |
| Fix API/streaming | `src/api/client.ts` → `src/api/sse.ts` → `src/api/deepseek.ts` |
| Fix tool output display | `src/tools/output-store.ts` → `src/tui/tool-card.tsx` → tool file |
| Fix compaction | `src/context/compact-policy.ts` → `src/compact/micro.ts` → `src/agent/loop.ts` |
| Fix context/anchors | `src/context/anchor-registry.ts` → `src/context/proactive-inject.ts` → `src/agent/loop.ts` |
| Fix cold storage/recall | `src/context/persistent-store.ts` → `src/tools/recall.ts` → `src/agent/loop.ts` |
| Fix config/CLI | `src/config/schema.ts` → `src/config/manager.ts` → `src/main.tsx` |

## Active Feature: Subagent Orchestration (P2.4)

Design doc: `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md`

Final design: **Cache-first Bounded Coordinator** (V2+V3). Primary AgentLoop decomposes tasks into typed WorkOrders, headless WorkerSessions execute with independent SessionContext, results return as schema-valid WorkerResult packets.

### Key Runtime Seams

| Seam | File | Why it matters |
|------|------|---------------|
| AgentCallbacks | `src/agent/loop.ts` | Narrowest lifecycle bridge between AgentLoop and outside world |
| Tool.isConcurrencySafe() | `src/tools/types.ts` | Exists but never wired to runtime |
| SessionContext (mutable push) | `src/agent/context.ts` | Cannot be shared across workers |
| ModelCapabilityCard | `src/model/capability.ts` | recommendModelForTask() exists as pure function |
| EvidenceTracker | `src/agent/evidence.ts` | Can extend to coordinator-level facts ledger |

### Phase 1 Hard Constraints

1. **SessionContext isolation is mandatory** — worker messages must never enter primary session
2. **Read-only workers only** — tool allowlist: `read_file`, `grep`, `glob`, `diff`, `inspect_project`, `repo_map`, `related_tests`
3. **Schema-valid results** — every WorkerResult must pass zod validation
4. **Primary authority** — only the primary AgentLoop decides final actions
5. **Prefix cache preservation** — workers share the same system prompt
6. **Budget gate** — tasks completable in 1-2 tool calls should NOT be dispatched

## Active Feature: Adaptive Context Fabric (ACF)

Design doc: `docs/superpowers/specs/2026-05-16-adaptive-context-fabric-design.md`

### Hard Constraints

1. **Zero overflow** — 128K–1M windows must never exceed contextWindow
2. **DeepSeek 99% cache hit** — first 2 messages never change (CACHE_ANCHOR_MESSAGES=2)
3. **No prompt/cache path modification** — compact/context changes must not alter `src/prompt/*` stable fingerprint
4. **Compaction preserves API invariants** — no broken tool_use/tool_result pairs
5. **Anti-thrashing** — 3+ compactions in 4-turn window → task_decomposition suggestion

## Concurrent Session Rules

When two Rivet sessions operate on the same repo simultaneously:

### Branch Naming
- Main session: `main` or `feat/main-<feature>`
- Secondary session: `feat/tianshu-<feature>` (never checkout `main`)

### File Ownership
| Session | Primary scope | Secondary (consult only) |
|---------|--------------|--------------------------|
| Main (`main`) | `src/agent/*`, `src/tui/app.tsx`, `docs/*` | `src/api/*`, `src/config/*` |
| 天枢 (`tianshu-*`) | `src/api/*`, `src/config/*`, `src/tui/*` (except `app.tsx`) | `src/agent/*`, `docs/*` |

### Git Protocol
- Main session owns merges to `main`
- Secondary session pushes feature branches, not merges
- If a file is modified in both sessions, secondary stashes and lets main commit first, then rebases
