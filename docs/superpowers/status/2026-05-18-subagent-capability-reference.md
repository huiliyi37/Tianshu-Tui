# Subagent Orchestration — Capability Reference

**Status:** 全部完成 ✅  
**Design:** `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md`  
**Wiring:** `docs/superpowers/specs/2026-05-16-rivet-wave7-subagent-wiring-design.md`  
**Closure:** `docs/superpowers/status/2026-05-19-wave7-closure.md`  
**Commits:** `afab63b` + `17d57ce` + `3336297`

---

## Ability

Primary Agent (v4-pro) can delegate bounded tasks to headless worker subagents running independently on cheaper or same-tier models. Workers execute in isolated sessions with tool allowlists and return schema-validated result packets. Primary agent receives only compressed summaries — worker messages never pollute the primary context window.

## Decision Flow

```
User asks for: "find all uses of AgentCallbacks across the project"
                          │
                          ▼
  ┌──── should I delegate? ──────────────────────────────┐
  │                                                       │
  │  objective ≥ 6 words?  OR  scope.files ≥ 2?          │
  │  OR  scope.symbols ≥ 2?                               │
  │                                                       │
  ├── NO ──→ do it myself (1-2 direct tools)             │
  │                                                       │
  └── YES ──→ pick kind + profile + model                │
                    │                                      │
                    ▼                                      │
  kind: code_search/doc_research/plan → repo_summarization
  kind: review/patch_proposal          → risky_refactor
  kind: verify                         → test_failure_diagnosis
                    │
                    ▼
  profile: code_scout/doc_scout/planner/reviewer → READ_ONLY
  profile: patcher/verifier                       → WRITE
                    │
                    ▼
  task→routing lookup:
    repo_summarization      → cheap  → v4-flash
    code_edit               → capable → v4-pro
    test_failure_diagnosis  → capable → v4-pro
    risky_refactor          → capable → v4-pro
```

## Tools

### delegate_task

```json
{
  "objective": "Find all imports of AgentCallbacks across src/",
  "kind": "code_search",
  "profile": "code_scout",
  "files": ["src/agent/loop.ts"],
  "symbols": ["AgentCallbacks"]
}
```

| Field | Required | Values |
|-------|----------|--------|
| objective | ✅ | Specific, bounded goal |
| kind | ❌ (default: code_search) | code_search, doc_research, plan, review, verify, patch_proposal |
| profile | ❌ (default: code_scout) | code_scout, doc_scout, planner, reviewer, verifier, patcher |
| files | ❌ | File paths to scope search |
| symbols | ❌ | Symbol names to scope search |

### delegate_batch

```json
{
  "tasks": [
    { "objective": "grep AgentCallbacks in src/agent" },
    { "objective": "review coordinator.ts for risk patterns" },
    { "objective": "find all imports of work-order.ts" }
  ],
  "policy": "primary_decides"
}
```

| Field | Required | Values |
|-------|----------|--------|
| tasks | ✅ | Array of 2–5 task objects (same shape as delegate_task) |
| policy | ❌ (default: primary_decides) | primary_decides, all_required, first_success, majority |

## Kinds & Profiles

| Kind | CapabilityTask | Typical Profile | Typical Model |
|------|---------------|-----------------|---------------|
| code_search | repo_summarization | code_scout | v4-flash |
| doc_research | repo_summarization | doc_scout | v4-flash |
| plan | repo_summarization | planner | v4-flash |
| review | risky_refactor | reviewer | v4-pro |
| verify | test_failure_diagnosis | verifier | v4-pro |
| patch_proposal | code_edit | patcher | v4-pro |

| Profile | Tool Set | Max Turns |
|---------|----------|-----------|
| code_scout, doc_scout, planner, reviewer | read_file, grep, glob, diff | 4 |
| verifier | read_file, grep, glob, diff, run_tests | 8 |
| patcher | read_file, grep, glob, diff, edit_file, write_file, bash, run_tests | 8 |

## Worker Result Schema

```json
{
  "workOrderId": "wo_<uuid>",
  "status": "passed | failed | blocked | escalated",
  "summary": "one sentence summary",
  "findings": [
    { "claim": "evidence-backed claim", "evidence": "file:line", "confidence": "low | medium | high" }
  ],
  "artifacts": [
    { "kind": "note | patch | test_command | risk | question", "title": "", "content": "" }
  ],
  "patchSummary": "optional: describe all changes made",
  "changedFiles": [],
  "risks": [],
  "nextActions": [],
  "evidenceStatus": "verified | failed | blocked | unverified"
}
```

## Isolation Guarantees

| Boundary | Mechanism |
|----------|-----------|
| SessionContext | Independent `new SessionContext()` per worker |
| Tool allowlist | `filterToolRegistry()` by profile (READ_ONLY vs WRITE) |
| Context pollution | Only compressed `<worker_results>` packet enters primary |
| Knowledge flow | Worker findings → `claimStore.propose()` → `worker_finding` claims |
| Prefix cache | Workers share primary system prompt + tool definitions |

## Failure Handling

| Stage | Mechanism |
|-------|-----------|
| JSON parse failure | Repair prompt retry (up to `maxRetries`) |
| Repair exhausted | `buildBlockedWorkerResult()` — blocked status |
| Consecutive failures ≥3 | `CoordinatorState.shouldEscalate()` → escalated status |
| Evidence gate | `changedFiles` without `verified` evidence → blocked |
| Worker timeout | `order.budget.timeoutMs` → `agent.abort()` |

## Concurrency

| Setting | Value |
|---------|-------|
| maxWorkers | 3 |
| isConcurrencySafe | true (both tools) |
| delegateBatch queue | `WorkOrderQueue` with dedup + dependency ordering + concurrency control |

## Worker Prompt

Workers receive a structured prompt built by `buildWorkerPrompt()`:

```
You are a headless read-only Rivet worker.
WorkOrder ID: wo_xxx
Kind: code_search
Profile: code_scout
Objective: ...
Scope: {"files":[...], "symbols":[...]}
Constraints: ...
Allowed tools: read_file, grep, glob, diff
Disallowed tools: bash, write_file, edit_file, run_tests, delegate_task
Do not call disallowed tools. Do not claim that files were changed.
Return exactly one JSON object and no prose outside the object.
```

## TUI Display

| Element | delegate_task | delegate_batch |
|---------|:---:|:---:|
| Phase tracker | Delegating… | Delegating… |
| Activity status | Delegating {objective} | Delegating {objective} |
| Tool label | objective (trunc 50) | batch N tasks |
| Color | warning (yellow) | warning (yellow) |
| Glyph | ▶ | ▶ |

## Config

```jsonc
// Default in src/config/default.ts
{
  "workers": {
    "profiles": {
      "cheap": { "provider": "deepseek", "model": "deepseek-v4-flash" },
      "capable": { "provider": "deepseek", "model": "deepseek-v4-pro" }
    },
    "routing": {
      "repo_summarization": "cheap",
      "code_edit": "capable",
      "test_failure_diagnosis": "capable",
      "risky_refactor": "capable"
    }
  }
}
```

Override in `~/.rivet/config.json` to route workers to different providers/models.

## File Map

| Component | File |
|-----------|------|
| Types & schemas | `src/agent/work-order.ts` |
| Coordinator | `src/agent/coordinator.ts` |
| Coordinator state | `src/agent/coordinator-state.ts` |
| Worker session | `src/agent/worker-session.ts` |
| Worker prompts | `src/agent/worker-prompts.ts` |
| Aggregation | `src/agent/aggregation.ts` |
| Evidence gate | `src/agent/worker-evidence.ts` |
| Work queue | `src/agent/work-queue.ts` |
| Session fork | `src/agent/session-fork.ts` |
| delegate_task tool | `src/tools/delegate-task.ts` |
| delegate_batch tool | `src/tools/delegate-batch.ts` |
| Model selection | `src/model/capability.ts` |
| System prompt | `src/prompt/static.ts` (delegation section) |
| TUI display | `src/tui/phase-tracker.ts`, `activity-status.ts`, `agent-status.tsx`, `theme.ts`, `tool-family.ts` |
| Registration | `src/main.tsx` |

## Next (Wave 8+ Candidates)

- Brain/Hands separation: Brain only holds delegate_task + think, Hands executes concrete tools
- Git worktree isolation: write workers in independent worktrees, diff flows back
- Worker-to-worker shared knowledge base (read-only session-memory projection)
- Adaptive routing: coordinator learns which models perform best per task type over time
