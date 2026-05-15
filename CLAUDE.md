# Rivet

A terminal coding agent optimized for DeepSeek V4 prefix cache.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Architecture

See [README.md](README.md) for full architecture overview.

Key paths:
- `src/main.tsx` — Entry point + CLI routing
- `src/tui/` — Terminal UI (Ink 6 + React), SummaryBar, PhaseTracker, theme system
- `src/api/` — SSE streaming client + provider abstraction
- `src/agent/` — Agent loop + session management + sub-agent coordinator
- `src/tools/` — bash, read_file, write_file, edit_file, delegate_task
- `src/mcp/` — MCP client (Model Context Protocol) — config, wrapper, manager, tool discovery
- `src/prompt/` — System prompt assembly + cache fingerprinting
- `src/compact/` — Context compaction (micro + smart)
- `src/context/` — Progressive Context Engine (rounds, ledger, resume-preflight, session-memory)
- `src/config/` — Configuration schema + CLI manager

## Slash Commands

`/help`, `/exit`, `/compact`, `/model`, `/verbose`, `/debug`, `/sessions`, `/resume`, `/memory`, `/rollback`, `/context`, `/evidence`, `/auto`, `/mcp`, `/cockpit`
