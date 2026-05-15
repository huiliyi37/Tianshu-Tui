# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-15T17:39:44.629Z
> Files: 96 tracked | Anatomy hits: 0 | Misses: 0

## ../../../.claude/projects/-Users-banxia-app-deepseek-tui-opencode-tui/memory/

- `MEMORY.md` — Memory (~41 tok)
- `project_open_model_agent_goal.md` (~234 tok)

## ./

- `.gitignore` — Git ignore rules (~23 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `config.example.toml` — ~/.opencode/config.toml (~232 tok)
- `package-lock.json` — npm lock file (~19981 tok)
- `package.json` — Node.js package manifest (~164 tok)
- `README.md` — Project documentation (~3848 tok)
- `tsconfig.json` — TypeScript configuration (~153 tok)
- `tsup.config.ts` (~65 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .superpowers/brainstorm/

- `2026-05-15-rivet-open-model-terminal-agent-fragments.json` (~1635 tok)
- `2026-05-16-rivet-subagent-orchestration-fragments.json` — Rivet subagent orchestration brainstorm fragments (~2146 tok)
- `2026-05-16-rivet-subagent-orchestration-fragments.json` (~2146 tok)

## docs/

- `optimization-design-v2.md` — OpenCode TUI 优化增补设计 (~4002 tok)

## docs/analysis/

- `2026-05-15-handoff.md` — Handoff: Rivet v0.1 — 2026-05-15 (updated P2.2) (~1722 tok)

## docs/superpowers/plans/

- `2026-05-15-rivet-p2-2-capability-reliability-layer.md` — Rivet P2.2 Capability Reliability Layer 实现计划 (~14754 tok)
- `2026-05-15-rivet-p2-3-harness-cockpit-implementation.md` — Rivet P2.3 Harness Cockpit TUI 实现计划 (~13437 tok)
- `2026-05-15-rivet-performance-optimization.md` — Rivet 性能优化与 Claude Code 对标实现计划 (~10205 tok)
- `2026-05-16-rivet-subagent-orchestration-implementation.md` — Rivet 子代理协同 Phase 1 实现计划 (~14672 tok)

## docs/superpowers/specs/

- `2026-05-15-rivet-open-model-terminal-agent-direction-design.md` — Rivet 开源模型终端代理方向深度头脑风暴结果 (~2338 tok)
- `2026-05-15-rivet-p2-1-performance-dev-capability-optimization.md` — P2.1：Rivet 性能层与开发能力层优化建议 (~2607 tok)
- `2026-05-15-rivet-p2-3-harness-cockpit-design.md` — Rivet P2.3 Harness Cockpit TUI 设计 (~3319 tok)
- `2026-05-15-system-prompt-expansion-design.md` — OpenCode TUI System Prompt 架构优化 (~791 tok)
- `2026-05-16-rivet-subagent-orchestration-design.md` — Rivet 主控模型子代理协同能力深度头脑风暴结果 (~7664 tok)

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

- `main.tsx` — Read piped stdin (non-TTY only) as initial input (~2700 tok)

## src/agent/

- `checkpoint.ts` — Create a checkpoint by recording the current HEAD hash and dirty worktree state. (~1577 tok)
- `context.ts` — Replace all messages (used after compaction) (~689 tok)
- `evidence.ts` — Exports EvidenceState, EvidenceTracker (~483 tok)
- `loop.ts` — Exports ApprovalMode, AgentConfig, AgentCallbacks, AgentLoop (~2909 tok)
- `session-persist.ts` — Append a single message to the session file (~532 tok)
- `verification.ts` — Exports VerificationState, emptyVerificationState, addVerificationRun, summarizeVerification + 2 mor (~514 tok)

## src/agent/__tests__/

- `checkpoint.test.ts` — makeTempGitRepo: cleanupRepo (~2001 tok)
- `loop.test.ts` — Creates a mock client that delivers content blocks and then stops (~2900 tok)
- `verification.test.ts` — Declares baseRun (~739 tok)

## src/api/

- `client.ts` — Optional function to normalize usage fields from provider-specific format to standard Usage (~3020 tok)
- `deepseek.ts` — Generic factory: create an ApiClient for any provider described by a (~572 tok)
- `provider.ts` — Describes what a provider supports and how to adapt requests/responses. (~459 tok)
- `sse.ts` — Exports SSEEvent, SSEParser (~602 tok)
- `types.ts` — Exports ContentBlockText, ContentBlockThinking, ContentBlockToolUse, ContentBlockToolResult + 7 more (~552 tok)

## src/api/__tests__/

- `sse.test.ts` — Declares parser (~1419 tok)

## src/compact/

- `auto.ts` — Decide whether automatic compaction should fire. (~1486 tok)
- `constants.ts` — Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+). (~485 tok)
- `index.ts` — Declares CompactionDecision (~104 tok)
- `micro.ts` — MicroCompact: lightweight truncation without API calls. (~682 tok)

## src/compact/__tests__/

- `compact.test.ts` — Declares msg (~1646 tok)

## src/config/

- `default.ts` — Exports DEFAULT_CONFIG (~298 tok)
- `schema.ts` — Zod schemas: modelConfigSchema, providerSchema, agentSchema, compactSchema + 2 more (~588 tok)

## src/failures/

- `sample.ts` — Exports createFailureSample, redactSecrets (~200 tok)

## src/failures/__tests__/

- `sample.test.ts` — Declares sample (~300 tok)

## src/model/

- `capability.ts` — Exports ModelCapabilityCard, recommendModelForTask (~400 tok)

## src/model/__tests__/

- `capability.test.ts` — Declares card (~250 tok)

## src/prompt/

- `engine.ts` — Build a request. Volatile context is injected as an independent user message (~785 tok)
- `fingerprint.ts` — Exports PrefixFingerprint, DriftEvent, computeFingerprint, detectDrift (~400 tok)
- `static.ts` — Exports StaticPromptContext, buildSystemPrompt (~780 tok)
- `volatile.ts` — Build the volatile `<context>` block injected into the user message. (~563 tok)

## src/prompt/__tests__/

- `fingerprint.test.ts` — Declares SAMPLE_TOOLS (~1599 tok)

## src/repo/

- `context-bundle.ts` — Exports buildContextBundle (~350 tok)
- `import-graph.ts` — Exports buildImportGraph (~300 tok)
- `symbol-index.ts` — Exports buildSymbolIndex (~400 tok)

## src/repo/__tests__/

- `symbol-index.test.ts` — Declares idx (~250 tok)

## src/tools/

- `bash.ts` — Exports BASH_TOOL (~1107 tok)
- `diff.ts` — Exports DIFF_TOOL (~1291 tok)
- `edit.ts` — Exports EDIT_FILE_TOOL (~942 tok)
- `glob.ts` — /*.ts") (~1317 tok)
- `grep.ts` — Exports GREP_TOOL (~2330 tok)
- `output-store.ts` — Exports ToolOutputMeta, persistRawOutput, buildModelOutput, buildUiOutput (~794 tok)
- `path-validate.ts` — Exports ValidatedPath, InvalidPath, PathValidationResult, validatePathSafe, validatePath (~241 tok)
- `read-file.ts` — Exports READ_FILE_TOOL (~654 tok)
- `registry.ts` — Exports ToolRegistry (~304 tok)
- `run-tests.ts` — Exports RUN_TESTS_TOOL (~3052 tok)
- `truncation.ts` — Exports truncateContent (~112 tok)
- `types.ts` — Content sent to model as tool_result (~270 tok)
- `write-file.ts` — Exports WRITE_FILE_TOOL (~508 tok)

## src/tools/__tests__/

- `diff.test.ts` — makeParams: git (~887 tok)
- `edit.test.ts` — TEST_DIR: makeParams (~832 tok)
- `glob.test.ts` — /*.ts' })) (~1200 tok)
- `grep.test.ts` — Exports helper (~1243 tok)
- `output-store.test.ts` — Declares meta (~1015 tok)
- `path-validate.test.ts` — Declares result (~621 tok)
- `run-tests.test.ts` — makeParams: setupProject (~993 tok)

## src/tui/

- `app.tsx` — MAX_VISIBLE_LOGS (~5897 tok)
- `base-text-input.tsx` — BaseTextInput — uses useState, useEffect, useCallback (~934 tok)
- `history.ts` — Persistent TUI prompt history load/append helpers (~203 tok)
- `input.tsx` — InputBar — uses useState (~208 tok)
- `status-bar.tsx` — StatusBar (~245 tok)
- `stream.tsx` — StreamOutput (~105 tok)
- `thinking.tsx` — ThinkingCollapser — uses useState (~242 tok)
- `tool-card.tsx` — MAX_COLLAPSED_LINES (~320 tok)
