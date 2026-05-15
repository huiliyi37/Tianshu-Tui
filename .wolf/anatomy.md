# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-15T11:15:57.991Z
> Files: 58 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~10 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `config.example.toml` — ~/.opencode/config.toml (~232 tok)
- `package-lock.json` — npm lock file (~19981 tok)
- `package.json` — Node.js package manifest (~164 tok)
- `README.md` — Project documentation (~1347 tok)
- `tsconfig.json` — TypeScript configuration (~153 tok)
- `tsup.config.ts` (~65 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `optimization-design-v2.md` — OpenCode TUI 优化增补设计 (~4002 tok)

## docs/superpowers/specs/

- `2026-05-15-system-prompt-expansion-design.md` — OpenCode TUI System Prompt 架构优化 (~791 tok)

## prompts/

- `base.md` — Environment (~136 tok)

## prompts/tools/

- `bash.md` — Bash Tool (~295 tok)
- `edit.md` — Edit File Tool (~147 tok)
- `read.md` — Read File Tool (~179 tok)
- `write.md` — Write File Tool (~142 tok)

## scripts/

- `test-deepseek.ts` — DeepSeek API End-to-End Test Harness (~3914 tok)

## src/

- `main.tsx` — deepMerge — uses useState, useMemo, useCallback (~1501 tok)

## src/agent/

- `context.ts` — Replace all messages (used after compaction) (~689 tok)
- `loop.ts` — Compact messages when context window pressure is high. (~1990 tok)
- `session-persist.ts` — Append a single message to the session file (~532 tok)

## src/agent/__tests__/

- `loop.test.ts` — Creates a mock client that delivers content blocks and then stops (~2900 tok)

## src/api/

- `client.ts` — Optional function to normalize usage fields from provider-specific format to standard Usage (~3020 tok)
- `deepseek.ts` — Generic factory: create an ApiClient for any provider described by a (~572 tok)
- `provider.ts` — Describes what a provider supports and how to adapt requests/responses. (~456 tok)
- `sse.ts` — Exports SSEEvent, SSEParser (~602 tok)
- `types.ts` — Exports ContentBlockText, ContentBlockThinking, ContentBlockToolUse, ContentBlockToolResult + 7 more (~552 tok)

## src/api/__tests__/

- `sse.test.ts` — Declares parser (~1419 tok)

## src/compact/

- `auto.ts` — Decide whether automatic compaction should fire. (~1486 tok)
- `constants.ts` — Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+). (~485 tok)
- `index.ts` — Declares CompactionDecision (~104 tok)
- `micro.ts` — MicroCompact: lightweight truncation without API calls. (~685 tok)

## src/compact/__tests__/

- `compact.test.ts` — Declares msg (~1611 tok)

## src/config/

- `default.ts` — Exports DEFAULT_CONFIG (~298 tok)
- `schema.ts` — Zod schemas: modelConfigSchema, providerSchema, agentSchema, compactSchema + 2 more (~584 tok)

## src/prompt/

- `engine.ts` — Build a request. Volatile context is injected as an independent user message (~785 tok)
- `fingerprint.ts` — Exports PrefixFingerprint, DriftEvent, computeFingerprint, detectDrift (~400 tok)
- `static.ts` — Exports StaticPromptContext, buildSystemPrompt (~780 tok)
- `volatile.ts` — Build the volatile `<context>` block injected into the user message. (~563 tok)

## src/prompt/__tests__/

- `fingerprint.test.ts` — Declares SAMPLE_TOOLS (~1599 tok)

## src/tools/

- `bash.ts` — Exports BASH_TOOL (~1107 tok)
- `edit.ts` — Exports EDIT_FILE_TOOL (~942 tok)
- `path-validate.ts` — Validate that a file path resolves within the project directory. (~174 tok)
- `read-file.ts` — Exports READ_FILE_TOOL (~654 tok)
- `registry.ts` — Exports ToolRegistry (~304 tok)
- `truncation.ts` — Exports truncateContent (~112 tok)
- `types.ts` — Exports ToolCallParams, ToolResult, Tool (~138 tok)
- `write-file.ts` — Exports WRITE_FILE_TOOL (~508 tok)

## src/tools/__tests__/

- `edit.test.ts` — TEST_DIR: makeParams (~832 tok)
- `path-validate.test.ts` — Declares result (~479 tok)

## src/tui/

- `app.tsx` — MAX_VISIBLE_LOGS — renders map — uses useState, useRef, useCallback (~3142 tok)
- `base-text-input.tsx` — BaseTextInput — uses useState, useEffect, useCallback (~934 tok)
- `input.tsx` — InputBar — uses useState (~208 tok)
- `status-bar.tsx` — StatusBar (~245 tok)
- `stream.tsx` — StreamOutput (~105 tok)
- `thinking.tsx` — ThinkingCollapser — uses useState (~242 tok)
- `tool-card.tsx` — ToolCard (~137 tok)
