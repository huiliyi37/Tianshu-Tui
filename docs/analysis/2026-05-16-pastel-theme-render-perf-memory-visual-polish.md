# Pastel Theme + Rendering Performance + Memory Bounds + Visual Polish

> Work record: 2026-05-16

## Overview

Implemented Phase 1-3 of the pastel aesthetic design: theme system refactor, rendering optimization, memory safety, and visual polish. Executed via subagent-driven development (7 tasks, each with fresh implementer subagent).

## Commits

| Commit | Task | Description |
|--------|------|-------------|
| `5182a12` | Phase 1 | Pastel theme + /theme switch + deep-brainstorm design doc |
| `3016d1f` | Task 1 | Cockpit snapshot `useMemo` — prevents per-render rebuild |
| `bc02b04` | Task 2 | Ring buffer (cap 500) — replaces O(n) pushStatic copy |
| `f5fb363` | Task 3 | SessionContext bounded collections (cap 500) |
| `5e6b37c` | Task 4 | Braille sparkline + tokenHistory in SummaryBar |
| `2dcb611` | Task 5 | Gradient banner uses active theme colors |
| `3466a54` | Task 6 | Braille spinner animation in AgentStatus |
| `51e7486` | Task 7 | README update + final validation |
| `2bffc47` | Review fix | Braille encoding, theme color, JSX indentation |

## Architecture Changes

### Theme System (`src/tui/theme.ts`)

Refactored from single hardcoded palette to multi-theme registry:
- `ThemeName` type: `'pastel' | 'cyberpunk'`
- `setTheme(name)` / `getActiveThemeName()` for runtime switching
- `getTheme()` returns the active theme's truecolor or fallback variant
- Pastel is default; cyberpunk preserved as switchable legacy

Pastel palette: `#a8e6cf` mint, `#d4a5f5` lavender, `#b5ead7` soft green, `#ffdac1` warm peach, `#ff9aa2` coral pink, `#8585a0` soft gray.

### Rendering Optimization

1. **Cockpit snapshot memoization** — `buildCockpitSnapshot()` wrapped in `useMemo` in `CockpitView`. Previously rebuilt every render, defeating `memo()` on child panels.

2. **Ring buffer** — New `src/tui/ring-buffer.ts` with `createRingBuffer<T>(cap)`. Replaces `setStaticItems(prev => [...prev, entry])` (unbounded O(n)) with capped ring buffer.

3. **Theme-aware gradient banner** — Startup banner uses `[theme.primary, theme.secondary]` instead of hardcoded cyberpunk hex.

### Memory Safety

SessionContext collections capped at 500 entries:
- `filesRead` / `filesModified` (Set, LRU-style eviction via delete+re-add)
- `testResults` (Array, slice to last 500)
- `turnCacheHistory` (Array, slice to last 500)

### Visual Polish

1. **Braille sparkline** — `brailleSparkline(values)` renders 0-1 values as braille dot columns (2 values per char, 4 height levels). Used in SummaryBar to show last 20 turns of context token trend.

2. **Spinner animation** — `SPINNER_FRAMES` braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) in AgentStatus, ticks every 120ms.

## Code Review Findings

| Severity | Issue | Status |
|----------|-------|--------|
| HIGH | Braille bit positions non-standard | Fixed in `2bffc47` |
| MEDIUM | AgentStatus hardcoded "cyan" | Fixed — uses `theme.primary` |
| MEDIUM | Sparkline JSX indentation | Fixed |
| MEDIUM | `pushStatic` O(n) items copy | Accepted — same cost as before, now capped at 500 |
| LOW | Module-level mutable activeTheme | Accepted — single-threaded TUI |

## Test Coverage

- 15 new tests: ring buffer (5), sparkline (6), context bounds (4)
- Full suite: 684/684 pass, typecheck clean, build success

## Deep Brainstorm

Design document: `docs/superpowers/specs/2026-05-16-rivet-pastel-aesthetic-performance-memory-design.md`
Fragments: `.superpowers/brainstorm/2026-05-16-rivet-pastel-aesthetic-performance-memory-fragments.json`

Key insight from 4-scout research: "Ink reconciler is the bottleneck" is an unproven assumption. Static decorative elements are cheap; dynamic updates are expensive. Worker isolation is already good. Real growth points are SessionContext collections and staticItems.

## Deviations from Plan

- **Plan said Phase 1 = 1 day** — Actually took ~10 minutes (just 6 hex values + type refactor)
- **Plan said Phase 2 = 1 day** — Took ~30 minutes (3 tasks: memo, ring buffer, context bounds)
- **Plan said Phase 3 = 1 day** — Took ~20 minutes (sparkline, gradient, spinner)
- All 3 phases completed in a single session via subagent-driven development
