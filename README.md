# OpenCode TUI

A coding agent TUI optimized for prefix cache with DeepSeek V4 (1M context window).
99%+ cache hit rate, ~¥0.03 per request.

## Install

```bash
cd opencode-tui && npm install && npm run build
```

## Quick Start

```bash
export DEEPSEEK_API_KEY=sk-xxx
node dist/main.js
```

## Features

- **99%+ cache hit rate** — System prompt SHA-256 fingerprinting + three-region cache model
- **1M context window** — DeepSeek V4 Pro/Flash support with automatic compaction at 800K tokens
- **Multi-provider** — DeepSeek, Mimo, Kimi, GLM, Qwen (Anthropic-compatible)
- **TUI** — Built with Ink 5 (React for CLI), streaming responses, thinking collapse

## Configuration

Copy `config.example.toml` to `~/.opencode/config.toml` and edit.

## Development

```bash
npm run typecheck    # TypeScript check
npm run build        # Build with tsup
npm run dev          # Watch mode
```

## License

MIT
