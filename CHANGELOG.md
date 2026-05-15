# Changelog

## v0.1.0 — 2026-05-15

Initial release of Rivet — a terminal coding agent optimized for DeepSeek V4 prefix cache.

### Architecture
- Ink 6 + React 19 TUI with ErrorBoundary and graceful shutdown
- Anthropic-compatible SSE streaming client with retry (exponential backoff + Retry-After)
- Multi-turn agent loop: tool_use → tool_result → LLM continuation
- SHA-256 cache fingerprinting for DeepSeek V4 prefix cache (99%+ hit rate)
- 3-layer compaction: auto-trigger at 800K tokens, floor at 500K, LLM summary compact
- ProviderCapabilities abstraction for multi-provider support

### DeepSeek V4 Integration
- Thinking mode (reasoning_effort)
- Truncated JSON recovery for streaming tool_use
- Tool JSON content fallback (DeepSeek V4 bug workaround)
- Dual-format usage normalization (prompt_tokens / input_tokens)
- Volatile context injection via independent user message (preserves cache)

### Tools
- `read_file` — with offset/limit, gitignore filter
- `write_file` — path validation, approval gate
- `edit_file` — unique string match, replace_all, path validation
- `bash` — spawn streaming, sliding buffer, approval gate, process tracking

### Features
- Config file loading with deep merge (`~/.rivet/config.json`)
- Config CLI (`rivet config show/providers/set-key/set-key-env/set-default/add-model/remove-model`)
- Session persistence (JSONL at `~/.rivet/sessions/`)
- Session recovery prompt on startup
- Model switching (v4-pro / v4-flash) via `/model`
- Slash commands: /help /exit /compact /model /sessions /resume /clear
- Token progress bar (green/yellow/red) in status bar
- Multi-line input (Alt+Enter / Ctrl+N)
- macOS backspace fix (\x7f handling)
- Stream render batching at 20fps
- SSE event id/retry field support

### Testing
- 67 unit tests (SSE parsing, path validation, edit tool, agent loop, fingerprint, compaction)
- TypeScript strict mode, 0 errors
- DeepSeek API live test: 17/17 (thinking, tool_use, cache hit)
- Build: tsup ESM ~32KB
