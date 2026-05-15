# Contributing to Rivet

## Setup

```bash
git clone https://github.com/user/rivet.git
cd rivet
npm install
```

Requirements: Node.js >= 22.0.0

## Development

```bash
# Type check
npm run typecheck

# Run tests
npm test

# Build
npm run build

# Dev mode (watch)
npm run dev

# Run locally
npm run start
```

## PR Process

1. Create a feature branch from `main`
2. Make changes with tests
3. Ensure `npm run typecheck` and `npm test` pass
4. Open PR with description of changes

## Code Style

- TypeScript strict mode, no `any`
- ESM modules (`"type": "module"`)
- Prefer small focused files (<400 lines)
- Immutable patterns (spread / map / filter, no mutation)
- No `console.log` in production code

## Testing

- Test framework: Node.js built-in test runner (`node:test`)
- All new features must include tests
- Run: `npm test`
- 80%+ coverage target

## Architecture

```
src/
├── main.tsx        Entry point + CLI
├── tui/            Terminal UI (Ink 6 + React)
├── api/            SSE client + provider abstraction
├── agent/          Agent loop + session
├── tools/          bash, read_file, write_file, edit_file
├── prompt/         System prompt + cache fingerprinting
├── compact/        Context compaction
└── config/         Config schema + CLI manager
```

## Adding a Provider

1. Define `ProviderCapabilities` in `src/api/provider.ts`
2. Create a client factory in `src/api/<provider>.ts`
3. Add usage mapper if format differs from Anthropic
4. Add models to `src/config/default.ts`
5. Add tests
