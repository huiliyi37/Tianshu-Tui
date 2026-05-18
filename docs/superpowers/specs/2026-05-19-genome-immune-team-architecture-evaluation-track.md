# Genome-Immune Team Architecture — Future Evaluation Track

> Date: 2026-05-19  
> Status: **Evaluating / Future Architecture**  
> Current Phase: **Not required for current delivery**  
> Runtime Policy: **Shadow mode only until validated**  
> Purpose: 将 Genome-Immune Team Architecture 标注为未来规划评估项，避免被误读为当前阶段必须实施的主线任务。

---

## Decision

Genome-Immune Team Architecture is accepted as a promising long-term direction for Rivet, but it should **not** be implemented as a current-phase runtime feature.

Current recommendation:

1. Keep the architecture as a future evaluation track.
2. Do not wire Genome / Score Translation / Surgical Pause / Self-Bid into the primary runtime path yet.
3. Start with shadow-mode data collection and offline reports.
4. Preserve current hard constraints: read-only workers, primary authority, schema-valid WorkerResult packets, prefix cache preservation, and budget gate.

---

## Why This Is Not Current-Phase Mandatory Work

Rivet’s current subagent architecture still has hard boundaries:

- Workers are read-only in Phase 1.
- Worker messages must never enter the primary session.
- Only compressed WorkerResult packets return to the primary loop.
- The primary AgentLoop remains the only authority for final actions.
- Worker prompts must preserve prefix-cache behavior and avoid custom system prompts.
- Tasks completable in 1–2 tool calls should not be dispatched.

The Genome-Immune plans contain several future-facing ideas, especially staging and merge checks for write-capable workers. Those are valuable, but they should not be treated as current implementation requirements.

---

## Architecture Elements Under Evaluation

| Element | Status | Current Recommendation |
|---|---|---|
| Role Genome | Promising | Collect candidate lessons only; no prompt injection yet |
| Immune Check | Promising | Run offline against candidate lessons; report conflicts |
| Score Translation | Promising but risky | Keep as design; later inject only into worker volatile context |
| Surgical Pause | High value | Start with read-only WorkerResult provenance/conflict report |
| Self-Scoring Bid | Future | Compute shadow bids only; do not affect routing |
| Pheromone Space | Future | Defer until role genome has enough data |
| Star Chart | Identity layer | Use for naming/docs/git identity; do not bind to runtime yet |

---

## Recommended Evaluation Phases

### Phase E0 — Documentation and Boundary Alignment

Goal: clarify how this architecture relates to existing Rivet systems.

Tasks:

- Define boundaries between GenomeStore, ClaimStore, Playbook, SessionMemory, and PersistentStore.
- Document which runtime paths are forbidden in the current phase.
- Mark all implementation plans as future/evaluation unless explicitly promoted.

Exit criteria:

- Team agrees on memory ownership boundaries.
- No plan implies worker write capability under current read-only constraints.

### Phase E1 — Shadow Genome Candidates

Goal: collect possible role lessons without using them in prompts or routing.

Tasks:

- Define `GenomeBullet` / candidate schema.
- Extract candidate lessons only from evidence-backed or verified outcomes.
- Store candidates in a non-runtime path.
- Generate review reports: duplicates, conflicts, quality issues, provenance.

Exit criteria:

- 50+ candidate lessons collected.
- Manual review shows useful lesson rate above an agreed threshold.
- No candidate is automatically injected into primary or worker prompts.

### Phase E2 — Read-Only Surgical Pause Report

Goal: improve multi-worker trust without introducing write-worker semantics.

Tasks:

- Add provenance checks for WorkerResult packets.
- Detect conflicting findings between workers.
- Check evidence status before aggregation.
- Produce a report for the primary agent and TUI.

Explicitly out of scope:

- changedFiles-based staging for worker writes.
- commit/reject merge semantics.
- automatic file modification by workers.

Exit criteria:

- Report catches at least one real or seeded conflict.
- Aggregation remains primary-controlled.

### Phase E3 — Shadow Self-Bid

Goal: measure whether role genome can predict suitable workers.

Tasks:

- Compute self-score bids offline.
- Compare bid output with current routing and human expectations.
- Track calibration: predicted confidence vs actual verified success.

Exit criteria:

- Shadow bid has meaningful correlation with task success.
- Fallback behavior is well-defined when confidence is low.

### Phase E4 — Controlled Worker Prompt Injection

Goal: inject only high-confidence, evidence-backed role lessons into worker volatile context.

Prerequisites:

- Candidate lessons have been reviewed or evidence-gated.
- Token budget limits exist.
- Prompt injection does not modify static prompt or tool definitions.
- Feature flag can disable the behavior.

Exit criteria:

- Measurable improvement in worker success or reduced tool calls.
- No prompt/cache regression.

### Phase E5 — Write-Capable Worker Safety

Goal: only after write-capable workers are intentionally introduced, implement full Surgical Pause.

Prerequisites:

- Worker write scopes are explicit.
- checkpoint v2 / touched-file boundaries are integrated.
- rollback and delivery gate are enforced.
- TUI approval and conflict visibility exist.

---

## Non-Goals for Current Phase

The following should be explicitly treated as **not current-phase work**:

- Active Genome injection into primary session.
- Automatic role-based routing from Self-Bid.
- Worker write staging and merge.
- Role emergence or automatic creation of new runtime agents.
- Pheromone-based coordination affecting execution.
- Star Chart runtime scheduling.
- Any change to stable system prompt or cache anchor behavior.

---

## Implementation Guidance If Promoted Later

If the team later promotes this track into implementation, follow these rules:

1. Start with tests and schema validation.
2. Keep all new memory entries provenance-backed.
3. Prefer append-only candidate logs before active memory.
4. Make runtime influence feature-flagged and reversible.
5. Inject only into volatile worker context, never static prompt.
6. Treat verified evidence as the only source of success increments.
7. Preserve primary authority over all final actions.

---

## Success Metrics

Suggested metrics for evaluation:

| Metric | Target Before Runtime Adoption |
|---|---|
| Candidate lesson usefulness | > 60% human-approved |
| Conflict detection | Finds real or seeded contradictions |
| Shadow bid alignment | > 60% agreement with human/current routing |
| Prompt overhead | Within fixed worker-token cap |
| Cache stability | No static prompt/cache-anchor changes |
| Safety | No worker messages enter primary session |

---

## Summary

Genome-Immune Team Architecture should remain on the roadmap as a serious future direction. It is strategically valuable because it could make Rivet’s multi-agent system learn across sessions without memory pollution.

However, the current stage should focus on evaluation, evidence collection, and read-only safety reporting. The architecture should not yet become a mandatory implementation track or alter the primary runtime behavior.

Recommended label:

> **Evaluating — Future Architecture, not required for current phase.**
