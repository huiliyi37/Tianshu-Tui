### 2026-06-01 — Seed Capsule Engine 不适合用 heuristicRules 注入

**Kind**: architectural_invariant / selection_rule

**Claim**: 天璇种子胶囊的 L1 核心文本不应通过 `PromptEngine.setHeuristicRules()` 注入——当前 PromptEngine 不存在该方法，也不存在 `heuristicRules` 概念。实际落地方式：通过 `VolatileContext.seedCapsuleBlock` 字段渲染到 `buildVolatileBlockInternal` 的 frozen base 中（与 `projectMemoryBlock` 同级），session 全程稳定，prefix cache safe。

**Applies when**:
- 后续实现 Phase 2 capsule 触发注入（L2/L3）
- 天府、破军等星域各自封存胶囊时

**Store**: `src/agent/seed-capsule-store.ts` → `loadTianxuanCapsule()` → `src/prompt/volatile-snapshot.ts` → `VolatileContext.seedCapsuleBlock` → `buildVolatileBlockInternal()` frozen base

### 2026-06-01 — deliver_task 门禁 tool_invocation_failure 不应永久阻塞

**Kind**: architectural_invariant

**Claim**: `tool_invocation_failure`（run_tests 超时等，特征为 `passed === 0 && failed === 0 && skipped === 0`）是基础设施问题而非代码质量问题。代理的唯一正确响应是重跑测试。将其标记为 RED 会导致超时永久阻塞交付，因为不同 filter 字符串生成不同的 `verificationKey` 导致 supersession 失败。

**Fix** (三层):
1. `delivery-gate-v2.ts`: `tool_invocation_failure` RED → YELLOW（非阻塞）
2. `run-tests.ts`: 填充 `verification.targetFiles` 使 supersession 基于实际测试文件而非命令字符串
3. `verification-attribution.ts`: `verificationKey` 优先使用 `meta.targetFiles`

**Store**: `src/agent/delivery-gate-v2.ts:232`, `src/tools/run-tests.ts:306`, `src/agent/verification-attribution.ts:122`

### 2026-05-27 — session 8f2bcf2d

**Modified** (3): /Users/banxia/app/deepseek-tui/opencode-tui/docs/codebase-index.md, /Users/banxia/app/deepseek-tui/opencode-tui/README.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/specs/2026-05-26-claude-code-feature-gap-analysis.md
**Read** (3): /Users/banxia/app/deepseek-tui/opencode-tui/docs/codebase-index.md, /Users/banxia/app/deepseek-tui/opencode-tui/README.md, /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/specs/2026-05-26-claude-code-feature-gap-analysis.md
**Tests**: ⚠️ unverified
**Tools used**: edit_file×6, bash×6, read_file×4, glob×2, grep×2, todo×1
- Decision: make three targeted changes:

1
- Decision: update these sections to mark them as done

### 2026-05-27 — Memory Selection Principle

**Kind**: architectural_invariant / selection_rule

**Claim**: Project memory should preserve high-level scout findings, design principles, and architecture invariants — not low-level execution traces.

**Why it matters**:
Current Dream distillation can turn session telemetry into prompt noise: modified files, tools used, ordinary test failures, unverified markers, and transient worker/tool errors. Tianshu usually recovers from these low-level failures through tool feedback, state hints, verification gates, and alternate paths. Re-injecting them as long-term prompt memory is low value and can dilute the truly useful design signal.

**Applies when**:
- deciding whether a session-end finding belongs in `.rivet/knowledge/project-memory.md`
- designing or modifying `src/agent/dream.ts`
- deciding what should be injected into prompt vs kept for recall/search
- triaging whether a failure pattern is structural or merely transient

**Store**:
- scout convergence insights
- architecture invariants
- selection rules that affect future tradeoffs
- conceptual reframes
- reusable design patterns

**Do not store**:
- modified/read file lists
- tools-used counts
- ordinary unverified markers
- transient test/tool/schema failures
- worker blocked events unless they reveal a structural design constraint
- personal or Navigator preferences as automatic Dream output
- information already represented well by git history, session logs, delivery gate, or test output

**Evidence**:
- `docs/analysis/2026-05-27-project-memory-signal-vs-noise.md`
- `docs/superpowers/specs/2026-05-17-project-memory-dream-design.md`
- `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md`
- `docs/superpowers/assets/2026-05-19-tianxuan-design-notes.md`

### 2026-05-27 — Memory Is Selection, Not Storage

**Kind**: conceptual_reframe / architectural_invariant

**Claim**: The project-memory problem is not primarily storage; it is selection. Without selection pressure, memory becomes an archive cabinet and eventually prompt noise.

**Why it matters**:
A local knowledge file is valuable only if it improves future judgment. The system should ask: “Will this change how a future agent decides?” not “Did this happen?” Low-level session facts should move to session logs or analysis docs; curated project memory should stay small, judgement-oriented, and reusable.

**Applies when**:
- designing Dream write gates
- deciding whether to default-inject `.rivet/knowledge/*.md`
- choosing between automatic memory and human/agent-curated memory

**Selection gate**:
A candidate memory should enter project memory only if it is one of:

1. convergence insight
2. architecture invariant
3. selection rule
4. conceptual reframe
5. reusable design pattern

Otherwise it should be discarded, kept as session log, or promoted to `docs/analysis` / `docs/superpowers` if it needs human-readable archival.

**Evidence**:
- `docs/analysis/2026-05-27-project-memory-signal-vs-noise.md`
- `docs/superpowers/specs/2026-05-16-rivet-evolutionary-tui-memory-design.md`
- `docs/superpowers/specs/2026-05-17-project-memory-brainstorm.md`

### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: 实时系统的敌人不是慢，而是边界模糊；审查的价值不是否定实现，而是让每个边界在出错前被看见。

**Why it matters**:
In streaming systems, many failures appear as latency or UI stall, but the root cause is often an unclear boundary: provider delta vs agent turn semantics, UI rendering vs session history, chunk-level noise vs cross-turn narrative repetition, partial prefix match vs final duplicate. Optimizing speed before naming these boundaries can make the system feel faster while silently swallowing valid output or preserving duplicated context.

**Applies when**:
- designing real-time token/delta streaming
- reviewing deduplication or suppression logic
- deciding whether logic belongs in provider stream handling, AgentLoop turn semantics, TUI rendering, or session memory
- diagnosing "stuck" UI reports that may actually be boundary/visibility failures

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream. During streaming, only classify prefix/divergence and buffer if necessary; make final suppression decisions at stream boundaries. UI dedup and session-history dedup must be treated as separate contracts unless explicitly unified.

**Evidence**:
- `docs/analysis/2026-05-27-streaming-dedup-review-addendum.md`
- `docs/analysis/2026-05-27-tui-stall-visibility-fix.md`
- `src/agent/turn-stream.ts`
- `src/agent/loop.ts`

### 2026-05-27 — Scout Findings Are Higher-Value Memory Than Execution Telemetry

**Kind**: convergence_insight

**Claim**: Scout findings and brainstorm convergence are usually more useful to future Tianshu agents than raw failure patterns or execution telemetry.

**Why it matters**:
Scout outputs often identify seams, hidden assumptions, cross-domain analogies, and design constraints. Those alter future architectural judgment. By contrast, ordinary failures are usually handled locally during execution and do not deserve long-term prompt weight.

**Examples of high-value memory shape**:
- “Subagent coordination is not about more concurrency; it is about typed work order/result packets plus primary authority.”
- “SessionContext is mutable shared state; workers must use independent sessions.”
- “Collaboration is not sharing all memory, but passing the right granularity at the right time.”

**Applies when**:
- extracting lessons from brainstorm/spec documents
- deciding what to summarize from worker/scout results
- curating `.rivet/knowledge/project-memory.md`

**Evidence**:
- `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md`
- `docs/superpowers/assets/2026-05-19-tianxuan-design-notes.md`
- `docs/superpowers/plans/2026-05-24-immune-system-completion.md`
