# Rivet

A terminal coding agent powered by DeepSeek V4, with prefix cache optimization for the 1M context window. Ink 6 + React TUI, streaming responses, tool execution loop.

## Status

Phase 3 complete — 58 source files, ~12,000 LOC, 162 tests passing. Trust Cockpit MVP + Cache Diagnostics integrated.

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
│   ├── volatile-git.ts   Non-blocking git status: stale cache + async refresh
│   ├── fingerprint.ts    SHA-256 fingerprint for cache drift detection
│   └── cache-diagnostic.ts  Cache miss reason analysis (5 categories)
├── tools/
│   ├── bash.ts           Shell execution (spawn), live output streaming
│   ├── edit.ts           Search-and-replace with uniqueness check
│   ├── read-file.ts      File reading with offset/limit, .gitignore filter
│   ├── write-file.ts     File creation/overwrite
│   ├── grep.ts           Pattern search (ripgrep first, native fallback)
│   ├── glob.ts           File discovery with **/*/?/{a,b} support
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

### Prompt Layering

The prompt is split into 4 layers for maximum cache stability:

| Layer | Content | Cache behavior |
|-------|---------|---------------|
| L1 | Frozen system prompt | Never changes → always cache hit |
| L2 | Tool definitions (stable-sorted) | Only changes when tools are added/removed |
| L3 | *(reserved for project memory)* | Future use |
| L4 | Volatile context (cwd, git status, .rivet.md) | Changes per turn, isolated from L1-L2 |

## Features

- **Prefix cache optimization** — Frozen system prompt + structured message ordering
- **Streaming TUI** — Ink 6 (React for CLI), 50ms render batching (~20fps)
- **12 builtin tools** — bash, diff, edit_file, read_file, write_file, grep, glob, inspect_project, repo_map, run_tests, related_tests, output_store
- **Non-blocking git status** — Stale cache + async refresh, no event loop blocking
- **Approval workflow** — y/n confirmation for dangerous operations
- **Session persistence** — JSONL append, resume on restart, compact on exit
- **Auto-compaction** — Triggers at 800K tokens, LLM summarization with micro-compact fallback
- **Smart compact** — LLM-based conversation summarization preserves context across long sessions
- **Incremental token accounting** — O(1) per-turn token estimates via session-level tracking
- **Render batching** — 50ms batched flush for text, thinking, and tool output (~20fps)
- **Provider abstraction** — ProviderCapabilities for multi-provider support
- **Dual-format usage** — Reads both DeepSeek native and Anthropic compat fields
- **Three-layer output** — Raw persistence + model compression + UI summary for large tool outputs
- **Auto-checkpoint** — Git checkpoint created before first file modification each turn
- **Trust Cockpit** — Evidence badge (files read/modified, tests), checkpoint/rollback, raw output tracing
- **Test failure classifier** — Categorizes failures (type_error/assertion/timeout/…) with fix suggestions
- **Cache diagnostics** — Hit rate color coding (green ≥80%, yellow ≥40%, red <40%), automatic miss reason analysis, per-turn cache history tracking
- **Cache-aware pricing** — Cache hit tokens priced at 1/10 rate (DeepSeek V4 promo), savings displayed in `/debug cache`
- **Compaction cache anchor** — First 2 messages preserved as cache anchor after compaction, stable XML summary header
- **Truncated JSON recovery** — Recovers partial tool_use JSON from streaming
- **Slash commands** — /help /exit /compact /model /clear /rollback /sessions /resume /verbose /debug /evidence
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
| `/model [name\|list]` | Show or switch model |
| `/verbose` | Toggle verbose tool output (20 → 200 lines) |
| `/debug [prompt\|fingerprint\|cache]` | Debug prompt, cache fingerprint, or cache stats with savings |
| `/clear` | Clear screen (visual only) |
| `/sessions` | List all saved sessions |
| `/resume <number>` | Restore a saved session |
| `/rollback` | Preview changes since checkpoint (`/rollback confirm` to execute) |
| `/evidence` | Show last turn evidence summary |

## User Manual

### First Time Setup

```bash
# 1. Install dependencies
npm install && npm run build

# 2. Configure your DeepSeek API key (one of):
export DEEPSEEK_API_KEY=sk-xxx
# or save persistently:
node dist/main.js config set-key deepseek sk-xxx

# 3. Launch
node dist/main.js
```

### Basic Usage

Type your request in the input bar and press Enter. Rivet will:
1. Understand your request and plan an approach
2. Read files, search code, and make edits as needed
3. Run tests to verify changes
4. Show an evidence summary when done

### Understanding the Status Bar

```
deepseek-v4-pro  cache:98.7%  ¥0.15  ████░░░░░░  125K/1M (12%)
│                │            │      │            └── context usage
│                │            │      └── token budget bar (color: green/yellow/red)
│                │            └── estimated cost (cache discount applied)
│                └── cache hit rate (green ≥80%, yellow ≥40%, red <40%)
└── current model
```

### Slash Commands Quick Reference

| Command | What it does |
|---------|-------------|
| `/help` | Show all available commands |
| `/model list` | Show available models, current model, and cost |
| `/model <name>` | Switch to a different model |
| `/compact` | Compact conversation to free context space |
| `/debug cache` | Show detailed cache stats: hit rate, tokens, savings |
| `/debug fingerprint` | Show prompt fingerprint and drift detection |
| `/debug prompt` | Show current system prompt preview |
| `/verbose` | Toggle between 20-line and 200-line tool output |
| `/rollback` | Preview changes since last checkpoint |
| `/rollback confirm` | Discard all changes since last checkpoint |
| `/sessions` | List saved sessions |
| `/resume <N>` | Restore a saved session |
| `/evidence` | Show last turn evidence (files read, modified, tests) |
| `/clear` | Clear screen |
| `/exit` | Save session and exit |

### How Cache Works

Rivet optimizes DeepSeek V4's prefix cache to minimize cost:

- **L1 System prompt** is frozen at startup and never changes → always hits cache
- **L2 Tool definitions** are stable-sorted → only changes when tools are added/removed
- **L4 Volatile context** (git status, cwd, .rivet.md) changes per turn but is isolated from the cached prefix

When you see `cache:98.7%` in green, it means 98.7% of input tokens were served from cache at 1/10 the normal price.

**Cache diagnostic notifications:**
- `💡 Compaction ran — message history restructured, partial cache miss expected` — Normal after context compaction
- `⚠️ Cache drift: system prompt + tool definitions changed — prefix invalidated` — Something changed the frozen prefix (unusual)
- `💡 Low cache hit (28%) — prefix may have been evicted` — Context too long, cache was evicted

### Project Configuration

Place a `.rivet.md` file in your project root. Its contents are automatically included as project instructions:

```markdown
# Project Instructions
- Use pnpm, not npm
- All tests must pass before committing
- Follow conventional commit format
```

### Auto-Checkpoint

Rivet automatically creates a git checkpoint before the first file modification each turn. If something goes wrong:

1. `/rollback` — Preview what would be discarded
2. `/rollback confirm` — Restore to the checkpoint (destructive)

### Session Persistence

Sessions are saved to `~/.rivet/sessions/`. On restart:

1. Rivet detects previous sessions
2. Press `r` to restore, or any key to start fresh
3. Use `/sessions` to list, `/resume <N>` to restore a specific one

### Cost Optimization Tips

- **Long sessions are cheap** — The longer you chat, the higher the cache hit rate
- **Avoid `/clear`** — Clearing logs doesn't clear context; use `/compact` instead
- **Use `run_tests`** — It's cheaper than running bash tests because output is compressed
- **Check `/debug cache`** — Monitor your savings in real-time

## Development

```bash
npm run typecheck              # tsc --noEmit
npm run test                   # Run all tests (162)
npm run build                  # tsup build
npm run dev                    # Watch mode
```

## Design Documents

- `docs/optimization-design-v2.md` — Full optimization review and fix recommendations
- `docs/superpowers/specs/2026-05-15-rivet-open-model-terminal-agent-direction-design.md` — Strategic direction: Trust Cockpit + Open Model Capability Lab
- `docs/superpowers/plans/2026-05-15-rivet-dev-capability-phase3.md` — Phase 3 implementation plan
- `docs/superpowers/plans/2026-05-15-rivet-p2.1-remaining.md` — P2.1 remaining tasks + execution record
- `docs/superpowers/plans/2026-05-15-rivet-performance-optimization.md` — Performance optimization plan
- `docs/superpowers/specs/2026-05-15-rivet-p2-1-performance-dev-capability-optimization.md` — P2.1 performance & dev capability spec

## License

MIT
