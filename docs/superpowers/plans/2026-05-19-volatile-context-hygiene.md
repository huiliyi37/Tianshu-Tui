# Volatile Context Hygiene 实施计划

> 日期：2026-05-19  
> 负责人：天枢负责核心设计与首批关键实现；其他智能体按任务分工执行。  
> 背景：GLM 会话复盘指出每轮上下文中 `project-instructions`、`active-claims`、`git-status`、`file-warnings`、`historical-lessons` 大量重复注入，实际有效上下文被压缩。  
> 目标：让 Rivet 长会话的 latest-turn volatile context 自动瘦身，默认只注入当前任务相关、未过期、未解决的信息；旧信息可 recall，但不每轮常驻。  
> 铁律：不修改 `src/prompt/static.ts`；不破坏 DeepSeek prefix cache；不删除事实，只降级/压缩/延迟注入；所有裁剪必须可诊断、可回退。

---

## 0. 问题复盘

GLM 给出的污染源分析：

| 来源 | 占比感受 | 问题 |
|------|----------|------|
| `project-instructions` | ~40% | 每轮重复完整架构、Subagent Orchestration、ACF、并发规则；多数任务只需要其中一小段 |
| `active-claims` | ~15% | 旧 worker findings、已解决 failure、读文件 observation 长期滞留 |
| `git-status` | ~5% | 20+ dirty/untracked files 每轮完整重复 |
| `file-warnings` | ~3% | 历史 dead-end 命令原样重复，而不是规则化提醒 |
| `historical-lessons` | ~2% | playbook bullets 每轮固定注入，未按任务相关性召回 |
| 实际有效上下文 | ~35% | 用户任务、代码观察、当前修改、验证结果 |

当前代码结构确认：

- `src/prompt/volatile.ts` 负责组装 `<context>`，其中：
  - `.rivet.md` → `<project-instructions>`
  - `.rivet/knowledge/*.md` → `<project-memory>`，最大 2000 chars
  - git status → `<git-status>` / `<recent-commits>`
  - active claims → `renderActiveClaimsBlock()`
  - playbook lessons → `<historical-lessons>`，固定 slice 3
- `src/context/claims.ts` 中 `MAX_PROMPT_CLAIMS = 20`，只按 fitness/confidence/createdAt 排序，无任务相关性。
- `src/context/claim-store.ts` 中 active overflow 上限是 50，仅 overflow 后 stale，没有 prompt 注入 gate。
- `src/agent/hooks/signal-consumer-hook.ts` 会把 dead-end pheromones 原样注入 `<file-warnings kind="dead-end">`。
- `src/prompt/engine.ts` 为历史 user turn 使用 frozen volatile block，为最新 user turn 使用 fresh volatile block；因此优化应优先作用 latest-turn dynamic block，不能破坏历史 prefix。

---

## 1. 设计原则

1. **Measure first**：先做 payload diagnostics，量化每个 section 的 chars / estimated tokens，再做裁剪。
2. **Latest-turn only**：默认只优化最新 turn 的 dynamic volatile block；历史 frozen blocks 不回写，避免破坏 prefix cache。
3. **Relevance over recency**：active claims、playbook lessons、dead-end warnings 都必须与当前 input / working set / recent tool history 相关才注入。
4. **Compress, don't erase**：无关信息进 cold storage / claim store / playbook，不每轮出现；用户可用 recall/debug 查全量。
5. **Safety first**：user constraints、security findings、unresolved verification failures 保留优先级高于普通 file observations。
6. **Prompt path isolation**：不修改 `src/prompt/static.ts`；只改 volatile/context 注入和 debug 命令。
7. **Observable gates**：每个 gate 都要能输出为什么保留/裁剪，避免“模型忘事”不可诊断。

---

## 2. 目标架构

```text
Latest user input / tool history / working set
                │
                ▼
       ContextRelevanceInput
                │
     ┌──────────┼──────────┐
     │          │          │
     ▼          ▼          ▼
Claim Gate  DeadEnd Gate  Lesson Gate
     │          │          │
     └──────────┼──────────┘
                ▼
       VolatilePayloadReport
                │
                ▼
 buildLatestTurnVolatileBlock()
```

新增核心模块建议：

```text
src/context/payload-diagnostic.ts     # section size / token estimate / waste candidates
src/context/claim-relevance.ts        # active-claims prompt gate
src/context/dead-end-rules.ts         # dead-end warnings 压缩为规则
src/context/lesson-relevance.ts       # historical lessons 相关性 gate（后续）
```

不建议第一阶段就拆 `.rivet.md`。Project instructions routing 是最大收益，但风险也最大，应在 payload report 和 claim gate 稳定后做。

---

## 3. 分工建议

| 角色 | 负责人 | 范围 | 文件 |
|------|--------|------|------|
| Core / 天枢 | 当前会话 | 方案设计、payload diagnostic、claim relevance gate、review 最终合并 | `src/context/payload-diagnostic.ts`、`src/context/claim-relevance.ts`、`src/prompt/volatile.ts`、`src/tui/slash-commands.ts` |
| Worker A | 其他智能体 | Dead-end warnings 规则化压缩 | `src/context/dead-end-rules.ts`、`src/agent/hooks/signal-consumer-hook.ts`、对应 tests |
| Worker B | 其他智能体 | Historical lessons relevance gate | `src/context/lesson-relevance.ts`、`src/agent/playbook-store.ts` 或 injection 调用点、对应 tests |
| Worker C | 其他智能体 | Project instructions routing 设计细化，不急着实现 | `.rivet.md` 拆分方案、`docs/superpowers/specs/*` |
| Reviewer | 其他智能体 | 只读 review：cache invariants、测试覆盖、是否误删安全上下文 | `src/prompt/engine.ts`、`src/prompt/volatile.ts`、tests |

并发规则：

- 同一时间不要多人改 `src/prompt/volatile.ts`。
- Worker A 可先只改 `signal-consumer-hook.ts` 和新增 `dead-end-rules.ts`，避免和 Core 冲突。
- Worker B 可先做纯函数和测试，不接 runtime。
- Worker C 只写 docs，不碰 runtime。

---

## 4. Phase 1：Payload Diagnostics（天枢核心）

### 目标

新增可测试的 payload section 统计，并通过 `/debug context-payload` 暴露当前 prompt 污染源。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/context/payload-diagnostic.ts` | 对 volatile block 做 section 级别统计与 waste candidate 分析 |
| `src/context/__tests__/payload-diagnostic.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/prompt/volatile.ts` | 导出可选 `buildVolatilePayloadReport(ctx)` 或复用 diagnostic 纯函数 |
| `src/tui/slash-commands.ts` | `/debug context-payload` 输出 report |
| `src/prompt/engine.ts` | 可选提供 `getVolatilePayloadReport()`，但第一版可不改 |

### 类型设计

```ts
export interface PayloadSectionStat {
  id: string
  chars: number
  estimatedTokens: number
  lines: number
  present: boolean
}

export interface PayloadWasteCandidate {
  id: string
  reason: string
  chars: number
  recommendation: string
}

export interface VolatilePayloadReport {
  totalChars: number
  estimatedTokens: number
  sections: PayloadSectionStat[]
  wasteCandidates: PayloadWasteCandidate[]
}
```

### 纯函数 API

```ts
export function estimateContextTokens(text: string): number
export function analyzeVolatilePayload(block: string): VolatilePayloadReport
export function formatVolatilePayloadReport(report: VolatilePayloadReport): string
```

### Section 识别

识别 XML-like top-level sections：

- `environment`
- `project-instructions`
- `project-memory`
- `git-status`
- `recent-commits`
- `working-set`
- `context-ledger`
- `tool-history`
- `task-progress`
- `behavior-mirror`
- `strategy-shift`
- `repair-hint`
- `decisions`
- `cerebellar-hint`
- `active-claims`
- `session-memory`
- `historical-lessons`
- `file-warnings`

`file-warnings` 当前来自 injected user message，不一定在 volatile block 中。第一版 report 先覆盖 volatile block；Worker A 后续补 signal injection report。

### Waste candidate 初版规则

- `project-instructions` > 6000 chars：建议 route/summarize。
- `active-claims` > 2500 chars 或 count > 8：建议 relevance gate。
- `git-status` > 1200 chars：建议 summary mode。
- `historical-lessons` > 800 chars：建议 lesson relevance gate。
- total > 12000 chars：建议 context hygiene。

### `/debug context-payload` 输出示例

```text
Context Payload
Total: 18.4k chars (~4.6k tokens)
Sections:
  project-instructions  8.2k chars  2.1k tok
  active-claims         3.4k chars  0.9k tok
  git-status            1.1k chars  0.3k tok
  historical-lessons    0.4k chars  0.1k tok
Waste candidates:
  project-instructions: large stable volatile section; split by task route
  active-claims: 13 claims injected; apply relevance gate
```

### 测试

- [ ] 空 block 返回 total=0。
- [ ] 能识别 `<project-instructions>`、`<active-claims>`、self-closing `<environment />`。
- [ ] chars/tokens/lines 正常。
- [ ] 大 active-claims 触发 waste candidate。
- [ ] format 输出可读。

### 验证命令

```bash
./node_modules/.bin/tsx --test src/context/__tests__/payload-diagnostic.test.ts src/tui/__tests__/slash-commands.test.ts
./node_modules/.bin/tsc --noEmit
```

> 注意：本项目中 `npx tsx --test ...` 可能被 npm 错误解析；优先使用 `./node_modules/.bin/tsx`。

---

## 5. Phase 2：Active Claims Relevance Gate（天枢核心）

### 目标

把 prompt active claims 从固定 Top 20 改为默认 Top 5-8 的相关性选择；已过期、低价值 file observations、与当前任务无关的 worker findings 不再每轮注入。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/context/claim-relevance.ts` | claim scoring、filtering、reason report |
| `src/context/__tests__/claim-relevance.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/context/claims.ts` | `renderActiveClaimsBlock(claims, options?)` 支持传入 maxClaims / query / workingSet / toolHistory |
| `src/prompt/volatile.ts` | latest block 渲染 active claims 前调用 relevance gate |
| `src/agent/loop.ts` 或 `context-injection.ts` | 可选：更新 activeClaims 时传当前 task/query tags（后续） |

### 类型设计

```ts
export interface ClaimRelevanceInput {
  query?: string
  workingSet?: string[]
  recentTools?: Array<{ tool: string; target: string; status: string }>
  now?: number
  maxClaims?: number
}

export interface ScoredClaim {
  claim: ContextClaim
  score: number
  reasons: string[]
}

export interface ClaimRelevanceResult {
  selected: ContextClaim[]
  scored: ScoredClaim[]
  omitted: ScoredClaim[]
}
```

### Scoring 初版规则

Base：

| 条件 | 分数 |
|------|------|
| `user_constraint` | +100 |
| `security_finding` active | +80 |
| `verification_fact` failed/unresolved | +70 |
| `failure_pattern` recent | +50 |
| `decision` | +45 |
| `worker_finding` | +20 |
| `file_observation` | +10 |

调整：

| 条件 | 分数 |
|------|------|
| tag 命中 query token | +25 |
| text 命中 query token | +20 |
| evidence.path 在 workingSet | +30 |
| evidence.summary / text 命中 recent tool target | +20 |
| lastUsedAt 近 10 分钟 | +10 |
| createdAt 超过 1 小时且没有命中 | -30 |
| kind=`file_observation` 且无命中 | -25 |
| kind=`worker_finding` 且无命中 | -20 |
| status 非 prompt eligible | exclude |
| expiresAt <= now | exclude |

默认：

```ts
maxClaims = 6
minScore = 25
```

但永远保留：

- active user constraints
- security findings with confidence >= 0.7
- unresolved failed verification facts

### Render 策略

`renderActiveClaimsBlock` 输出增加 omitted summary？第一版建议不要污染 prompt，只在 debug report 输出 omitted。

Prompt 中：

```xml
<active-claims count="5" omitted="8">
...
</active-claims>
```

`omitted` 是数字，不包含具体文本，避免再次污染。

### 测试

- [ ] user_constraint 即使 query 不命中也保留。
- [ ] file_observation 不命中时被过滤。
- [ ] workingSet path 命中时保留对应 claim。
- [ ] maxClaims 生效。
- [ ] expired claim 被排除。
- [ ] selected 按 score 排序。
- [ ] omitted 不进入 prompt 文本。

### 验证命令

```bash
./node_modules/.bin/tsx --test src/context/__tests__/claim-relevance.test.ts src/prompt/__tests__/volatile.test.ts
./node_modules/.bin/tsc --noEmit
```

---

## 6. Phase 3：Dead-end Rule Compression（Worker A）

### 目标

把 `<file-warnings kind="dead-end">` 从历史失败命令列表压缩为少量规则，只在当前任务相关时注入。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/context/dead-end-rules.ts` | dead-end path → rule compression、relevance 判断 |
| `src/context/__tests__/dead-end-rules.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/hooks/signal-consumer-hook.ts` | 使用 compressed rule formatter |
| `src/agent/__tests__/signal-consumer-hook.test.ts` | 更新断言 |

### 规则设计

输入：`PheromoneRef[]`，输出：

```ts
export interface DeadEndRule {
  kind: 'security' | 'test-runner' | 'path' | 'network' | 'command-substitution' | 'generic'
  pattern: string
  recommendation: string
  examples: string[]
  severity: 'low' | 'medium' | 'high'
}
```

初版压缩：

| 检测 | recommendation |
|------|----------------|
| 包含 API_KEY / TOKEN / config.json | Never print secrets or config contents. |
| `npx tsx --test` 失败 | Use `./node_modules/.bin/tsx --test ...` for targeted tests in this repo. |
| `npm test` / full tests 失败/过重 | Prefer targeted tests first, then full suite when ready. |
| `git diff --no-index /dev/null ...` 失败 | Use `diff` tool or `git diff -- <path>` for tracked files; avoid no-index for untracked preview. |
| `.claude` / home scanning | Do not inspect global Claude dirs unless user explicitly asks. |

输出 prompt：

```xml
<file-warnings kind="dead-end" compressed="true">
- [test-runner] Use ./node_modules/.bin/tsx --test for targeted tests in this repo.
- [security] Never print API keys, tokens, or config secrets.
</file-warnings>
```

最多 3 条，按 severity 排序。

### 测试

- [ ] 多个 npx tsx dead-end 合并成 1 条 test-runner rule。
- [ ] secret 相关 dead-end 生成 high severity rule。
- [ ] 输出最多 3 条。
- [ ] dedupe key 基于 compressed rules，避免每 turn 重发。
- [ ] 原有 dead-end hook 行为仍会 inject 一条 warning。

---

## 7. Phase 4：Historical Lessons Relevance Gate（Worker B）

### 目标

`historical-lessons` 不再固定 slice(0,3)，而是按当前 task/query/recent tool failure 召回最相关 lessons。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/context/lesson-relevance.ts` | playbook lesson scoring |
| `src/context/__tests__/lesson-relevance.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/prompt/volatile.ts` | 渲染 lessons 前排序/filter |
| `src/agent/context-injection.ts` 或 lessons refresh 调用点 | 传入 query/keywords（后续可选） |

### 规则

- `lesson.keywords` 命中 current input / recent tool target：+50
- `lesson.context` 命中：+20
- importance 高：+importance * 20
- dead-end lesson 只有在 recent failure 或 matching command 时注入
- 默认 max 2，不是 3

### 测试

- [ ] query 命中 keyword 的 lesson 排在前。
- [ ] 不相关 lesson 被过滤。
- [ ] dead-end lesson 无相关失败不注入。
- [ ] maxLessons=2 生效。

---

## 8. Phase 5：Git Status Summary Gate（Worker 或天枢后续）

### 目标

把完整 git status 从每轮全量注入改为默认 summary + relevant files。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/prompt/git-status-summary.ts` | git status 文本压缩 |
| `src/prompt/__tests__/git-status-summary.test.ts` | 测试 |

### 策略

默认输出：

```text
Current branch: feat/...
Dirty: 6 modified, 2 untracked, 1 deleted
Relevant dirty files:
- src/tui/slash-commands.ts
- src/workflows/ecosystem-workflows.ts
Other dirty files omitted; use git status for full list.
```

展开条件：

- 用户要求 commit/review all changes。
- dirty files <= 8。
- 当前 task query 命中 docs/api/config/tui 等 scope。

### 注意

这可能影响用户对 concurrent session conflicts 的判断。实现时要保留：

- 当前 branch。
- dirty count。
- 如果存在跨 owner scope 的 dirty files，显示 scope summary。

---

## 9. Phase 6：Project Instructions Routing（Worker C 设计，后续实现）

### 目标

把 `.rivet.md` 的完整 project-instructions 拆成 always-on core 与 task-routed details。

### 不建议立即实现

这是最大收益点，但也最容易误删关键约束。先做文档设计和 dry-run diagnostics。

### 设计方向

```text
.rivet/instructions/core.md
.rivet/instructions/tasks/tui.md
.rivet/instructions/tasks/api.md
.rivet/instructions/tasks/config.md
.rivet/instructions/tasks/agent-loop.md
.rivet/instructions/tasks/mcp.md
.rivet/instructions/tasks/compaction.md
.rivet/instructions/tasks/subagent.md
```

默认注入：

- core
- 当前 task classified section 1-2 个
- explicit user mentioned section

必须 always-on：

- 安全规则：secrets、destructive commands。
- Git protocol。
- 当前 concurrent session ownership summary。
- Commands baseline。

只在相关任务注入：

- ACF full constraints → compaction/context task。
- Subagent full constraints → subagent/coordinator task。
- Files to Read First table → 根据 task type 选行。

### Deliverable

Worker C 输出设计文档：

```text
docs/superpowers/specs/2026-05-19-project-instructions-routing-design.md
```

---

## 10. Phase 7：Integration + Review

### 目标

将各 worker 产物接入统一 hygiene pipeline，确保 cache 与 safety 不回退。

### Review checklist

- [ ] `src/prompt/static.ts` 未修改。
- [ ] `PromptEngine.buildRequest()` 历史 frozen volatile block 行为未改变。
- [ ] latest fresh block 可裁剪，但 historical turns 不重写。
- [ ] user_constraint/security_finding 不被误删。
- [ ] `/debug context-payload` 能解释裁剪。
- [ ] dead-end warning 不再超过 3 条。
- [ ] active-claims 默认不超过 6-8 条，除非 hard-keep。
- [ ] tests 覆盖 section report、claim gate、dead-end compression。

### 最小验证

```bash
./node_modules/.bin/tsx --test \
  src/context/__tests__/payload-diagnostic.test.ts \
  src/context/__tests__/claim-relevance.test.ts \
  src/context/__tests__/dead-end-rules.test.ts \
  src/prompt/__tests__/volatile.test.ts \
  src/tui/__tests__/slash-commands.test.ts

./node_modules/.bin/tsc --noEmit
```

不要在本仓库使用已知失败的 `npx tsx --test ...` 形式。

---

## 11. 建议首个实现切片（天枢负责）

```text
feat(context): add volatile payload diagnostics
```

范围：

1. `src/context/payload-diagnostic.ts`
2. `src/context/__tests__/payload-diagnostic.test.ts`
3. `/debug context-payload` 输出当前 latest volatile report
4. 不改裁剪逻辑，只测量

为什么先做：

- 风险最低。
- 能立刻验证 GLM 的污染源分析。
- 给后续 claim/dead-end/project-instructions gate 提供量化基线。

第二个切片：

```text
feat(context): gate active claims by relevance
```

范围：

1. `src/context/claim-relevance.ts`
2. `renderActiveClaimsBlock(claims, options)`
3. `volatile.ts` latest block 使用 gate
4. tests

---

## 12. 任务执行顺序建议

1. 天枢：Phase 1 payload diagnostics。
2. Reviewer：检查 diagnostics 是否不影响 prompt 内容。
3. 天枢：Phase 2 claim relevance gate。
4. Worker A：Phase 3 dead-end rule compression。
5. Worker B：Phase 4 lesson relevance gate。
6. Worker C：Phase 6 project instructions routing 设计。
7. 天枢：Phase 7 integration review。

如果要并行：

- Worker A/B/C 可以立即开始，因为它们主要新增纯函数和测试。
- 天枢先拿 `volatile.ts` 和 `/debug`，避免冲突。

---

## 13. 完成定义

- [ ] `/debug context-payload` 可显示 section 级 payload 占比。
- [ ] active claims prompt 注入默认降到 Top 6 左右，并保留 hard safety claims。
- [ ] dead-end warnings 从原始命令列表压缩为最多 3 条规则。
- [ ] historical lessons 按相关性召回，不再固定 3 条。
- [ ] git status 默认 summary，必要时可展开。
- [ ] project-instructions routing 有设计文档与 dry-run 方案。
- [ ] 所有优化不修改 stable system prompt。
- [ ] targeted tests + typecheck 通过。
