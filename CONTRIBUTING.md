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
├── agent/          Agent loop + session + approval + tool pipeline
├── tools/          bash, read_file, write_file, edit_file
├── prompt/         System prompt + cache fingerprinting
├── compact/        Context compaction (provider-aware thresholds)
├── config/         Config schema + CLI manager (3-layer resolution)
└── context/        Anchor registry + pressure monitor + persistent store
```

## Configuration Layers

Rivet uses 3-layer config resolution (highest priority wins):

1. **Session overlay** — runtime-only, e.g. from CLI `--provider` flag
2. **Project config** — `.rivet-config.json` found by walking up from cwd
3. **User config** — `~/.rivet/config.json` (global)
4. **Defaults** — built into `src/config/default.ts`

Example `.rivet-config.json` for a project that prefers manual approval:

```json
{
  "agent": {
    "approval": "manual",
    "maxTurns": 30
  }
}
```

## Adding a Provider

1. Define `ProviderCapabilities` in `src/api/provider.ts`
2. Create a client factory in `src/api/<provider>.ts`
3. Add usage mapper if format differs from Anthropic
4. Add cache profile in `src/api/provider-profile.ts` (affects compaction strategy)
5. Add models to `src/config/default.ts`
6. Add tests

## Approval System

Rivet uses a dual-gate approval system:

1. **Tool-level gate**: `Tool.requiresApproval(params)` — static per-tool (e.g. `bash` checks `DANGEROUS_BASH_PATTERNS`)
2. **Risk-level gate**: `assessToolRisk()` — dynamic, considers doom loop state, path traversal, destructive commands, antibody claims, and **Sensorium confidence** (adaptive)

Decision matrix in `tool-pipeline.ts`:
- Allowlisted tools → always proceed
- `approvalMode='auto-safe'` + high confidence (>0.8) + low risk → auto-approve
- `approvalMode='auto-safe'` + high risk → ask user
- `approvalMode='manual'` + `requiresApproval()` → ask user

When adding a new tool, implement `requiresApproval()` and consider risk impact in `assessToolRisk()`.
