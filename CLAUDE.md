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
- `src/tui/` — Terminal UI (Ink 6 + React)
- `src/api/` — SSE streaming client + provider abstraction
- `src/agent/` — Agent loop + session management
- `src/tools/` — bash, read_file, write_file, edit_file
- `src/prompt/` — System prompt assembly + cache fingerprinting
- `src/compact/` — Context compaction
- `src/config/` — Configuration schema + CLI manager
