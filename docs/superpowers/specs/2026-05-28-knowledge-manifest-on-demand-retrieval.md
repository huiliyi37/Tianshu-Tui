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
