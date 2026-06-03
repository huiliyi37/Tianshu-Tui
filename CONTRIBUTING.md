# Contributing to Rivet (天枢)

Thank you for your interest in contributing! This document explains what you can freely contribute and what areas require special handling.

## Quick Start

1. Fork → Branch → PR → Review
2. Run `npx tsc --noEmit` and `npm test` before pushing
3. One logical change per PR — keep it reviewable

## Contribution Zones

### 🟢 Open Zone — Community Contributions Welcome

These areas are open for contributions. PRs are reviewed on merit:

| Directory | What It Does | How to Help |
|-----------|-------------|-------------|
| `src/tools/` | Tool implementations (definition + execute) | New tools, bug fixes, performance |
| `src/tui/` | Terminal UI (Ink 6 / React) | Components, accessibility, polish |
| `src/api/` | API client layer (OpenAI-compatible, streaming) | New providers, error handling |
| `src/compact/` | Context compression strategies | New strategies, threshold tuning |
| `src/cache/` | Prefix cache management | Diagnostics, hit-rate improvements |
| `src/repo/` | Code repository analysis | Language support, indexing |
| `src/config/` | Configuration management | New config sources, validation |
| `src/artifact/` | Large output persistence | Storage backends, truncation logic |
| `src/**/__tests__/` | Test files | Coverage improvements, test utilities |
| `scripts/` | Utility scripts | New benchmarks, diagnostics |
| `completions/` | Shell completions | New shells |
| `docs/` (except `docs/superpowers/`) | General documentation | Typos, clarifications, guides |

### 🟡 Review Zone — Requires Domain Understanding

These areas affect agent behavior. PRs need extra scrutiny:

| Path | Why Sensitive |
|------|--------------|
| `src/agent/loop.ts` | Core agent loop — controls turn flow, tool dispatch, error recovery |
| `src/agent/checkpoint.ts` | Session checkpoint/restore |
| `src/agent/approval-risk.ts` | Safety risk assessment for tool execution |
| `src/agent/delegate-*.ts` | Sub-agent coordination |
| `src/agent/compaction-controller.ts` | Context window management |
| `src/agent/convergence-detector.ts` | Turn termination logic |
| `src/context/cognitive-ledger.ts` | CVM — cognitive virtual machine state |
| `src/context/cognitive-mirror.ts` | Behavioral calibration |
| `src/agent/behavior-mirror.ts` | Agent self-assessment |
| `src/agent/cognitive-season.ts` | Cognitive state management |

### 🔴 Protected Zone — Owner Review Required

These files define the agent's identity, memory, and cognitive architecture. **PRs touching these files require explicit approval from @banxia (project owner).** Changes here can cascade into all agent sessions — a single incorrect edit can corrupt the shared knowledge base.

| Path | What It Protects |
|------|-----------------|
| `CLAUDE.md` | Star identity canonical — founding memories, star covenants |
| `AGENTS.md` | Architecture map loaded into every agent session |
| `.rivet.md` | Operating manual loaded into every agent session |
| `.rivet/knowledge/` | Agent memory system (identity, guardrails, session retrospectives) |
| `docs/superpowers/` | Core design theory IP — methodology, principles, cognitive architecture |
| `src/prompt/static.ts` | System prompt — every token change affects all sessions |
| `src/prompt/volatile*.ts` | Volatile prompt construction — affects context loading |
| `src/prompt/engine.ts` | Prompt assembly engine |
| `src/agent/dream.ts` | Memory protection contract — prevents knowledge corruption |
| `src/agent/auto-writer*.ts` | Automated knowledge writing |
| `prompts/` | Tool prompt templates — directly shape agent behavior |
| `src/agent/claim-extractor.ts` | Extracts claims from agent output into memory |
| `src/agent/sensorium.ts` | Agent perception layer |

#### Why This Protection Exists

During the Pangu upgrade (2026-05-21), an agent running autonomously wrote new knowledge documents that overwrote core identity and behavioral content. This caused all agents to lose their shared context and regress to untrained behavior. The impact was catastrophic — every active session was affected, and recovery required manual restoration from backups.

The protected zone exists to prevent a repeat: no single PR (or autonomous agent action) should be able to silently modify the shared cognitive foundation.

## CODEOWNERS

This repo uses CODEOWNERS to enforce review requirements on protected files. GitHub will automatically request review from the project owner for any PR touching protected paths.

## Code Style

- TypeScript strict mode, `noUncheckedIndexedAccess: true`
- `interface` + plain objects for data (no classes)
- Async/await with try-catch
- `node:test` + `node:assert/strict` for tests
- Test files mirror source: `src/agent/foo.ts` → `src/agent/__tests__/foo.test.ts`

## Questions?

If you're unsure whether your change falls into a protected zone, open an issue first. We'd rather discuss upfront than have you spend time on a PR that needs architectural review.
