# Rivet Activity Status Layer Brainstorm Asset

## Original Prompt

User asked for a design after observing long thinking ambiguity:

> 出一个方案。尽可能不影响终端会话的性能和体验 可以scout探查外部领域

The immediate trigger was a terminal state like:

```text
Thinking completed (655 chars) (Tab to expand)
```

The user noted that long thinking might look stuck and that the UI does not expose thinking duration clearly.

## Initial Problem Frame

The first interpretation was a narrow ThinkingCollapser observability gap:

- Show thinking elapsed time while streaming.
- Show final thinking duration after completion.
- Show stale/no-update duration during quiet thinking.
- Keep updates low frequency to avoid hurting terminal performance.

The initial recommendation was to avoid a broad trace/cockpit system and add a small pure status helper for thinking.

## Initial Options Considered

### Option A — Enhance `ThinkingCollapser` only

Add local start/last-update/completed duration tracking inside `src/tui/thinking.tsx`.

Pros:

- Smallest implementation.
- Minimal blast radius.
- No changes to main agent loop.

Cons:

- Solves only thinking.
- Duplicates timing semantics already partly present in `App`/`AgentStatus`.
- Harder to reuse for tool waits or large-file analysis.

### Option B — App-owned `ThinkingStatus`

Have `App` own a `ThinkingStatus` object and pass display metadata to `ThinkingCollapser` and `AgentStatus`.

Pros:

- One source of truth for thinking metadata.
- Easier to share between status surfaces.

Cons:

- Adds more state to an already large `App`.
- Still thinking-specific.
- Needs careful throttling to avoid per-delta render pressure.

### Option C — Small pure `thinking-status.ts` module

Create a pure state/formatting module for thinking status and let `App` project it at low frequency.

Pros:

- Testable.
- Clearer than stuffing state into a React component.
- Easier future path to general activity status.

Cons:

- Slightly more structure than the minimal patch.
- Still not broad enough once user clarified the real gap.

Initial recommendation: Option C.

## User Correction

The user clarified:

> 不只有思考过程，对话中发现他在分析大文件的时候，我们也没办法感知。需要一些状态层 可能

This changed the problem from **thinking observability** to **long-task activity observability**.

The design pivot became:

- Not only thinking.
- Include large-file analysis, long tool waits, MCP waits, compaction, preflight, streaming, and quiet model processing.
- Provide a status layer rather than a point fix.
- Avoid performance regressions by keeping only current activity and low-frequency projection.

## Project Context Observed

Current implementation already has partial primitives:

- `src/tui/thinking.tsx`
  - `ThinkingCollapser` tracks local elapsed time and stale state.
  - Displays thinking size with `formatThinkingSize`.
- `src/tui/app.tsx`
  - Owns `thinkStartRef`, `thinkTimeRef`, `thinkBuf`, `streamBuf`, tool callbacks, and turn lifecycle.
  - Batches thinking updates through `THINKING_FLUSH_MS`.
- `src/tui/agent-status.tsx`
  - Displays spinner, elapsed turn time, phase labels, token estimate, thinking time, and tool list.
- Session HA Closure just added bounded stream rendering and stronger long-session recovery guarantees.

Conclusion: the right design should reuse current status surfaces and should not introduce a separate heavy panel for the first version.

## External Scout Findings

Two scout passes were run.

### Thinking-specific scout

Relevant patterns:

- CLI spinner libraries commonly show elapsed time and use one timer for display refresh.
- React/Ink guidance favors refs for mutable values, memoized display components, and low-frequency state updates.
- `no update for Xs` is a clearer user-facing stale signal than a generic spinner alone.

Key lesson:

- Rivet's existing thinking implementation is already close to best practice, but the state is too local and not reusable.

### Broader activity-layer scout

Relevant patterns:

- LSP `workDoneProgress` uses `begin` / `report` / `end` and allows progress without percentage.
- Agent monitors such as agtop/agenttrace infer active/waiting/stale from recent events rather than exact progress.
- Terminal status indicators should be TTY-friendly, concise, and avoid frequent output churn.

Key lesson:

- The best fit is a lightweight LSP-inspired lifecycle model with one current activity and stale detection based on recent events.

## Final Recommended Direction

Build a lightweight Activity Status Layer.

Core model:

```ts
type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'analyzing'
  | 'tool'
  | 'mcp'
  | 'compacting'
  | 'preflight'
```

Core lifecycle:

```ts
beginActivity(phase, label, now)
heartbeatActivity(label, now)
completeActivity(label, now)
failActivity(label, now)
clearActivity(now)
```

Core display:

```text
Thinking… 2m 10s · no update 18s · 655 chars
Analyzing src/tui/app.tsx… 28s
Running npm test… 1m 12s
Waiting for MCP context7… 24s
Compacting context… 8s
```

## Design Constraints Preserved

- Do not add fake percentages.
- Do not record full activity timelines.
- Do not add a cockpit panel in the first version.
- Do not change API protocol.
- Do not change AgentLoop semantics.
- Do not update React state on every model/tool delta.
- Do not persist activity state across sessions.

## Reusable Design Principles

1. **Unknown progress is still observable**: show phase, label, elapsed, and stale duration instead of percentage.
2. **Activity freshness is a first-class signal**: recent heartbeat time often matters more than exact progress.
3. **The UI should explain silence**: if there is no output, say what Rivet is likely waiting on or analyzing.
4. **Status projection should be lossy**: users need current confidence, not every event.
5. **Do not turn observability into telemetry by default**: current activity is enough for the first version.

## Decision

The approved design direction is:

> Implement a lightweight Activity Status Layer as a pure TUI status module with low-frequency projection into existing status surfaces. It should cover thinking, streaming, large-file analysis, tool execution, MCP waits, compaction, and preflight without adding a heavy trace/timeline system.

The formal spec is saved separately in:

- `docs/superpowers/specs/2026-05-17-rivet-activity-status-layer-design.md`
