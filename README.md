# Rivet

A terminal coding agent powered by DeepSeek V4, with prefix cache optimization for the 1M context window. Ink 6 + React TUI, streaming responses, tool execution loop.

## Status

Baseline v0.1 — 44 source files, ~9,400 LOC, 67 tests passing.

## Quick Start

```bash
npm install && npm run build

# Set API key (pick one method)
export DEEPSEEK_API_KEY=sk-xxx          # via env
rivet config set-key deepseek sk-xxx # via CLI (saved to ~/.rivet/config.json)

# Start
node dist/main.js
# or after npm install -g:
rivet
```

## Architecture

```
src/
├── main.tsx              Entry: CLI routing → config → tools → prompt engine → agent → TUI
├── agent/
│   ├── loop.ts           Agent loop: LLM call → tool execution → repeat
│   ├── context.ts        Session state: messages, usage, turn count
│   └── session-persist.ts JSONL session persistence (~/.rivet/sessions/)
├── api/
│   ├── client.ts         Streaming API client with retry (exp backoff 1s/2s/4s)
│   ├── deepseek.ts       DeepSeek V4 provider: dual-format usage mapping
│   ├── provider.ts       ProviderCapabilities abstraction (thinking, cache, effort)
│   ├── sse.ts            SSE parser with id/retry field support
│   └── types.ts          Message, ContentBlock, Usage, ToolDefinition types
├── prompt/
│   ├── engine.ts         PromptEngine: frozen system prompt + volatile context
│   ├── static.ts         System prompt builder (~3,800 tokens with tools)
│   ├── volatile.ts       Volatile context: .rivet.md, git status (30s cache)
│   └── fingerprint.ts    SHA-256 fingerprint for cache drift detection
├── tools/
│   ├── bash.ts           Shell execution (spawn), live output streaming
│   ├── edit.ts           Search-and-replace with uniqueness check
│   ├── read-file.ts      File reading with offset/limit, .gitignore filter
│   ├── write-file.ts     File creation/overwrite
│   ├── registry.ts       Tool registration, approval gating
│   ├── gitignore.ts      .gitignore parser + default ignore patterns
│   ├── process-tracker.ts Child process tracker (killAll on abort)
│   ├── path-validate.ts  Path traversal protection
│   └── truncation.ts     Output truncation (head + tail)
├── compact/
│   ├── micro.ts          Truncation compaction (keep recent N messages)
│   ├── auto.ts           Auto-compaction decision (800K threshold, 500K floor)
│   └── constants.ts      Compaction thresholds per context window size
├── config/
│   ├── schema.ts         Zod config schema (provider, agent, compact, cache)
│   ├── default.ts        Default config: DeepSeek V4 Pro/Flash
│   └── manager.ts        CLI config manager (rivet config <command>)
└── tui/
    ├── app.tsx            Main app: slash commands, approval UI, render batching
    ├── input.tsx          Input bar (disabled during streaming/approval)
    ├── status-bar.tsx     Model, cache hit rate, cost, token count
    ├── stream.tsx         Streaming text output
    ├── thinking.tsx       Thinking block with collapse
    ├── tool-card.tsx      Tool execution display (auto-folds >20 lines)
    └── error-boundary.tsx React error boundary (catch without crash)
```

### Data Flow

```
User input → App.handleSubmit
  ├─ Slash command? → handle directly (/help, /exit, /compact, /model, /clear)
  └─ Agent loop:
       PromptEngine.buildRequest(messages)
         → static system prompt (frozen, cache anchor)
         → volatile context (.rivet.md, git status, working set)
       ApiClient.stream(request, callbacks)
         → SSE parse → content blocks (text, thinking, tool_use)
         → retry on 429/502/503/529 (exp backoff)
       Tool execution (if tool_use blocks)
         → approval check → spawn/exec → result
         → live output streaming via onOutput callback
         → child process tracked (killAll on SIGINT/SIGTERM)
       Loop until no tool_use or maxTurns reached
```

### Prefix Cache Strategy

System prompt is frozen at construction time and never changes within a session. Volatile context (git status, working set) is injected as separate user messages. This produces a consistent prefix structure across turns:

```
Turn 1: [system, user(<context>), user("hello")]
Turn 2: [system, user(<context>), user("hello"), assistant, user(<context>), user("read")]
```

DeepSeek's prefix cache matches on complete prefix, so the frozen system prompt + early turns cache-hit every subsequent request.

## Features

- **Prefix cache optimization** — Frozen system prompt + structured message ordering
- **Streaming TUI** — Ink 6 (React for CLI), 50ms render batching (~20fps)
- **4 builtin tools** — bash (spawn + live output), edit_file, read_file, write_file
- **Approval workflow** — y/n confirmation for dangerous operations
- **Session persistence** — JSONL append, resume on restart, compact on exit
- **Auto-compaction** — Triggers at 800K tokens, preserves recent messages
- **Provider abstraction** — ProviderCapabilities for multi-provider support
- **Dual-format usage** — Reads both DeepSeek native and Anthropic compat fields
- **Truncated JSON recovery** — Recovers partial tool_use JSON from streaming
- **Slash commands** — /help /exit /compact /model /clear
- **Config CLI** — Manage API keys, providers, models from terminal
- **.gitignore filter** — Skips node_modules, .git, build artifacts
- **Graceful shutdown** — SIGINT/SIGTERM → abort agent + persist session + kill children
- **ErrorBoundary** — React errors caught without crashing the process
- **Config validation** — Zod schema with deep merge over defaults

## Configuration

### Using the CLI (recommended)

```bash
# List providers and API key status
rivet config providers

# Set API key (saved to ~/.rivet/config.json)
rivet config set-key deepseek sk-your-key-here

# Or use an environment variable instead
rivet config set-key-env deepseek DEEPSEEK_API_KEY

# Add a new model to a provider
rivet config add-model deepseek deepseek-v4-flash 1000000 64000

# Remove a model
rivet config remove-model deepseek old-model-id

# Switch default provider
rivet config set-default deepseek

# Show full config
rivet config show
```

### Manual config file

Place `~/.rivet/config.json` (optional, uses defaults if missing):

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          { "id": "deepseek-v4-pro", "contextWindow": 1000000, "maxTokens": 64000 }
        ]
      }
    }
  },
  "agent": { "maxTurns": 50, "approval": "suggest" },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

## Slash Commands (in TUI)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/exit` `/quit` | Save session and exit |
| `/compact` | Compact conversation context now |
| `/model` | Show current model info and cost |
| `/clear` | Clear screen (visual only) |

## Development

```bash
npm run typecheck              # tsc --noEmit
npm run test                   # Run all tests (67)
npm run build                  # tsup build
npm run dev                    # Watch mode
```

## Design Documents

- `docs/optimization-design-v2.md` — Full optimization review and fix recommendations
- `docs/superpowers/specs/2026-05-15-system-prompt-expansion-design.md` — System prompt architecture comparison with Claude Code

## License

MIT
