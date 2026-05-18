# Rivet

Terminal coding agent optimized for DeepSeek V4 prefix cache. Node.js 22+ / TypeScript strict / Ink 6 / node:test.

## Development

```bash
npm install && npm run build
npm test          # 1685 tests, node:test + node:assert/strict
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
