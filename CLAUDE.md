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
- `src/tui/` — Terminal UI (Ink 6 + React), SummaryBar, PhaseTracker, theme system, cockpit panels, markdown/diff renderer, scroll pager
- `src/tui/cockpit/` — Multi-panel cockpit (TracePanel, VerificationPanel, ContextPanel, SafetyPanel, ModelPanel, CockpitRail)
- `src/api/` — SSE streaming client + provider abstraction + error classifier + structured retry engine
- `src/agent/` — Agent loop + session management + sub-agent coordinator + TurnHarness (retry/trajectory) + task-state extraction + TraceStore + approval-risk + output token escalation + steer guidance injection
- `src/tui/render-batch.ts` — Microtask-aligned text delta batching for render efficiency
- `src/tui/steer-buffer.ts` — User guidance buffer for non-interrupting steer injection during execution
- `src/tools/` — bash, read_file, write_file, edit_file, git, todo, web_fetch, undo, delegate_task
- `src/hooks/` — Agent hooks (PreToolUse/PostToolUse/Notification/SubagentStop)
- `src/mcp/` — MCP client (Model Context Protocol) — config, wrapper, manager, tool discovery
- `src/prompt/` — System prompt assembly + cache fingerprinting
- `src/compact/` — Context compaction (micro + smart)
- `src/context/` — Progressive Context Engine (rounds, ledger, resume-preflight, session-memory)
- `src/config/` — Configuration schema + CLI manager

## Slash Commands

`/help`, `/exit`, `/compact`, `/model`, `/verbose`, `/debug`, `/clear`, `/sessions`, `/resume`, `/memory`, `/rollback`, `/undo`, `/context`, `/evidence`, `/auto`, `/mcp`, `/scroll`, `/cockpit [summary|trace|verify|context|safety|model|off]`, `/theme [pastel|cyberpunk|list]`, `/interview <topic>`, `/effort [off|low|medium|high|max]`
