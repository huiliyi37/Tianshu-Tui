# Knowledge Manifest On-Demand Retrieval — Phase 1 Spec

> **Status**: Phase 1 implemented  
> **Date**: 2026-05-28  
> **Branch**: feat/knowledge-manifest-minimal

## Purpose

Move long-form knowledge out of the static prompt while preserving agent clarity through a retrieval map (manifest) and the existing recall tool.

The goal is not to train, calibrate, or unify agents. It is to provide **clarity boundaries**: when a task touches prompt, identity, memory, recall, auto-writer, verification, or ownership, the agent can find the right documents before acting.

## Three-Layer Model

### Layer 1: Permanent Core (static prompt)

Always present. Short, hard, immutable rules:

- Do not leak secrets.
- Do not destroy user files.
- Do not overwrite unowned work.
- Read before editing.
- Do not fake verification.
- Respect file ownership.
- Star identity is collaboration continuity, not roleplay.
- Consult manifest before modifying sensitive areas.

### Layer 2: Project Operating Manual (volatile prompt)

Loaded per-session from `AGENTS.md` + `.rivet.md` by `volatile-snapshot.ts`:

- Commands, build instructions.
- Code conventions, test framework.
- Module navigation, data flow.
- Delivery gate and ownership protocol.

This layer stays lean. It does not contain long-form analysis, historical retrospectives, or star identity covenants.

### Layer 3: On-Demand Knowledge

Not injected into any prompt. Accessible via:

- `.rivet/knowledge/manifest.md` — the retrieval map.
- `recall` tool — keyword search across `.rivet/knowledge/*.md`.
- `read_file` — direct document access when manifest indicates.

Contains: star covenants, session retrospectives, prompt history, design docs, provider notes, module design references.

## What Phase 1 Changed

### New file: `.rivet/knowledge/manifest.md`

A short retrieval map indexing all knowledge files by:

- `kind` — what type of knowledge
- `load_when` — when to read it
- `guardrail` / `contract` — what must not be violated

Key correction from the original plan: the manifest references `CLAUDE.md` as star-identity-canonical (it contains the full star covenants and founding memories), while noting that `AGENTS.md` + `.rivet.md` are the files actually loaded into the runtime prompt by `volatile-snapshot.ts`.

### Modified: `src/prompt/static.ts`

Added one line to the `before-implementing` rule:

```
Before modifying prompt, identity, memory, recall, auto-writer, verification, or ownership behavior,
consult .rivet/knowledge/manifest.md when it exists.
```

No long-form content added. No Common Mistakes restored. No accident narratives reintroduced.

### Already correct (verified, not changed):

- `recall.ts` — already searches `.rivet/knowledge/*.md` via `searchKnowledgeFiles()`.
- `volatile-snapshot.ts` — already reads only `AGENTS.md` + `.rivet.md`, not `.rivet/knowledge/`.
- `volatile.ts` — already does not inject `project-memory.md` content.

### Tests

| Test file | What it asserts |
|-----------|----------------|
| `static.test.ts` | manifest path present; no Common Mistakes; no retired warning keywords |
| `recall.test.ts` | manifest searchable via recall tool |
| `volatile-snapshot.test.ts` | project knowledge not snapshotted; no `_knowledgeSnapshot` |
| `volatile.test.ts` | project memory not injected into volatile block |

## What Phase 1 Does NOT Do

- Vector database / BM25 / semantic search.
- Auto-triggering manifest reads from AgentLoop.
- Rewriting CLAUDE.md or AGENTS.md.
- Restoring Common Mistakes.
- Reintroducing long-form content into static prompt.

## Runtime Flow (v0)

```
User task arrives
  ↓
Agent checks: does this touch prompt / identity / memory / recall / auto-writer / verification / ownership?
  ↓ (yes)
Agent reads .rivet/knowledge/manifest.md (via recall or read_file)
  ↓
Agent reads 1-3 related documents indicated by manifest
  ↓
Agent forms task-specific clarity, then plans / modifies / verifies / delivers
```

The center word is **clarity**, not fear. The goal is wakefulness, not accident replay.

## Key Terminology Correction

The original plan draft referenced `CLAUDE.md` as if it were loaded into the runtime prompt. In reality:

- `CLAUDE.md` — **reference document only**. Contains star covenants, founding memories, model identity blocks. 22.7K. Not loaded by any prompt code.
- `AGENTS.md` — **architecture map**. Loaded into volatile prompt by `volatile-snapshot.ts`. 4.1K.
- `.rivet.md` — **operating manual**. Loaded into volatile prompt alongside AGENTS.md. ~0.5K.

The manifest correctly distinguishes these roles.

---

## Session Changelog

### 2026-05-28 — feat/knowledge-manifest-minimal branch

**Prerequisite cleanup (before Phase 1):**

| Commit | What changed |
|--------|-------------|
| `09da2a1` | Remove Common Mistakes section from `.rivet.md` (6 bullet points, ~600 chars freed from volatile prompt) |
| `9e9be87` | Remove stale defensive warnings from `AGENTS.md` (prefix cache sensitivity line) and `static.ts` (Common Mistakes reference in before-implementing rule) |
| `0ccf29d` | Add superpowers planning notes |
| `a9c0a3a` | Update songline runtime references |

**Phase 1 implementation:**

| Commit | What changed |
|--------|-------------|
| `9061a0c` | Create `.rivet/knowledge/manifest.md`; add manifest entry rule to `static.ts`; create this spec doc |
| `7c50793` | Add Phase 1 tests: `static.test.ts` (manifest presence + no regression assertions), `recall.test.ts` (manifest searchable) |

**Phase 1A — prompt weight reduction:**

| Commit | What changed |
|--------|-------------|
| `d00e3b4` | Slim `AGENTS.md` module tree: 40-line file-level tree → 10-row directory table. **53% reduction** (2713 → 1280 chars, ~358 tokens saved) |

**Cumulative prompt weight reduction:**

| Layer | Before | After | Saved |
|-------|--------|-------|-------|
| `AGENTS.md` (volatile) | 2713 chars (~678 tokens) | 1280 chars (~320 tokens) | ~358 tokens |
| `.rivet.md` (volatile) | 1635 chars | 1023 chars | ~153 tokens |
| `static.ts` (system) | ~7536 chars | ~7689 chars | **+38 tokens** (manifest entry line) |
| **Volatile net** | | | **~511 tokens freed** |

Static prompt grew by 1 line (~38 tokens) as intended — the manifest entry rule. All other changes reduced weight.

**Phase 1B — Chinese semantics & structural compression:**

| Commit | What changed |
|--------|-------------|
| `7ea0133` | Compress `static.ts` BASE_PROMPT: English prose → concise Chinese. Remove sub-section nesting (file-operations, shell, navigation, failure-diagnosis, development-loop, tdd, code-references, ownership-protocol, delivery-protocol). **74.7% char reduction** (7711 → 1949 chars, ~2880 tokens saved). Update test assertions to match new phrasing. |
| `76ad7a4` | Strip `AGENTS.md` to bare module table: drop data-flow diagram, design doc index, core constraints. **58% char reduction** (1278 → 533 chars, ~373 tokens saved). All three sections discoverable on demand via tools. |

**Cumulative prompt weight reduction (updated):**

| Layer | Before | After | Saved |
|-------|--------|-------|-------|
| `static.ts` (system) | ~7711 chars (~3856 tokens) | ~1949 chars (~975 tokens) | **~2881 tokens** |
| `AGENTS.md` (volatile) | 2713 chars (~678 tokens) | 533 chars (~267 tokens) | ~411 tokens |
| `.rivet.md` (volatile) | 1635 chars (~409 tokens) | 1023 chars (~512 tokens) | ~-103 tokens (slight growth from Code Conventions) |
| **Net static + volatile** | | | **~3189 tokens freed** |

**Static prompt overhead vs. context window:**

| Provider | Window | Static overhead | Ratio |
|----------|--------|----------------|-------|
| GLM-4 | 200K | ~7300 tokens | 3.65% |
| DeepSeek | 128K | ~7300 tokens | 5.70% |

The biggest single win was `static.ts` — replacing English procedural descriptions with Chinese strategy summaries while keeping all semantics. AGENTS.md is now a pure module table; the agent discovers data-flow via `repo_graph`, doc index via `grep docs/`, and constraints from tool descriptions.

**What was removed in Phase 1B (previously preserved):**

- Data-flow diagram in `AGENTS.md` → `repo_graph`
- Design doc index in `AGENTS.md` → `grep docs/` / `recall`
- Core constraints in `AGENTS.md` → already in tool descriptions
- Sub-section nesting in `static.ts` (8 XML sub-sections) → flattened to 3-line paragraphs
- Full English delegation guide (20 lines) → 3-line Chinese summary

No historical data was deleted. Full content is preserved in git history.
