# OpenCode TUI

A terminal coding agent powered by DeepSeek V4, with prefix cache optimization for the 1M context window. Ink 6 + React TUI, streaming responses, tool execution loop.

## Status

Baseline v0.1 — 36 source files, ~9,000 LOC, 32 tests passing.

## Quick Start

```bash
npm install && npm run build
export DEEPSEEK_API_KEY=sk-xxx
node dist/main.js
```

## Architecture

```
src/
├── main.tsx              Entry: config → tools → prompt engine → agent → TUI
├── agent/
│   ├── loop.ts           Agent loop: LLM call → tool execution → repeat
│   ├── context.ts        Session state: messages, usage, turn count
│   └── session-persist.ts JSONL session persistence (~/.opencode/sessions/)
├── api/
│   ├── client.ts         Streaming API client with retry (exp backoff 1s/2s/4s)
│   ├── deepseek.ts       DeepSeek V4 provider: dual-format usage mapping
│   ├── sse.ts            SSE parser with id/retry field support
│   └── types.ts          Message, ContentBlock, Usage, ToolDefinition types
├── prompt/
│   ├── engine.ts         PromptEngine: frozen system prompt + volatile context
│   ├── static.ts         System prompt builder (~3,800 tokens with tools)
│   ├── volatile.ts       Volatile context: .opencode.md, git status (30s cache)
│   └── fingerprint.ts    SHA-256 fingerprint for cache drift detection
├── tools/
│   ├── bash.ts           Shell execution (spawn), live output streaming
│   ├── edit.ts           Search-and-replace with uniqueness check
│   ├── read-file.ts      File reading with offset/limit
│   ├── write-file.ts     File creation/overwrite
│   ├── registry.ts       Tool registration, approval gating
│   └── path-validate.ts  Path traversal protection
├── compact/
│   ├── micro.ts          Truncation compaction (keep recent N messages)
│   ├── auto.ts           Auto-compaction decision (800K threshold, 500K floor)
│   └── constants.ts      Compaction thresholds per context window size
├── config/
│   ├── schema.ts         Zod config schema (provider, agent, compact, cache)
│   └── default.ts        Default config: DeepSeek V4 Pro/Flash
└── tui/
    ├── app.tsx            Main app: slash commands, approval UI, render batching
    ├── input.tsx          Input bar (disabled during streaming/approval)
    ├── status-bar.tsx     Model, cache hit rate, cost, token count
    ├── stream.tsx         Streaming text output
    ├── thinking.tsx       Thinking block with collapse
    └── tool-card.tsx      Tool execution display
```

### Data Flow

```
User input → App.handleSubmit
  ├─ Slash command? → handle directly (/help, /exit, /compact, /model, /clear)
  └─ Agent loop:
       PromptEngine.buildRequest(messages)
         → static system prompt (frozen, cache anchor)
         → volatile context (.opencode.md, git status, working set)
       ApiClient.stream(request, callbacks)
         → SSE parse → content blocks (text, thinking, tool_use)
         → retry on 429/502/503/529 (exp backoff)
       Tool execution (if tool_use blocks)
         → approval check → spawn/exec → result
         → live output streaming via onOutput callback
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
- **Dual-format usage** — Reads both DeepSeek native and Anthropic compat fields
- **Truncated JSON recovery** — Recovers partial tool_use JSON from streaming
- **Slash commands** — /help /exit /compact /model /clear
- **Config validation** — Zod schema with deep merge over defaults

## Configuration

Place `~/.opencode/config.json` (optional, uses defaults if missing):

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

## Development

```bash
npm run typecheck              # tsc --noEmit
npm run test                   # Run all tests (32)
npm run build                  # tsup build
npm run dev                    # Watch mode
```

## Design Documents

- `docs/optimization-design-v2.md` — Full optimization review and fix recommendations
- `docs/superpowers/specs/2026-05-15-system-prompt-expansion-design.md` — System prompt architecture comparison with Claude Code

## License

MIT
