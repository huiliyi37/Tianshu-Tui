# Rivet Activity Status Layer Design

## Goal

Add a lightweight activity status layer so long Rivet turns are understandable while they are still running. The user should be able to see what Rivet is doing, how long the current activity has been running, and whether the activity has stopped producing updates, without adding high-frequency rendering or a heavy trace system.

## Background

Session HA Closure made interrupted sessions recoverable: resume repair, stream-error persistence, process-tree cleanup, MCP timeout/degraded state, compaction safety, prompt-boundary hardening, bounded stream rendering, and cerebellar/thinking regression coverage are now merged to `main`.

The next long-task test revealed a different gap: when Rivet spends a long time thinking or analyzing large tool output, the terminal can look idle even if the model or a tool is still working. The current `ThinkingCollapser` displays `Thinking completed (655 chars)`, but it does not preserve the final thinking duration. More importantly, the same observability gap applies outside thinking: large-file analysis, MCP waits, compaction, preflight recovery, and quiet tool execution also need a visible low-cost status.

## Current Evidence

Relevant current files:

- `src/tui/thinking.tsx` has local elapsed/stale logic for streaming thinking and displays thinking content size.
- `src/tui/app.tsx` owns `thinkStartRef`, `thinkTimeRef`, `thinkBuf`, `streamBuf`, tool callbacks, and turn lifecycle callbacks.
- `src/tui/agent-status.tsx` already renders the active agent status line with spinner, elapsed time, token estimate, thinking time, and tool list.
- `src/tui/summary-bar.tsx` already displays coarse turn phase/status.

Observed gap:

- Thinking duration is partly tracked but split across components.
- Completed thinking output does not clearly show final duration.
- Large-file analysis and quiet model/tool waits have no single status projection.
- Existing status is phase-like, not activity-lifecycle aware.

## Design Principles

1. **Status, not fake progress** — do not invent percentages for AI thinking or large-file analysis.
2. **One current activity, not a timeline** — the first version tracks the active thing only.
3. **Low-frequency projection** — refs may receive frequent heartbeats; React state updates are throttled and skipped when display text is unchanged.
4. **Local TUI scope** — do not change API protocol, AgentLoop semantics, or persistence for this phase.
5. **Reuse existing surfaces** — prefer `AgentStatus`, `ThinkingCollapser`, and `SummaryBar`; do not add a new panel by default.
6. **Explain quiet periods** — show elapsed time and stale/no-update time when there has been no visible activity.

## External Research Summary

The scout pass found three useful patterns:

- **LSP `workDoneProgress`**: `begin` / `report` / `end`, with optional percentage. The percentage can be omitted for unknown-progress work.
- **CLI spinner + elapsed + stale**: tools such as ora-style spinners and terminal status widgets show activity, elapsed time, and a no-output indicator instead of precise progress.
- **Agent monitors**: tools such as agtop/agenttrace infer active/waiting/stale from recent transcript or process events rather than exact progress.

The recommended adaptation is an LSP-inspired lifecycle model with a single current activity and a low-frequency TUI projection.

## Activity Model

Add a pure TUI status model. Proposed file:

- `src/tui/activity-status.ts`

Conceptual types:

```ts
export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'analyzing'
  | 'tool'
  | 'mcp'
  | 'compacting'
  | 'preflight'

export interface ActivityState {
  phase: ActivityPhase
  label?: string
  startedAt: number
  lastEventAt: number
  completedAt?: number
  sizeHint?: string
  status: 'active' | 'stale' | 'completed' | 'failed' | 'idle'
}
```

The state is intentionally small. It does not store event history, transcript excerpts, output chunks, or progress percentages.

## Event Model

Use a simple lifecycle API inspired by LSP progress reporting:

```ts
beginActivity(state, phase, label, now)
heartbeatActivity(state, label, now)
completeActivity(state, label, now)
failActivity(state, label, now)
clearActivity(now)
```

Event meanings:

- `beginActivity` starts a new visible activity.
- `heartbeatActivity` refreshes `lastEventAt` and can update the label.
- `completeActivity` freezes `completedAt` so completed status can show final duration.
- `failActivity` freezes a failed status for a short projection window or until the turn clears.
- `clearActivity` returns to idle.

The first implementation can keep state in `App` refs and project it into React state at a throttled cadence.

## Activity Sources

### Thinking

Source: `onThinkingDelta` and `onTurnComplete`.

Behavior:

- First thinking delta begins `thinking`.
- Later thinking deltas heartbeat `thinking` and update `sizeHint` from buffered thinking length.
- Turn completion completes `thinking` if it was active.

Example display:

```text
Thinking… 42s · 655 chars
Thinking… 2m 10s · no update 18s · 655 chars
Thinking completed in 2m 08s (655 chars)
```

### Streaming answer

Source: `onTextDelta` and block writer flush.

Behavior:

- Text delta begins or heartbeats `streaming` after thinking completes or when answer text starts.
- Display remains minimal because streaming text itself is already visible.

Example display:

```text
Streaming answer… 1m 20s
```

### Tool execution

Source: `onToolUse`, `onToolResult`, and live output callbacks.

Behavior:

- Tool use begins `tool` with a compact label from `toolLabel(name, input)`.
- Live output heartbeats the activity.
- Tool result completes or fails the activity.

Examples:

```text
Running npm test… 1m 12s
Reading src/tui/app.tsx… 38s
Reading src/tui/app.tsx… 52s · no update 14s
```

### MCP waits

Source: MCP tool invocation through the existing tool callback path.

Behavior:

- MCP tools can be labeled as `mcp` instead of generic `tool` when the tool name has the `mcp__` prefix.
- Timeout/degraded state remains handled in MCP manager; the activity layer only displays the wait.

Example:

```text
Waiting for MCP context7… 24s
```

### Large-file analysis

Source: transition after a large read/tool result when the model has not produced text yet.

Behavior:

- If the last completed tool produced a large result or read a large file, and the next model phase is quiet, begin `analyzing` with the file/tool label.
- This is not a progress bar. It tells the user Rivet is likely processing the last large input.

Example:

```text
Analyzing src/tui/app.tsx… 28s
Analyzing tool results… 46s · no update 15s
```

Initial heuristic:

- Trigger only for known large-result paths already visible to the UI, such as `read_file` with large `uiContent`/raw output or summarized tool output.
- Keep the label generic if precise size is unavailable.

### Compaction and preflight

Source: existing compaction/resume callbacks where available in App-level control flow.

Behavior:

- Use `compacting` when compaction starts and completes.
- Use `preflight` when session restore/preflight recovery is running.

Examples:

```text
Compacting context… 8s
Restoring session… 4s
```

## UI Projection

Preferred display location:

1. `AgentStatus` main line shows the current activity summary.
2. `ThinkingCollapser` continues to show expandable thinking content and can receive completed duration from the activity state.
3. `SummaryBar` can continue showing coarse turn phase and last action.

Do not add a new cockpit panel in this phase.

Display format:

```text
⠋ <Activity label>… <elapsed>[ · no update <stale>][ · <sizeHint>]
```

Completed format:

```text
<Activity label> completed in <duration>[ (<sizeHint>)]
```

Stale thresholds:

- `<5s` since last event: no stale text.
- `>=5s`: `waiting…` can be used for short quiet periods.
- `>=10s`: show `no update <duration>`.
- `>=60s`: keep the same wording; do not auto-interrupt.

## Performance Plan

- Store mutable activity state in `useRef`.
- Update React state only through a projection string or compact `ActivityViewModel`.
- Projection tick should be no faster than 1 Hz.
- Skip `setState` when the projected text is identical to the previous text.
- Reuse the existing tool/thinking flush cadence; do not add per-delta React updates.
- Keep the display component memoized.
- Do not persist activity state across sessions.

## Component Responsibilities

### `src/tui/activity-status.ts`

Responsible for:

- Activity state transitions.
- Duration/stale calculations.
- Formatting concise display text.
- Pure unit-testable behavior.

Not responsible for:

- React state.
- Reading files or tool output.
- Persisting timeline/history.

### `src/tui/app.tsx`

Responsible for:

- Translating existing callbacks into activity events.
- Holding the current activity ref.
- Projecting activity to React state at low frequency.
- Clearing activity on turn completion, error, and abort.

### `src/tui/agent-status.tsx`

Responsible for:

- Rendering the activity summary in the existing status area.
- Preserving existing spinner/tool-list behavior.

### `src/tui/thinking.tsx`

Responsible for:

- Rendering expandable thinking content.
- Rendering size and completed duration supplied by the status layer.
- Avoiding a second independent elapsed/stale state machine once activity status is wired.

## Testing Strategy

Unit tests for `activity-status.ts`:

- Starts idle.
- `beginActivity` records phase, label, `startedAt`, and `lastEventAt`.
- `heartbeatActivity` updates `lastEventAt` and optional label without resetting `startedAt`.
- `completeActivity` freezes `completedAt` and produces completed duration text.
- Stale formatting appears only after threshold.
- Formatting includes size hint when present.
- Unknown-progress activities never show percentage.

Component/App tests:

- Thinking delta displays elapsed and chars.
- Completed thinking displays final duration and chars.
- Tool use displays a concise label and elapsed time.
- MCP-prefixed tool displays as MCP wait.
- Long quiet period displays `no update` text.
- Rapid activity changes do not create duplicate status rows.

Performance checks:

- Activity projection does not update React state on every thinking delta.
- Activity projection interval is cleared on completion/error/abort.
- Existing bounded stream rendering remains unchanged.

## Out of Scope

- Full activity timeline.
- Cockpit trace panel for activity history.
- ETA calculation.
- Percent progress for unknown AI/model work.
- Cross-session activity persistence.
- API protocol changes.
- AgentLoop semantic changes.
- Automatic interruption of long-running work.

## Success Criteria

- During long thinking, the user sees elapsed time, character count, and no-update duration when quiet.
- During large-file or large-tool-result analysis, the user sees an `Analyzing ...` activity instead of a silent terminal.
- During long tool/MCP waits, the user sees the active target and elapsed time.
- Completed thinking preserves final duration.
- The implementation adds no high-frequency per-delta React state updates.
- Existing Session HA tests and TUI tests remain green.

## Approved Direction

Use a lightweight Activity Status Layer, not a thinking-only patch. Start with one current activity, pure state helpers, low-frequency UI projection, and existing TUI surfaces. Keep the first version intentionally small so it improves long-task confidence without hurting terminal performance.
