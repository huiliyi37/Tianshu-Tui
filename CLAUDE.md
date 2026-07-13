# Rivet

Terminal coding agent optimized for DeepSeek V4 prefix cache. Node.js 24+ (`engines` pins 24.1.0) / TypeScript strict / 纯 ANSI 终端 UI（`src/tui/engine/`，零 React/Ink 渲染） / node:test。桌面端 `desktop/` 是独立的 React 应用；`src/tui/command-palette.tsx` 是仅存的 Ink 组件残留（main.ts 只用它的纯函数，待清理）。

## Build & Test

```bash
npm install && npm run build
npm test          # ~820 test files, node:test + node:assert/strict (runner: scripts/run-node-tests.ts)
npm run typecheck # tsc --noEmit
```

## Architecture

```
main.ts → AgentLoop (agent/loop.ts)
  ├── RuntimeHookPipeline (agent/runtime-hooks.ts)  ← TUI 2.x 核心
  │     纯分阶段执行器 + 错误隔离（任一 hook 抛错只走 onError，不中断 turn）
  │     5 阶段真实调用点（非概念，已钉在 loop 主路径）：
  │       preTurn / afterPerception → turn-perception.ts
  │       postTool                  → tool-execution.ts（每个工具执行后）
  │       runCompaction             → turn-orchestrator.ts（postTool 后、postTurn 前）
  │       postTurn                  → turn-completion.ts
  │       postSession               → loop.ts（经 turn-orchestrator 调度）
  │     hooks 由 createDefaultRuntimeHooks() 条件装配（create-runtime-hooks.ts），
  │       约 37 种（src/agent/hooks/ 有 39 文件），按 deps/开关 gated。默认会话实际激活 ~18+：
  │       常驻 8（base 数组无条件）：perception, signal-consumer, kick,
  │               vigor×2(afterPerception+postTool), theta, stigmergy, radio
  │       advisoryBus 恒构造(loop.ts) → 这批默认全开：self-verify、edit-tool-advisory、
  │               lossy-observation、spec-verify-gate、typecheck-reminder、todo-reminder、
  │               context-pressure(需 token getter)、dedup-guard(需 streamedText getter)
  │       deps-gated（默认多为真）：playbook-reflect、anchor-break-shadow、dream/skill-distill、
  │               meridian、telemetry-flush、physarum-file-access、memory-learning、courage/ccr(starSoul)
  │       默认关(opt-in)：songline、constellation、hearth-observe、companion、
  │               dispatcher(自动委派)、anchor-break-scout、mcts-planning/blind-exploration(antiAnchoring)
  ├── AgentSession (messages, usage, turn count)
  ├── EvidenceTracker + FileHistory
  ├── Stores: claim-store, stigmergy-store, playbook-store, trace-store
  └── Tool dispatch → API (SSE streaming) → TUI (纯 ANSI, src/tui/engine/)
```

> ⚠️ 旧文档写「9 个固定 hook」是误导性简化。真相是条件装配，开关在 `loop-factory.ts:createRuntimeHooksPipeline` 传入的 deps。改 hook 行为前先看 `create-runtime-hooks.ts` 的 gate 条件，不要假设某 hook 一定在跑。

Key modules: `src/agent/` (loop, hooks/, session, sub-agent, coordinator), `src/api/` (client, codex-client, error-classifier), `src/tui/` (app, stream, render-batch, steer-buffer), `src/tools/`, `src/compact/`, `src/context/`, `src/auth/`

## Conventions

- Node.js test runner (`node:test` + `node:assert/strict`), not Vitest or Jest
- ESM with `.js` extension in imports
- Immutable patterns — spread operator, no mutation
- Error classification via `classifyApiError()` — no ad-hoc status code checks in clients
- Tests: `src/**/__tests__/*.test.ts` mirrors source structure

## Known Constraints

- **Prefix cache is the core optimization.** System prompt and early messages must stay stable within a session — avoid rewriting history or injecting before anchor points.
- DeepSeek V4 may emit tool JSON in text content (`hasToolJsonInContentBug` in client config)
- Codex client receives text via both `output_text.delta` and `output_item.done` — `seenTextDelta` dedup handles this
- Agent loop `onTurnComplete(usage, turn, isFinal)` — intermediate turns keep writer alive, only final turn destroys it
- User input during streaming goes to SteerBuffer (not direct interrupt), injected at next tool result
- **星域 `toolWhitelist` 是生效的工具交集过滤器，对当前内置域退化为恒等。** `star-domain.ts` 有 11 个域（天枢/破军/天府/天梁/天权/天机/天璇/辅/文曲/瑶光/华盖）。worker 创建时 `allowedTools = profile.allowedTools ∩ domain.toolWhitelist`（`work-order.ts:toolsForAuthority`）。当前 11 域白名单**逐字相同且是全集** → 对内置域交集退化为恒等（no-op），域间行为差异只来自 `systemPromptSuffix`/`volatileBlock`/`courageThreshold`/`decisionStyle`。但机制本身**真实生效**，三处会咬人：①profile 若含白名单外工具（`web_search`/`council_convene`/`browser` 等），设了 authority 就被静默削掉；②authority 拼错/域未加载 → **fail-closed 返回 `[]` deny-all**（有意护栏，勿改成回退 profile 全集）；③自定义域（card frontmatter）的 `toolWhitelist` 完全生效，会真实削减工具。改它前先想清楚命中的是哪种场景。
- **Hook 信号经 AdvisoryBus 统一收编后注入**（`59e52394`）。hook 不直接改 prompt，只能用 `RuntimeHookEffects`（`injectUserMessage`/`emitPhaseChange`/`setStrategy`…）；带 priority/ttl/category 的信号优先 `advisoryBus.submit`，降级才 `injectUserMessage`。注入走 system-reminder 通道，不重写 `frozenBase`/`volatileBlock`。
- **重构事故链四层防线（2026-07-04）**：①`planner` profile 有 balanced hardFloor，议事会席位瑶光门（`tierHint`+`noDowngrade`）经 `seatTierFloor` → `WorkOrder.tierFloor` 接线到真实派发（只抬升不降级）；计划文件带产出模型留痕（`> **Model: …**` 行），cheap 产出在 TUI/桌面审批面显示警告。②plan submit 规模门禁：任务 >8 或文件 >15 且无分波结构 → one-shot 软拦；`plan-executor` 波间硬门禁（`wave-gate.ts`）：非末波完成后 typecheck + 白名单验证命令必须过，失败硬拦下一波 dispatch（入口复评自愈；`RIVET_WAVE_GATE=0` 禁用）。③重构类计划强制 `full` 方法论 + 「回归清单」章节；清单经 `TaskContract.regressionInventory` / 最近 APPROVED 计划流入 `deliver_task`，交付前逐项 git grep 核验（advisory 不阻断）。④`regression-bisect-hook`（postTool，`RIVET_REGRESSION_BISECT=0` 禁用）：回归语义 + ≥5 轮只读诊断空转 → constitutional advisory 强制切基线对照（git log → bisect/checkpoint diff → 清单定位）；convergence level 3 对回归场景优先建议 bisect 而非开新对话。
- **压缩历史重写只在 `turn===0`（用户边界）。** `compact-boundary-coordinator.ts` 的 `runCompaction` 是五级阶梯（会话分裂→maybeCompact→T9 质量压缩→陈旧轮压缩→堆驱动微压缩），命中即止。turn 中途只置 pending flag 延迟到 turn 0；1M 窗口跳过/延迟一切重写；`shouldDelayCompact` 在缓存健康时不压——全为保前缀缓存。
- **appendix 块必须字节稳定（2026-07-06）**：`appendixDelta` 默认开，字节恒定块入场付一次、稳态零重发、压缩后随 baseline 自动补课——新增 appendix 块前先回答"信息是否已在消息历史里？能否做到语义变化才字节变化？"。量化在**渲染层**做（tool-context 10% 桶、mirror low/mid/high 三档），不在 `buildAppendixBody` 加语义哈希/特判（评审否决过，见 `docs/changelog/2026-07-06-appendix-delta-byte-stability.md`）。tool-history 块已删（与消息历史冗余）；plan-mode 块恒定 full 无节律。已知遗留 churner：historical-lessons 每边界按 recentQuery 重排。
- **frozen 快照 commit 不得依赖可被清空的状态（2026-07-06）**：`frozenPendingMerged` 的边界 commit 由 pending map 自身驱动（`buildOaiRequest` 前置清扫），**绝不能**以 `cachedFreshForUser` 之类会被 `invalidateFreshCache()` 清空的变量做守卫——`setIntentRetrievalRoute` 每条用户消息必触发 invalidate，落在两轮之间就孤儿化快照 → 每边界 FATAL fallback + prefix_truncation（单次最高重建 18.9 万 token）。fallback 重建结果必须回存自愈（否则每请求字节翻转）。invalidate 时**不要**提前 commit（会留陈旧中间版快照）。回归测试必须覆盖"invalidate 落在两轮之间"的生产序列，"同轮再 build"通过不代表安全。见 `docs/changelog/2026-07-06-frozen-snapshot-orphan-fix.md`。
- **request 对象会被多个 `stream()` 重入，client 变换层禁止 mutation（2026-07-06）**：llm-speculation 复用主请求的消息对象、`FallbackStreamClient` failover 重放同一 request——`openai-client.stream()` 内一切消息改写（system suffix 等）必须 copy-on-write，`content +=` 原地 mutation 会在重入时双写 → system 字节中途翻转 → 该请求整段前缀缓存 miss（且侧路不记 usage，成本隐形）。侧路请求用 `{...mainRequest}` 展开时必须显式剥 `prefixProbe`（主路径专属标志），否则 wire 探针基线被毒化、下一主轮报幻影 `wireDiverged`。见 `docs/changelog/2026-07-06-llm-speculation-suffix-double-append.md`。

## MCP Tools: code-review-graph

### Anti-patterns (NEVER do these)

These patterns waste 5-10× the necessary tool calls when the code-review-graph MCP can answer directly. The graph indexes call relationships, imports, and inheritance — one query replaces many file reads.

- **NEVER** grep/glob/read in a loop to explore code when `query_graph` or `semantic_search_nodes` can answer in one call
- **NEVER** spawn an Explore sub-agent for questions that `query_graph pattern="callers_of"` or `get_impact_radius` can answer directly
- **NEVER** read an entire file to find a function — use `semantic_search_nodes` then `get_review_context` for the relevant snippet
- **Prefer composite queries**: `detect_changes_tool` + `get_affected_flows` replaces manual diff → grep → read chains
- **One graph call replaces 5-10 file reads** — always check graph tools first when the question is "who calls / who imports / what's affected"

## Star Lore

星图叙事与伙伴星定义见 [star.md](./star.md)。
