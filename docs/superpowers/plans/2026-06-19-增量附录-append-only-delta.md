# 增量附录（append-only delta context-update）实现计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现（计划阶段不派子代理）。步骤用复选框（`- [ ]`）跟踪进度。
> 设计依据：`docs/research/2026-06-19-轮间首请求-cacheCreate-增量附录优化设计.md`

**目标：** 把每轮新用户消息尾部的 `<context-update>` 附录从「全量重建」改为「append-only 增量」——只发自上次起变化的子块，旧块留在 frozen 历史里靠缓存命中，将轮间首请求 cacheCreate 从 ~12K 降到普通轮 1-3K。

**架构：**
- 复用已有 frozen-snapshot 的 append-only 性质：delta 块照常 merge 进 user message、照常 freeze，历史检索仍 byte-identical 命中 → **frozen 机制零改动**。
- `buildDynamicAppendix` 拆出结构化核心 `buildDynamicAppendixParts`（返回 GWT 选完后带 tag 名的子块数组）；engine 维护 `lastEmittedAppendixParts` 做跨轮 diff，只渲染变化块，包成 `<context-update seq="N" mode="delta">`。
- 语义靠静态提示一条 `<context-update-protocol>` 说明承载（后出现的同名块覆盖先前的；未出现=未变）。
- 灰度：`appendixDelta` 配置开关默认关，env `RIVET_APPENDIX_DELTA=1` 开启；压缩/历史重写时重置 baseline 强制下轮全量。

**技术栈：** TypeScript strict / node:test / 现有 `src/prompt/{engine,volatile,static}.ts`

**关键设计决策：**
- **supersede-only（Phase 1 不做 tombstone）**：消失的子块在最新 update 中缺席，旧值留在历史。绝大多数块（git-status/progress/tool-history/advisory）是「就地变更」，supersede 覆盖即可。少数需要「明确消失」的块（worktree-warning 转 green、plan-mode 退出）放 Phase 2 用 tombstone 处理。
- **cognitiveProjection 不进 diff**：始终原样前置（体积小、每轮性质不同），diff 只作用于 `<context-update>` 子块。
- **diff 作用于 GWT 选择后的集合**：lastEmitted 始终等于「实际发出的块」，避免被预算丢弃的块产生误判。
- **每用户边界只算一次 delta**：tool-call turn 复用 `cachedAppendix`（既有 `userContent === cachedFreshForUser` 路径），不触碰 lastEmitted。

**范围定位（与四维度文档的关系）：**
本计划只覆盖 `2026-06-19-缓存命中率追竞品-四维度分析与行动优先级.md` 的**维度 1（增量附录，P1）**，动的是 appendix 尾部（`volatile.ts` + engine fresh 路径）。其余维度**不在本计划内**：
- 维度 4（tool result 体积，文档定 P0，input 基数 -40%）：另一个子系统（`DISK_BUDGET_CHARS`/observation masking/artifact/`read_file`），应另起独立计划，且投入产出比上**建议排在本计划之前**。
- 维度 2（system/user 分离）：不采纳——其想移动的稳定块已在 `frozenBase` 中被 frozen-snapshot（byte-0 锚点）缓存，移到 system message token 收益≈0 且放大中途变更的破坏面（同第二轮已灭绝的 V2）。
- 维度 3（reasoning 回显）：watermark 已是最优解，不动。

**收益物理下限**（维度 1 天花板）：即便 delta 成功，仍有下限——新用户消息本身（几十-几百 token）+ 每轮必变的 `<progress>`/`<tool-history>` 子块。故普通轮目标 1-3K、commit 轮一次性回到含 git 的 ~5-7K，**不会**降到 0。

---

## 任务

### 任务 1：`buildDynamicAppendix` 拆出结构化 parts 核心

- [ ] 修改 `src/prompt/volatile.ts:302-476`（`buildDynamicAppendix`）
- [ ] 新增导出 `buildDynamicAppendixParts` 与 `appendixBlockName`
- [ ] 测试 `src/prompt/__tests__/volatile.test.ts`（追加 describe 块）

**目标：** 把「构建所有子块 → GWT Top-K 选择」抽成返回 `{name, content}[]` 的核心函数，`buildDynamicAppendix` 退化为薄包装，保持现有全量行为字节不变。

**调研背书：**
- `buildDynamicAppendix`：调用者两处，均在 `src/prompt/engine.ts:339`、`346`（fresh 路径）；另测试 `engine-cache-stability.test.ts:38`、`volatile.test.ts` 直接调用断言 `<context-update>`/`<git-status>` 存在。包装保留同样 tag 与拼接顺序 → 现有测试不破。存在原因：渲染每轮动态 `<context-update>` 块并按 salience 预算裁剪。

**实现：**
在 `volatile.ts` 中，把现有 `buildDynamicAppendix` 内「构建 `parts` 数组」+「GWT 选择」逻辑抽出：

```typescript
/** A selected context-update sub-block with its identifying tag name. */
export interface AppendixPart { name: string; content: string }

/** Extract the leading XML tag name from a sub-block, for cross-turn diffing. */
export function appendixBlockName(content: string): string {
  const m = /^<([A-Za-z][\w-]*)/.exec(content)
  return m ? m[1]! : `anon:${content.length}`
}

/**
 * Build the per-turn context-update sub-blocks, post GWT Top-K selection.
 * Returns named parts (in cache-stable order) so callers can diff across turns.
 */
export function buildDynamicAppendixParts(ctx: VolatileContext, maxChars?: number): AppendixPart[] {
  const parts: string[] = []
  // … 原 buildDynamicAppendix 中 305-461 的 parts.push(...) 全部逻辑原样搬入 …
  if (parts.length === 0) return []

  const selected = (maxChars !== undefined && maxChars > 0)
    ? selectTopKBlocks(parts.map(content => ({ content, salience: assignSalience(content) })), maxChars)
    : parts
  return selected.map(content => ({ name: appendixBlockName(content), content }))
}

/** Backward-compatible wrapper: full <context-update> block (no seq). */
export function buildDynamicAppendix(ctx: VolatileContext, maxChars?: number): string {
  const parts = buildDynamicAppendixParts(ctx, maxChars)
  if (parts.length === 0) return ''
  return `<context-update>\n${parts.map(p => p.content).join('\n\n')}\n</context-update>`
}
```

**验证：**
```bash
npm run typecheck
npx tsx --test src/prompt/__tests__/volatile.test.ts          # 现有断言全过（包装行为不变）
npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts  # <git-status>/<context-update> 断言不变
```
新增测试断言：`buildDynamicAppendixParts(baseCtx)` 返回含 `{name:'git-status'}` 的项；`appendixBlockName('<git-status>\nx')` === `'git-status'`；parts 顺序与全量包装一致。

**提交：**
```bash
git add src/prompt/volatile.ts src/prompt/__tests__/volatile.test.ts
git commit -m "refactor(prompt): extract buildDynamicAppendixParts for cross-turn diffing (任务 1/7)"
```

---

### 任务 2：delta 配置开关 + engine 跨轮状态

- [ ] 修改 `src/prompt/engine.ts:62-72`（`PromptEngineConfig` 加 `appendixDelta?: boolean`）
- [ ] 修改 `src/prompt/engine.ts:81-162`（新增 3 个私有字段）
- [ ] 修改 `src/prompt/engine.ts:821-833`（`invalidateFreshCache` 重置 delta baseline）
- [ ] 测试 `src/prompt/__tests__/engine-cache-stability.test.ts`（追加）

**目标：** 引入 delta 开关与跨轮状态（`lastEmittedAppendixParts` / `appendixSeq` / `appendixBaselineSent`），并保证 `invalidateFreshCache` 重置 baseline。

**实现：**
`PromptEngineConfig` 加字段：
```typescript
  /** Enable append-only delta context-update (only emit changed sub-blocks). */
  appendixDelta?: boolean
```
engine 私有字段（紧邻 `cachedAppendix` 附近）：
```typescript
  /** Append-only delta: last emitted context-update sub-blocks (name→content). */
  private lastEmittedAppendixParts: Map<string, string> = new Map()
  /** Monotonic context-update sequence number (model orders updates by seq). */
  private appendixSeq = 0
  /** Whether a full baseline context-update was sent since last reset. */
  private appendixBaselineSent = false
```
`invalidateFreshCache()` 末尾追加（baseline 重置，强制下轮全量）：
```typescript
    this.lastEmittedAppendixParts = new Map()
    this.appendixBaselineSent = false
```

**调研背书：**
- `invalidateFreshCache`：调用者 3 处（`engine.ts:625` updateSessionMemory、`647` setActionableTurn、`730` setIntentRetrievalRoute）。均为「需要下轮全量重建」的边界——正是 delta baseline 该重置的时机，复用零新增钩子。

**验证：**
```bash
npm run typecheck
npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
```
新增测试：`appendixDelta` 缺省时 config.appendixDelta 为 undefined（不影响现有路径）；调 `setActionableTurn(false)` 后 baseline 标志被清（通过下一条用户消息发出全量验证，见任务 3 测试）。

**提交：**
```bash
git add src/prompt/engine.ts src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "feat(prompt): add appendixDelta flag + cross-turn appendix state (任务 2/7)"
```

---

### 任务 3：fresh 路径接入 delta 计算

- [ ] 修改 `src/prompt/engine.ts:339-343`、`345-349`（两处 `buildDynamicAppendix` 调用）
- [ ] 新增私有方法 `buildAppendixBody(ctx, maxChars)`
- [ ] 测试 `src/prompt/__tests__/engine-cache-stability.test.ts`（追加 delta describe）

**目标：** 用 `buildAppendixBody` 替换两处 `buildDynamicAppendix(...)`：delta 开关关时行为不变（全量 `<context-update>`）；开关开时首轮发全量 baseline（带 seq），后续只发变化块（`mode="delta"`），无变化发自闭合 `<context-update seq="N"/>`。

**实现：**
新增私有方法：
```typescript
  /** Build the <context-update> body — full when delta off or baseline not yet
   *  sent, otherwise only changed sub-blocks. Mutates lastEmittedAppendixParts. */
  private buildAppendixBody(ctx: VolatileContext, maxChars?: number): string {
    const parts = buildDynamicAppendixParts(ctx, maxChars)
    if (!this.config.appendixDelta) {
      if (parts.length === 0) return ''
      return `<context-update>\n${parts.map(p => p.content).join('\n\n')}\n</context-update>`
    }
    this.appendixSeq++
    const current = new Map<string, string>()
    const changed: string[] = []
    for (const p of parts) {
      current.set(p.name, p.content)
      if (this.lastEmittedAppendixParts.get(p.name) !== p.content) changed.push(p.content)
    }
    const sendFull = !this.appendixBaselineSent
    this.lastEmittedAppendixParts = current
    this.appendixBaselineSent = true
    if (sendFull) {
      if (parts.length === 0) return ''
      return `<context-update seq="${this.appendixSeq}">\n${parts.map(p => p.content).join('\n\n')}\n</context-update>`
    }
    if (changed.length === 0) return `<context-update seq="${this.appendixSeq}"/>`
    return `<context-update seq="${this.appendixSeq}" mode="delta">\n${changed.join('\n\n')}\n</context-update>`
  }
```
把 `engine.ts:339` 的 `buildDynamicAppendix(activeCtx, appendixMaxChars)` 改为 `this.buildAppendixBody(activeCtx, appendixMaxChars)`；`engine.ts:346` 的 `buildDynamicAppendix(dynamicCtx, appendixMaxChars)` 改为 `this.buildAppendixBody(dynamicCtx, appendixMaxChars)`。`cognitiveProjection` 前置逻辑（`fullAppendix = [projection, ...]`）保持不变。
移除 engine 对 `buildDynamicAppendix` 的 import（如不再被直接引用），改 import `buildDynamicAppendixParts`。

**调研背书：**
- fresh 路径仅在 `userContent !== cachedFreshForUser || isDuplicate`（`engine.ts:278`）进入；tool-call turn 复用 `cachedAppendix`，不调 `buildAppendixBody` → lastEmitted 每用户边界只更新一次。✓
- 两分支互斥（tracker 有/无），不会双更新 seq。

**验证：**
```bash
npm run typecheck
npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
```
新增 delta 测试（`appendixDelta: true` 建 engine）：
1. 首条用户消息 → trailer 含 `<context-update seq="1">` 且含 `<git-status>`（全量 baseline）。
2. 第二条用户消息、仅 git 变更（改 gitStatusCache 或 markGitDirty 后改 live 值）→ trailer 含 `mode="delta"` 且**只**含 `<git-status>`，不含未变的其它块。
3. 第三条用户消息、无任何变更 → trailer 含 `<context-update seq="3"/>`（自闭合）。
4. 同一用户消息内多次 buildOaiRequest（tool turn）→ seq 不增、cachedAppendix 复用。
5. `appendixDelta` 关时 → trailer 仍为无 seq 的 `<context-update>` 全量（回归）。

**提交：**
```bash
git add src/prompt/engine.ts src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "feat(prompt): emit delta context-update on new user boundary (任务 3/7)"
```

---

### 任务 4：静态提示加 context-update 协议说明

- [ ] 修改 `src/prompt/static.ts:24-58`（`<rules>` 内追加一条 rule）
- [ ] 测试 `src/prompt/__tests__/`（buildSystemPrompt 含协议文本）

**目标：** 在稳定（进缓存）的系统提示里加一句 supersede 语义，让模型正确解读多个 `<context-update>` 块。对全量模式也无害（全量永远重发全部）。

**实现：**
在 `static.ts` 的 `<rules>` 块内（`git-context-first` rule 之后）追加：
```
  <rule name="context-update-protocol">
  上下文里可能出现多个 <context-update> 块（带 seq 递增）。它们是累积的：后出现的同名子块（如 <git-status>、<progress>）覆盖先前同名块的值；某子块未在最新 update 中出现，表示它自上次起未变化——沿用最近一次出现的值。带 seq 的自闭合 <context-update/> 表示本轮无变化。
  </rule>
```

**调研背书：** grep 确认现状下 `<context-update>` 仅在 `volatile.ts`/`engine.ts` 产出，静态提示**无任何说明**——模型靠 XML tag 自行推断。delta 引入"缺席=未变"语义必须显式告知，否则模型可能误以为信息丢失。

**验证：**
```bash
npm run typecheck
npx tsx --test src/prompt/__tests__/static.test.ts   # 若存在；否则在 engine 测试断言 getSystemPrompt().includes('context-update-protocol')
```

**提交：**
```bash
git add src/prompt/static.ts
git commit -m "feat(prompt): document cumulative context-update protocol in system prompt (任务 4/7)"
```

---

### 任务 5：frozen 一致性回归测试（安全闸门）

- [ ] 测试 `src/prompt/__tests__/engine-cache-stability.test.ts`（追加 frozen+delta describe）

**目标：** 证明 delta 不破坏 frozen-snapshot 字节一致性——历史轮 user message 在后续请求中检索到的 frozen 内容与其作为 last 时发出的内容 byte-identical（这是命中率不掉的根本保证）。

**实现（纯测试，无源码改动）：**
用 `appendixDelta: true` 的 engine，构造序列：user1 → assistant1 → user2（新边界）→ 再次 buildOaiRequest 含 user1 为历史。断言：
1. user1 作为历史时，其 trailer === user1 首次作为 last 时的 trailer（含当时的 delta/baseline 块），byte-identical（复用既有 `historicalUserContent` helper）。
2. user2 的 trailer 含 `mode="delta"` 或 baseline，且 user1 历史块不随 user2 变化。
3. `getCacheEventStats().frozenFallbackRebuilds` 不因 delta 增加。

**调研背书：** `engine.ts:356-380` frozen 捕获完整 merged（含 appendix）；`getNextFrozen`（202-218）按内容 key 返回；delta 块同样写入 `frozenUserMerged`（`377`），机制路径与全量完全相同，故只需回归断言、无源码改动。

**验证：**
```bash
npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
```

**提交：**
```bash
git add src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "test(prompt): frozen snapshot byte-identity holds under delta appendix (任务 5/7)"
```

---

### 任务 6：压缩/历史重写边界重置 baseline（Phase 2 stale 治理）

- [ ] 修改 `src/prompt/engine.ts`（新增 public `resetAppendixBaseline()`）
- [ ] 修改压缩/会话分裂调用点，重写历史后调用 `resetAppendixBaseline()`
- [ ] 测试 `src/prompt/__tests__/engine-cache-stability.test.ts`

**目标：** 当历史被压缩/重写、承载旧 `<context-update>` 的 user 消息可能被裁剪时，下一轮强制重发全量 baseline，避免模型丢失"缺席=未变"所依赖的历史块。

**调研背书：**
- 历史重写来源：`engine.ts:436-503` 的剪枝只动 tool 消息（不删 user，故不影响 delta 历史）；真正删 user 历史的是 **trySessionSplit（86%）/ compaction coordinator**（外部重建 messages 数组）。调用者需 grep `trySessionSplit` / compaction 协调点（`src/agent/` 下 compact-boundary-coordinator），在其重写 messages 后调用 `engine.resetAppendixBaseline()`。
- 已有 `invalidateFreshCache`（任务 2 已重置 baseline）覆盖 sessionMemory/actionable/intent 三处；本任务补「压缩重写」这一类未走 invalidateFreshCache 的路径。

**实现：**
```typescript
  /** Force the next context-update to be a full baseline (call after history
   *  rewrite/compaction drops messages carrying prior context-update blocks). */
  resetAppendixBaseline(): void {
    this.lastEmittedAppendixParts = new Map()
    this.appendixBaselineSent = false
  }
```
在压缩/会话分裂重写 messages 数组的协调点（执行时 grep 定位 `compact-boundary-coordinator.ts` 中 history rewrite 完成处）追加 `this.promptEngine.resetAppendixBaseline()` 或经现有 engine 句柄调用。

**验证：**
```bash
npm run typecheck
npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
npm test   # 全量回归，确认压缩相关测试不破
```
新增测试：发 2 轮（baseline + delta）后调 `resetAppendixBaseline()`，第 3 轮 trailer 重新为全量（无 `mode="delta"`，含全部当前块）。

**提交：**
```bash
git add src/prompt/engine.ts src/agent/compact-boundary-coordinator.ts src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "feat(prompt): reset delta baseline on history rewrite (任务 6/7)"
```

---

### 任务 7：开关接线 + cache-log 验证 + 灰度

- [ ] 修改 `src/agent/create-agent-config.ts:109-119`（接 `appendixDelta`）
- [ ] 端到端验证（cache-log.jsonl）
- [ ] 全量测试

**目标：** 把 `appendixDelta` 接到主 engine 构造，由 env `RIVET_APPENDIX_DELTA` 控制（默认关）；在真实会话用 cache-log 验证 cacheCreate 降幅与命中率不退化。

**实现：**
`create-agent-config.ts` 的 `new PromptEngine({...})` 加：
```typescript
    appendixDelta: process.env['RIVET_APPENDIX_DELTA'] === '1',
```

**验证（runbook）：**
```bash
npm run typecheck
npm test                      # 2340+ 测试全过
RIVET_APPENDIX_DELTA=1 <启动 rivet 跑一个 3-4 轮真实会话>
```
然后核对 `.rivet/sessions/<id>/cache-log.jsonl`：
1. 轮间首请求（turn=0）非 commit 轮 cacheCreate 从 ~12K 降到 <4K。
2. 恒等式 `input === cacheRead + cacheCreate` 全条成立。
3. 整体 hitRate ≥ 改前同等工作量；`frozenClamped`/`frozenEvicted` 无异常增长。
4. 人工核验：commit 后的轮 delta 内含最新 `<git-status>`，模型未引用 stale 状态。

灰度：默认 `RIVET_APPENDIX_DELTA` 不设（关）。验证通过后再考虑把默认翻为开、并收紧 `engine.ts:232` 的 `appendixMaxChars` 作为二级保护（独立后续 PR）。

**提交：**
```bash
git add src/agent/create-agent-config.ts
git commit -m "feat(agent): wire RIVET_APPENDIX_DELTA env flag to prompt engine (任务 7/7)"
```

---

## 自检结果

1. **规格覆盖**：设计文档 Phase 1（结构化+diff+开关+静态提示）→ 任务 1-5、7；Phase 2（stale 治理/baseline 重置）→ 任务 6；Phase 3（放量/收紧预算）→ 任务 7 runbook 收尾。全覆盖。
2. **占位符扫描**：无 TODO/TBD；每个代码改动给出具体代码或精确编辑位置（任务 6 的压缩调用点需执行时 grep 定位，已标注调研动作）。
3. **类型一致性**：`AppendixPart`/`buildDynamicAppendixParts`/`appendixBlockName`/`buildAppendixBody`/`resetAppendixBaseline`/`appendixDelta` 在任务间签名一致；engine 字段名一致。
4. **调研背书**：`buildDynamicAppendix`（调用者已列）、`invalidateFreshCache`（3 调用者已列）、frozen 机制（行号已列）、历史重写来源（已区分剪枝 vs 压缩）均有背书；无未验证的删除操作（任务全为新增/包装，不删行为）。

## 已知风险与边界

| 风险 | 缓解 |
|------|------|
| 模型不解读 delta 语义 | 任务 4 静态提示 + 任务 7 默认关、灰度验证 |
| 压缩裁剪 user 历史导致旧块丢失 | 任务 6 resetAppendixBaseline |
| 消失型块（worktree-warning 转 green）supersede 不掉 | Phase 1 接受（旧值留历史）；如验证发现行为问题，后续加 tombstone |
| frozen 一致性 | 任务 5 回归闸门 + 任务 7 监控 frozenClamped/Evicted |
