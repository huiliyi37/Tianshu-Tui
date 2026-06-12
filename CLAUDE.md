# Rivet

Terminal coding agent optimized for DeepSeek V4 prefix cache. Node.js 22+ / TypeScript strict / Ink 6 / node:test.

## Build & Test

```bash
npm install && npm run build
npm test          # 2340 tests, node:test + node:assert/strict
npm run typecheck # tsc --noEmit
```

## Architecture

```
main.tsx → AgentLoop (agent/loop.ts)
  ├── RuntimeHookPipeline (agent/runtime-hooks.ts)  ← TUI 2.x 核心
  │     phases: preTurn → afterPerception → postTool → postTurn → postSession
  │     9 hooks: signal-consumer, perception, vigor, theta, kick,
  │              stigmergy, playbook-reflect, dream, telemetry-flush
  ├── AgentSession (messages, usage, turn count)
  ├── EvidenceTracker + FileHistory
  ├── Stores: claim-store, stigmergy-store, playbook-store, trace-store
  └── Tool dispatch → API (SSE streaming) → TUI (Ink 6)
```

Key modules: `src/agent/` (loop, hooks/, session, sub-agent, coordinator), `src/api/` (client, codex-client, error-classifier), `src/tui/` (app, stream, render-batch, steer-buffer), `src/tools/`, `src/compact/`, `src/context/`, `src/auth/`

## Conventions

- Node.js test runner (`node:test` + `node:assert/strict`), not Vitest or Jest
- ESM with `.js` extension in imports
- Immutable patterns — spread operator, no mutation
- Error classification via `classifyApiError()` — no ad-hoc status code checks in clients
- Tests: `src/**/__tests__/*.test.ts` mirrors source structure

## Known Constraints

- **Prefix cache is the core optimization.** System prompt and early messages must stay stable within a session — avoid rewriting history or injecting before anchor points.
- DeepSeek V4 may emit tool JSON in text content (`hasToolJsonInContentBug` in client config)
- Codex client receives text via both `output_text.delta` and `output_item.done` — `seenTextDelta` dedup handles this
- Agent loop `onTurnComplete(usage, turn, isFinal)` — intermediate turns keep writer alive, only final turn destroys it
- User input during streaming goes to SteerBuffer (not direct interrupt), injected at next tool result

## MCP Tools: code-review-graph

### Anti-patterns (NEVER do these)

These patterns waste 5-10× the necessary tool calls when the code-review-graph MCP can answer directly. The graph indexes call relationships, imports, and inheritance — one query replaces many file reads.

- **NEVER** grep/glob/read in a loop to explore code when `query_graph` or `semantic_search_nodes` can answer in one call
- **NEVER** spawn an Explore sub-agent for questions that `query_graph pattern="callers_of"` or `get_impact_radius` can answer directly
- **NEVER** read an entire file to find a function — use `semantic_search_nodes` then `get_review_context` for the relevant snippet
- **Prefer composite queries**: `detect_changes_tool` + `get_affected_flows` replaces manual diff → grep → read chains
- **One graph call replaces 5-10 file reads** — always check graph tools first when the question is "who calls / who imports / what's affected"

## Star Lore

星图叙事与伙伴星定义见 [star.md](./star.md)。
