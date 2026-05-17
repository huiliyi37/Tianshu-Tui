# Rivet

Terminal coding agent optimized for DeepSeek V4 prefix cache.

## Development

```bash
npm install && npm run build
npm test          # node:test runner
npm run typecheck # tsc --noEmit
```

## Architecture

Entry: `src/main.tsx` → `src/agent/loop.ts` (AgentLoop) → `src/api/` (SSE streaming) → `src/tui/` (Ink 6 + React)

Key modules: `src/agent/` (loop, session, sub-agent, trace-store), `src/api/` (client, codex-client, error-classifier, retry-engine), `src/tui/` (app, stream, render-batch, steer-buffer), `src/tools/`, `src/compact/`, `src/context/`

## Conventions

- Node.js test runner (`node:test` + `node:assert/strict`), not Vitest or Jest
- ESM with `.js` extension in imports
- Immutable patterns — spread operator, no mutation
- Error classification via `classifyApiError()` — no ad-hoc status code checks in clients

## Known Constraints

- DeepSeek V4 may emit tool JSON in text content (`hasToolJsonInContentBug` in client config)
- Codex client receives text via both `output_text.delta` and `output_item.done` — `seenTextDelta` dedup handles this
- Agent loop `onTurnComplete(usage, turn, isFinal)` — intermediate turns keep writer alive, only final turn destroys it
- User input during streaming goes to SteerBuffer (not direct interrupt), injected at next tool result
