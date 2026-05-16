# Rivet Progressive Context Engine 方案设计

## 背景

用户目标：参考 `/Users/banxia/app/opencode/claude-code-haha`，优化 Rivet TUI 的上下文工程、渐进式上下文与核心架构能力。

这不是单个 `/compact` 命令增强，也不是 TUI 展示小修，而是把 Rivet 的“消息历史 → 压缩 → 工作记忆 → prompt 注入 → TUI 可观测”升级为一条稳定的上下文生命周期链路。

当前 Rivet 已具备：

- DeepSeek V4 prefix-cache 优先的 prompt layering。
- `src/compact/micro.ts` 的轻量截断。
- `src/compact/auto.ts` 的 LLM summary compact。
- `SessionContext` 的消息、token、cache history、文件/测试追踪。
- `SessionPersist` JSONL 会话保存与恢复。
- `/compact`、`/resume`、`/debug prompt|fingerprint|cache` 等 TUI 命令。
- `PromptEngine` 的 tool_use/tool_result 最终兜底 normalization。

参考项目 `claude-code-haha` 的可借鉴能力：

- microcompact 先清理旧工具结果，零 API 成本降 token。
- session memory compact：后台维护 session memory 文件，compact 时复用，不每次临时总结。
- reactive compact：按 API round 分组，从旧区间开始总结。
- compact boundary adjustment：不切断 tool_use/tool_result 与 thinking/message 关系。
- TUI context visualization、token warning、compact boundary marker、memory indicator。
- autocompact threshold 与 circuit breaker，避免 compact failure loop。

---

## 设计目标

Rivet 应升级为 **Cache-first Progressive Context Engine**。

核心目标：

1. 长会话不能靠“快满了就截断”维持，而应持续维护上下文状态。
2. compact 不能破坏 Anthropic-compatible API 的 `tool_use` / `tool_result` 配对不变量。
3. compact 不能频繁扰动 DeepSeek prefix cache。
4. session resume 必须有 preflight，不应直接把 raw JSONL 塞回模型。
5. TUI 必须让用户看见上下文健康状态，而不是黑盒自动压缩。
6. 后续 subagent、verification、repo intelligence 都能复用同一套 context ledger。

非目标：

- 第一阶段不做 vector DB / RAG。
- 第一阶段不重写整个 prompt system。
- 不直接照搬 `claude-code-haha` 的文件结构。
- 不把 PromptEngine normalization 当成正常 compact 机制；它只做最后兜底。

---

## 总体架构

```text
Raw JSONL Transcript
  ↓
API Round Grouping
  ↓
Context Ledger
  ↓
Progressive Compaction Ladder
  ↓
Session Memory / Working Set / Recent Turns
  ↓
Prompt Context Layers
  ↓
TUI Context Cockpit
```

每轮模型请求的上下文应保持分层：

```text
L1 Stable System Prompt         稳定，不频繁变，保护 DeepSeek prefix cache
L2 Tool Definitions             稳定，参与 fingerprint
L3 Session Memory               渐进摘要：决策、错误、文件、未完成任务
L4 Active Working Set           当前涉及文件、测试、风险、最近验证
L5 Recent Raw Turns             最近几轮完整消息和工具结果
L6 User Current Request         当前输入
```

关键原则：

- `system` 与 `tools` 不因 session memory 或 working set 变化。
- volatile context 继续作为独立 user message 注入。
- XML section 顺序固定，空字段也输出空 tag。
- 文件列表、anchor 列表排序稳定。
- compact summary 替换中间消息，不修改开头 cache anchor。
- 所有 compact boundary 必须落在 API-safe round 边界。

---

## 核心组件设计

### 1. Context Ledger

Context Ledger 是会话级上下文账本，是 progressive context 的中心状态。

职责：

- 记录每一轮消息属于哪个 API round。
- 记录 compacted spans。
- 记录 session memory freshness。
- 记录 working set。
- 记录 context budget 与 cache 状态。
- 给 prompt layer 和 TUI 提供统一上下文状态。

建议数据结构：

```ts
interface ContextLedger {
  sessionId: string
  transcriptPath: string
  rounds: ContextRound[]
  anchors: ContextAnchor[]
  workingSet: WorkingSetEntry[]
  compactedSpans: CompactedSpan[]
  sessionMemory: SessionMemoryState
  tokenBudget: ContextBudget
  apiInvariantStatus: ApiInvariantStatus
  cacheStatus: CacheStatus
}
```

#### ContextRound

```ts
interface ContextRound {
  id: string
  startMessageIndex: number
  endMessageIndex: number
  turnNumber: number
  hasToolUse: boolean
  hasToolResult: boolean
  tokenEstimate: number
  compactableTokenEstimate: number
  apiInvariant: 'ok' | 'repaired' | 'broken'
}
```

#### CompactedSpan

```ts
interface CompactedSpan {
  id: string
  strategy: 'micro' | 'session_memory' | 'reactive' | 'emergency'
  startRound: number
  endRound: number
  tokenBefore: number
  tokenAfter: number
  summaryPath?: string
  rawTranscriptPath: string
  createdAt: number
}
```

#### ContextAnchor

```ts
interface ContextAnchor {
  kind: 'decision' | 'error' | 'user_preference' | 'pending_task' | 'file' | 'verification'
  text: string
  sourceRound: number
  salience: number
}
```

#### SessionMemoryState

```ts
interface SessionMemoryState {
  path: string
  lastSummarizedRound: number
  lastUpdatedAt: number
  digest: string
  stale: boolean
  tokenEstimate: number
}
```

---

### 2. API Round Grouping

Raw `Message[]` 在 compact 前必须先被分成 API-safe rounds。

Round 示例：

```text
Round 1:
  user
  assistant text/tool_use
  user tool_result

Round 2:
  user
  assistant
  user tool_result
```

边界规则：

- assistant `tool_use` 和紧邻 user `tool_result` 不能被分开。
- 同一个 assistant message 内的 thinking/text/tool_use blocks 不能被分开。
- orphan `tool_result` 可以被标记为 invalid/repaired，但 compact boundary 不能制造新的 orphan。
- synthetic tool result 只能作为恢复兜底，不作为正常 compact 依赖。

设计借鉴：

- `claude-code-haha` 的 `adjustIndexToPreserveAPIInvariants`。
- 按 message id / API round 分组，避免按 message count 粗切。

Rivet 当前 `PromptEngine` 已有 normalization，但那应该保留为最后防线。正常路径中，context layer 应在 compact 前就保证 API invariant。

---

### 3. Progressive Compaction Ladder

Rivet 不应该只有一种 compact。应按成本从低到高形成梯度。

#### Tier 0：No-op / Context Budget Check

每轮结束只更新 token estimate、cache hit、working set，不改 messages。

触发条件：

```text
estimatedTokens < warningThreshold
```

结果：

- TUI 显示 healthy。
- 不 compact。

---

#### Tier 1：Microcompact Tool Results

作用：把旧工具结果的大正文替换成 stub，但保留工具调用结构。

示例：

```text
Before:
tool_result:
  content: 很长的 grep / build / test output

After:
tool_result:
  content: [Old bash result compacted: 842 lines, raw at /tmp/rivet-raw/xxx.raw]
```

适合压缩：

- bash output
- read_file output
- grep/glob output
- test output
- web fetch output
- diff output

不适合压缩：

- 最近 N 轮工具结果
- 用户刚引用过的 raw output
- 当前失败诊断依赖的错误片段
- approval/security 相关内容

要求：

- 保留 `tool_use_id`。
- 保留 `is_error`。
- 保留 `rawPath`。
- 保留少量 head/tail 摘要。
- 写入 ledger：这个 span 被 microcompacted。
- 不改变 tool_use/tool_result 配对。

这是应优先实现的一层，因为零 API 成本、低风险、立刻降低 token 膨胀。

---

#### Tier 2：Session Memory Compact

作用：后台持续维护一个 session memory 文件，用它替代旧历史，而不是每次临时让模型总结全量历史。

建议路径：

```text
~/.rivet/sessions/{sessionId}.memory.md
~/.rivet/sessions/{sessionId}.ledger.json
```

Memory 固定结构：

```md
# Session Memory

## Current Goal
...

## Decisions
- ...

## Files Touched
- path — why it matters

## Errors Encountered
- error — root cause — fix/status

## Pending Tasks
- ...

## Verification
- command — result — scope

## User Preferences In This Session
- ...
```

更新时机：

- 每 turn complete 后低优先级更新。
- compact 前强制补齐。
- session resume 时先读 memory。

Session memory 不是完整 transcript 的替代品，而是 prompt 的“可读工作记忆”。

---

#### Tier 3：Reactive Group Summarization

当 session memory 不够时，按 API rounds 分组，从最老区间开始总结。

示例：

```text
Round 1-20 → Summary A
Round 21-40 → Summary B
Round 41-55 → Summary C
Recent 6 rounds 保留原文
```

每个 summary：

```ts
interface ContextSummary {
  spanStartRound: number
  spanEndRound: number
  tokenBefore: number
  tokenAfter: number
  summary: string
  preservedAnchors: string[]
  risks: string[]
  sourceTranscriptPath: string
}
```

总结 prompt 必须禁止工具调用：

```text
You must not call tools.
Return <analysis> and <summary>.
Only <summary> will be retained.
Preserve decisions, errors, file paths, user instructions, pending tasks.
```

compact 后注入：

```xml
<compact-summary source="rounds:1-40">
...
</compact-summary>
```

---

#### Tier 4：Emergency Truncation

只在上下文快满且上述层级都失败时使用。

永远保留：

- stable prefix
- system/tool definitions
- latest user request
- recent N rounds
- active tool pair
- session memory
- unresolved errors

可以丢：

- 已有 rawPath 的旧 tool output
- 已被 summary 覆盖的旧 transcript
- 重复 debug/cache output

必须写入 TUI marker：

```text
Context emergency truncation happened.
Dropped rounds: X-Y.
Reason: token overflow.
```

---

## Prompt 注入设计

当前 Rivet 的 volatile block 应升级为稳定 XML 结构。

建议结构：

```xml
<context>
  <session>
    <cwd>...</cwd>
    <model>...</model>
    <session_id>...</session_id>
  </session>

  <context_budget>
    <estimated_tokens>...</estimated_tokens>
    <max_tokens>...</max_tokens>
    <compaction_state>...</compaction_state>
  </context_budget>

  <working_set digest="sha256:...">
    ...
  </working_set>

  <session_memory digest="sha256:...">
    ...
  </session_memory>

  <recent_context>
    ...
  </recent_context>
</context>
```

原则：

- tag 顺序固定。
- 空字段也输出空 tag。
- 文件列表排序稳定。
- session memory 不每轮无意义重写。
- 每个 section 可以带 digest。
- TUI 可以用 digest 解释 context diff 和 cache miss。

新增诊断命令建议：

```text
/debug context
/debug context-diff
/debug compact-plan
```

示例输出：

```text
Context diff since last turn:
- working_set changed: +src/tui/app.tsx
- git_status changed: yes
- session_memory changed: no
- estimated cache impact: low
```

---

## TUI Context Cockpit

Rivet 不应只显示 cache hit，还应显示上下文健康。

### StatusBar 新指标

示例：

```text
ctx 412k/1M | cache 93% | memory fresh | compact: micro | rounds 84
```

颜色：

- green：< 60%
- yellow：60%-80%
- red：> 80%
- purple：emergency compact occurred
- cyan：session memory refreshed

---

### `/context`

示例：

```text
Context status
- Tokens: 412k / 1M
- Cache hit: 93%
- Current strategy: healthy
- Session memory: fresh, summarized through round 72
- Recent raw rounds kept: 8
- Compacted spans:
  - rounds 1-40: session memory
  - rounds 41-60: microcompact tool results
- API invariants: ok
- Working set:
  - src/prompt/engine.ts — active
  - src/compact/auto.ts — referenced
```

---

### `/memory`

示例：

```text
Current Goal
...

Decisions
...

Errors
...

Pending Tasks
...
```

支持：

```text
/memory show
/memory refresh
/memory anchors
```

---

### Compact Boundary UI

在 log 中插入：

```text
── Context compacted ──
Strategy: session-memory
Summarized: rounds 1-52
Saved: ~180k tokens
Recent rounds retained: 8
```

Compact marker 应可折叠或至少保持短输出。

---

### Token Warning UI

示例：

```text
Context warning: 760k/1M.
Next turn may trigger microcompact.
```

```text
Context critical: 910k/1M.
Reactive compact required before next request.
```

---

## Session Resume Pipeline

`/resume` 不应只是 `load JSONL → replaceMessages`。

建议流程：

```text
1. load JSONL transcript
2. group into API rounds
3. validate tool_use/tool_result pairs
4. estimate tokens
5. load session memory
6. if over threshold:
     run Tier 1 or Tier 2 compact before accepting user input
7. rebuild context ledger
8. show TUI resume summary
```

TUI 示例：

```text
Restored session abc123
Messages: 296
Rounds: 81
Estimated tokens: 742k
Session memory: summarized through round 63
API invariants: repaired 1 unmatched tool_use
Recommended: compact soon
```

这样用户知道恢复了什么，而不是黑盒继续。

---

## Working Set

Rivet 已经有文件/测试追踪能力，但没有充分进入 volatile context。

建议 working set 成为一级资产。

```ts
interface WorkingSetEntry {
  path: string
  kind: 'read' | 'edited' | 'tested' | 'failed' | 'referenced'
  lastTurn: number
  reason: string
  verifiedBy?: string[]
  risk?: 'low' | 'medium' | 'high'
}
```

更新来源：

- read_file
- edit_file / write_file
- run_tests
- grep / glob
- diff
- verification report
- 用户显式提到文件

注入策略：

- active files 最多 12 个。
- recently touched 优先。
- failed/tested files 优先。
- 超过预算只保留 path + reason，不注入文件内容。

TUI 示例：

```text
Working set: 7 files
active: src/compact/auto.ts, src/prompt/engine.ts
risk: src/agent/loop.ts
```

---

## Auto-Compact Strategy

建议阈值适配 1M context：

```text
warningThreshold = 650_000
microcompactThreshold = 720_000
sessionMemoryCompactThreshold = 800_000
reactiveCompactThreshold = 880_000
emergencyThreshold = 940_000
```

若模型 context 非 1M，按比例：

```text
warning = 65%
micro = 72%
memory = 80%
reactive = 88%
emergency = 94%
```

Circuit breaker：

```text
maxConsecutiveCompactFailures = 3
```

失败后：

- 停止 auto compact。
- TUI warning。
- 需要用户手动 `/compact force`。

策略选择：

```text
if old tool output > 80k:
  Tier 1 microcompact
else if session memory is fresh:
  Tier 2 session memory compact
else if memory stale:
  refresh memory, then Tier 2
else:
  Tier 3 reactive group summarization

if all fail:
  Tier 4 emergency truncation
```

---

## 分阶段路线

### Phase 1：Context Ledger + TUI Observability

目标：先让上下文状态可见，不急着改压缩策略。

范围：

- round grouping。
- API invariant validator。
- context ledger。
- `/context` 显示 token、round、working set、compact state。
- StatusBar 显示 context usage。
- resume 时跑 preflight，只报告不自动 compact。

成功标准：

- `/resume` 后能显示 restored session 的 token / round / invariant 状态。
- `/context` 能解释当前上下文。
- 不改变模型请求内容，风险最低。

---

### Phase 2：Microcompact Tool Results

目标：零 API 成本减少上下文膨胀。

范围：

- 标记 compactable tools。
- 对旧 tool_result 做 stub 替换。
- 保留 rawPath、head/tail、is_error。
- compact boundary 写入 log。
- `/compact micro` 手动触发。
- auto threshold 先只 warning，不自动执行。

成功标准：

- 长 build/test/grep 输出可被压缩。
- tool_use/tool_result API invariant 不破坏。
- cache anchor 不变。
- typecheck/test/build 通过。

---

### Phase 3：Session Memory

目标：把历史变成可持续工作记忆。

范围：

- 建立 `{sessionId}.memory.md`。
- 每 turn complete 后抽取：
  - current goal
  - decisions
  - files
  - errors
  - pending tasks
  - verification
- `/memory show|refresh`。
- `/compact memory` 用 session memory 替换旧 rounds。
- resume preflight 自动加载 memory。

成功标准：

- 压缩后模型仍能说清当前任务、文件、错误、下一步。
- session resume 不需要用户重新解释。
- compact summary 不破坏 API invariants。

---

### Phase 4：Reactive Compact

目标：当 session memory 不够时，按 round 分组总结旧区间。

范围：

- group rounds。
- 选择 oldest compactable span。
- forked compact model summarization。
- summary block 替换 span。
- compacted span 可在 TUI 展开。
- compact failure circuit breaker。

成功标准：

- 超长会话可多次 compact。
- 不重复总结同一区间。
- compact failure 不进入死循环。
- 每次 compact 后有明确 TUI marker。

---

### Phase 5：Salience-based Retrieval

目标：从固定摘要升级为按任务选择记忆。

范围：

- anchors salience score。
- 每轮根据当前 user request、working set、pending errors 选择 anchors。
- 限制 session memory 注入预算。
- 统计 injected anchors 是否被后续 turn 引用。

成功标准：

- context block 更短。
- 关键错误/决策不会丢。
- 低相关历史不污染当前任务。

Phase 1-4 不建议引入 vector DB。Phase 5 仍优先 deterministic anchors，再考虑向量检索。

---

## 验证策略

### 单元测试

覆盖：

- API round grouping 不切断 tool pairs。
- orphan tool_result 被标记，不制造新孤儿。
- microcompact 保留 `tool_use_id` / `is_error` / `rawPath`。
- context ledger token budget 与 compact span 计算正确。
- working set 排序稳定。
- session memory digest 稳定。
- context XML section 顺序稳定。

### 集成测试

覆盖：

- `/resume` 对长 JSONL session 执行 preflight。
- `/context` 输出 token、round、memory、working set。
- `/compact micro` 后 `PromptEngine.buildRequest()` 不再需要修复新 broken pair。
- compact 后 `npm run typecheck`、`npm test`、`npm run build` 通过。

### 行为验证

设计专门长会话 fixture：

```text
user asks task
assistant uses tools
large bash/test output
edits files
run tests fail
fix tests
compact
resume
continue task
```

验证问题：

- 模型能否记得 current goal。
- 模型能否记得 active files。
- 模型能否记得最近错误和验证状态。
- TUI 是否显示 compact marker。
- cache hit 是否没有异常大幅下降。

---

## 风险与应对

### 风险 1：压缩破坏 tool_use/tool_result

应对：

- compact 前先 group rounds。
- compact boundary 只能落在完整 round 之间。
- validator 作为 preflight。
- PromptEngine normalization 只保留为兜底。

### 风险 2：session memory 编造或丢关键细节

应对：

- memory 只抽取有 source round 的事实。
- anchor 带 `sourceRound`。
- TUI 显示 memory freshness。
- compact fidelity test：压缩后复述 current goal / pending errors / active files。

### 风险 3：context block 变动导致 cache hit 掉

应对：

- XML section 固定顺序。
- 空字段也输出。
- stable sorting。
- section digest。
- `/debug context-diff`。

### 风险 4：TUI 信息太多

应对：

- StatusBar 只显示 `ctx/cache/memory/compact`。
- `/context` 展示详细。
- compact marker 可折叠。

### 风险 5：过早做 RAG

应对：

- Phase 1-4 不引入 vector DB。
- Phase 5 再考虑 salience retrieval。
- 先用 deterministic anchors。

---

## 最终推荐

Rivet 不应该直接复制 `claude-code-haha`。最优路线是：

> 借鉴 `claude-code-haha` 的 multi-tier compaction、session memory、context visualization，但以 Rivet 的 DeepSeek prefix cache 为中心重新组织。

一句话方案：

> Rivet 的上下文工程应升级为 “Context Ledger 驱动的渐进式压缩系统”：先把 session 历史分成 API-safe rounds，再持续抽取 session memory 和 working set，用 microcompact / session-memory / reactive 三层压缩保护上下文窗口，并在 TUI 中用 `/context`、token warning、compact marker 把上下文健康状态暴露给用户。
