# Rivet

Terminal coding agent with prefix-cache optimization, multi-provider support, subagent orchestration, and a streaming TUI. 2700+ tests, typecheck clean.

## Quick Start

```bash
git clone <repo> && cd rivet
npm install && npm run build

# Set API key
export DEEPSEEK_API_KEY=sk-xxx

# Launch
node dist/main.js
```

## Core Features

### Prefix Cache Engine

DeepSeek charges 50× more for cache misses. Rivet's prompt engine is built around prefix-cache friendliness:

- **Frozen prefix** — System prompt + tool definitions + stable context are frozen at session start and never rewritten. DeepSeek's exact-prefix cache hits on every subsequent request.
- **Delta appendix** — Dynamic context (progress, advisories, signals) is injected as a cross-turn diff append-only block, never rewriting prior messages. Turn-to-turn delta is ~200 bytes vs ~5KB full rewrite.
- **Read-ref dedup** — Repeated reads of unchanged files return a compact reference instead of re-emitting full content, saving context tokens.
- **Cache-aware compaction** — Compaction preserves the first 2 messages as cache anchor, and rounds are selected to maintain API invariants.
- **Diagnostics** — `/debug cache` shows hit rate (green ≥80%, yellow ≥40%, red <40%), miss reason analysis, and per-turn cache history.

Real-world hit rate: 95–99% steady state on long sessions.

### Multi-Provider with Adaptive Routing

| Provider | Auth | Notable Models |
|----------|------|----------------|
| DeepSeek | API key | deepseek-v4-pro (1M ctx), deepseek-v4-flash |
| Claude | API key (via `cc-switch` proxy) | opus-4-7, opus-4-6, sonnet-4-5 |
| GLM (Zhipu) | API key | glm-5.2 |
| Codex (GPT-5.5) | OAuth PKCE (ChatGPT subscription) | gpt-5.5 |
| MiniMax | API key | MiniMax-M2.7 |
| MiMo | API key | mimo-v2.5-pro |

Switch providers inside a session with `/model <name>`. Configure different models for main agent vs sub-agents (see [Provider Config](docs/user-guide-provider-config.md)).

### Subagent Orchestration

Delegate sub-tasks to independent headless worker sessions:

- **Typed work orders** — code_search, review, verify, patch_proposal, plan
- **Tool isolation** — read-only workers (scout) vs write workers (patcher)
- **Adaptive model routing** — Per-profile pass-rate + latency scoring auto-selects the best model for each task type
- **Batch dispatch** — Multiple work orders run concurrently with 5 aggregation policies (primary_decides, all_required, first_success, majority, weighted_confidence)
- **Team orchestration** — Plan → wave-based parallel execution with file-conflict-aware scheduling

### Goal-Driven Auto-Continue

Set a high-level goal and Rivet runs autonomously across multiple turns:

```
/goal Refactor the authentication module to use async/await throughout
/cancel-goal   # stop early
```

GoalTracker integrates with the turn loop, doom-loop detection, and delivery gates. Doom-loop thresholds are relaxed in goal mode to allow deeper exploration.

### Rewind

Double-tap **ESC** at any time to open the message history. Select any past user message to rewind the conversation to that point — the agent state, tool history, and session metadata are all rolled back cleanly. Available in both TUI and desktop.

### Council (Multi-Perspective Review)

```
/council <objective>
/council <objective> --rounds 2   # enable rebuttal round
```

Convenes multiple expert seats to review a plan or design, with optional second-round rebuttal when conflicts surface. Produces an auditable Markdown plan with seat contributions and convergence state.

### Skills System

Reusable workflow playbooks loaded from `.rivet/skills/*.md`. Two-layer progressive disclosure: only name + description enters context; full instructions load on demand via the `skill` tool. Import specific Claude Code skills by name in config.

### Cross-Session Knowledge

Distilled knowledge persists across sessions (enabled by default):

| Source | Content |
|--------|---------|
| `.rivet/knowledge/memory.jsonl` | Project rules, debugging heuristics, architecture conventions |
| `.rivet/sessions/<id>/pheromones.json` | Cross-session signals |
| `.rivet/presence.json` | Companion agent awareness |

Toggle via `agent.crossSessionEnabled` in config. Force-off: `RIVET_NO_CROSS_SESSION=1`.

### Approval Modes

| Mode | Behavior |
|------|----------|
| `auto-safe` (default) | Low-risk actions auto-approve; high-risk still asks |
| `manual` | Ask whenever a tool declares approval required |
| `dangerously-skip-permissions` | Skip all interactive prompts — trusted workspaces only |

```bash
rivet config set-approval dangerously-skip-permissions
rivet --dangerously-skip-permissions   # one-session override
```

Skipping prompts does **not** disable tool validation, path safety, evidence tracking, checkpoints, or delivery gates.

## Configuration

### Provider Setup

```bash
# Interactive setup (TTY)
rivet config

# DeepSeek via env var
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default

# GLM
rivet config setup glm --key-env ZHIPU_API_KEY

# Codex OAuth (browser login on first run)
rivet config setup codex --default

# Full config
rivet config show
```

Or edit `~/.rivet/config.json` directly (only overrides needed, defaults are deep-merged):

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
  "agent": {
    "maxTurns": 50,
    "approval": "auto-safe",
    "crossSessionEnabled": true
  },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

### Worker Routing

Use different providers for sub-agents:

```json
{
  "workers": {
    "profiles": {
      "capable": { "provider": "codex", "model": "gpt-5.5" },
      "cheap":   { "provider": "minimax", "model": "MiniMax-M2.7" }
    },
    "routing": {
      "code_edit": "capable",
      "repo_summarization": "cheap"
    }
  }
}
```

### MCP Servers

Connect external tool servers via Model Context Protocol:

```bash
rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp
rivet config mcp add-sse ctx7 http://localhost:3001/sse
rivet config mcp list
```

MCP tools appear as `mcp__<serverId>__<toolName>` and auto-discover at startup.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model [name\|list]` | Show or switch model/provider |
| `/goal <text>` | Set autonomous goal; runs until done |
| `/cancel-goal` | Stop goal execution |
| `/plan` | Enter plan mode (design-first, approval-gated) |
| `/council <text>` | Convene multi-expert review |
| `/compact` | Compact context now |
| `/context` | Show context ledger: health, tokens, rounds, claims |
| `/evidence` | Show evidence summary (files read/modified, tests) |
| `/rollback` | Preview/restore git checkpoint (`confirm` to execute) |
| `/undo` | Undo last file change (preview, `confirm` to restore) |
| `/rewind` | Double-ESC: rewind to a past user message |
| `/sessions` `/resume <n>` | List/restore saved sessions |
| `/effort [off\|low\|medium\|high\|max]` | Control reasoning depth |
| `/theme [name\|list]` | Switch color theme |
| `/skill <name>` | Load a skill's full instructions |
| `/debug [prompt\|cache\|mcp]` | Debug prompt, cache stats, or MCP |
| `/mcp` | MCP server connection status |
| `/memory <text>` | Save session memory entry |
| `/exit` `/quit` | Save session and exit |

Double-tap **ESC** for rewind overlay. Press **Esc** to dismiss any overlay.

## Build & Test

```bash
npx tsc --noEmit                                    # typecheck
npm exec -- tsx --test src/**/__tests__/*.test.ts   # all tests (2700+)
npm run build                                        # tsup bundle
npm run dev                                          # tsup --watch
node dist/main.js                                    # launch TUI
node dist/main.js -p "fix the typo"                  # headless mode
```

## Architecture

```
src/
├── agent/          Core loop, tool pipeline, subagent coordination, verification, delivery gates
│                   250+ modules: loop, turn-orchestrator, coordinator, advisory-bus,
│                   goal-tracker, plan-execution-trace, star-domain, sensorium, immune system, etc.
├── api/            Streaming API client (DeepSeek, GLM, Codex OAuth, multi-provider)
├── prompt/         Prompt engine: frozen prefix + delta appendix + volatile context layers
├── tools/          30+ tools: bash, edit, read/write, grep, glob, run_tests, git, delegate,
│                   deliver_task, plan_submit, council_convene, web_fetch, lsp, etc.
├── tui/            Terminal UI (Ink 6 / React + T9 ANSI engine)
│   ├── engine/     Commit-engine scrollback, input controller, overlay system, stream renderer
│   ├── cockpit/    Multi-panel cockpit: trace, verify, context, safety, model, MCP
│   └── format/     Welcome screen, rewind, activity labels
├── compact/        Three-layer semantic pruning + micro-compact + T7 request-time collapse
├── context/        Context ledger, progressive compaction, claim system, anchor registry
├── config/         Zod-validated config: defaults → ~/.rivet → project overlay
├── server/         Desktop sidecar: session management, REST routes, SSE streaming, task registry
├── platform/       Native module resolution (better-sqlite3 optional)
├── skills/         Skill loading + progressive disclosure
├── lsp/            Language Server Protocol integration
├── mcp/            Model Context Protocol client
└── search/         Semantic search (BM25 + embedding RRF fusion)
```

### Session Data

All session data is stored in-project under `<cwd>/.rivet/`:

```
.rivet/
├── sessions/<id>.jsonl          Conversation log
├── sessions/<id>.meta.json      Metadata: model, turn count, exit state
├── sessions/<id>/cache-log.jsonl  Per-request cache telemetry
├── knowledge/memory.jsonl       Cross-session distilled knowledge
├── artifacts/                   Large output persistence
└── config.json (at ~/.rivet/)   Global config
```

### Multi-Session Isolation

Each launch gets a unique session ID. Session files, checkpoints, and memory are scoped to this ID — multiple TUI instances run in parallel without interference. For maximum isolation, use git worktrees.

## Safety

- **Path boundary enforcement** — glob/grep/diff reject `..` traversal; `validatePath` blocks escapes
- **Symlink cycle protection** — realpath + visited set
- **SSRF protection** — Per-hop DNS + private IP blocking on every redirect
- **Sensitive file rejection** — `.env`, `credentials.*`, `*key*`, `*token*` blocked from read/commit
- **Destructive command gate** — `rm -rf`, force push, `DROP/TRUNCATE` require explicit confirmation
- **Checkpoint + rollback** — Git checkpoint before first file modification each turn
- **File-level undo** — Versioned backups before every write/edit
- **Worker safety** — Timeout budget via AbortController, tool allowlist enforcement

## License

MIT
