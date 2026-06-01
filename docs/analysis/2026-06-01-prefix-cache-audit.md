# Prefix Cache 链路审计报告 — 2026-06-01

审计人：天璇（Opus 4.8）
审计范围：DeepSeek prefix cache 完整链路，从系统提示词到 API 请求组装
触发原因：memory 中标记的 cache-killer-git-status 需要确认是否已修复

---

## 一、审计结论

**缓存链路整体健康。** `d9256bc`（2026-05-23 git-status 移至 dynamic appendix）之后的 ~80 个 commit 没有引入新的 cache-breaking 模式。发现并修复了 3 个潜在缺陷。

---

## 二、缓存架构总览

```
API Request = [system_prompt, ...messages]

消息组装 (buildOaiRequest):
┌──────────────────────────────────────────────────────┐
│ system prompt (frozen) — 永不变                      │
├──────────────────────────────────────────────────────┤
│ 历史 user msg 0: frozenUserMerged["msg 0"][0]       │ ← 首次出现时冻结
│ 历史 assistant msg 0                                  │
│ 历史 user msg 1: frozenUserMerged["msg 1"][0]       │ ← 同上
│ 历史 assistant msg 1                                  │
│ ...                                                   │
├──────────────────────────────────────────────────────┤
│ 最新 user msg: frozenBase + dynamicAppendix          │ ← cachedFreshBlock
│   + "
---
" + 用户原文                              │    同一 user msg 内不重建
└──────────────────────────────────────────────────────┘

frozenBase (buildStableVolatileBlock — session 全程不变):
  <environment>           — cwd/platform/os
  <sober>                 — 天枢锚点（静态文本）
  <project-instructions>  — AGENTS.md + .rivet.md (30s TTL)
  <project-memory>        — .rivet/knowledge/memory.jsonl
  <seed-capsule>          — 天璇胶囊 L1
  <working-set>           — session 启动时确定

dynamicAppendix (buildDynamicAppendix — 每轮变，出现在对话历史之后):
  <tool-history>          — 最近 8 条
  <task-progress>         — 任务进度
  <git-status>            — git status (30s TTL + dirty flag)
  <recent-commits>        — 最近 5 条 commit
  <session-state>         — session 状态快照
  <cross-session-events>  — 跨 session 事件
  <worktree-warning>      — worktree 不一致警告
  <consolidated>          — habituated 字段（promoted 后）
```

**缓存命中的关键约束：**
- DeepSeek prefix cache 是字节级连续前缀匹配
- 历史消息的 frozen content 必须在首次冻结后永不变
- 最新消息的 frozenBase 部分必须与历史消息的 frozenBase 字节一致
- dynamicAppendix 只出现在最新消息尾部，不影响历史前缀

---

## 三、已修复的缺陷

### 3.1 frozenUserMerged key 碰撞（中风险） — `e2ca89e`

**根因**：`frozenUserMerged` 是 `Map<string, string>`，key 为消息原文。当用户发送两条相同内容时，第二条覆盖第一条的 frozen snapshot。

**触发场景**：用户发送"继续"、"ok"、"y"、"retry"等短消息多次。

**影响链路**：
```
Turn 3: 用户发 "继续"
  → frozenUserMerged.set("继续", FROZEN_T3)
  → FROZEN_T3 = cachedFreshBlock_T3 + "
---
" + "继续"

Turn 7: 用户发 "继续"（agent 执行了 4 轮工具调用）
  → frozenUserMerged.set("继续", FROZEN_T7)  ← 覆盖了 key "继续"
  → FROZEN_T7 = cachedFreshBlock_T7 + "
---
" + "继续"

回溯 Turn 3 的消息：
  → frozenUserMerged.get("继续") → FROZEN_T7  ← 拿到了错误的 snapshot
  → FROZEN_T3 的字节变成了 FROZEN_T7 的字节
  → 从该位置到请求末尾的前缀 → cache miss
```

**成本影响**：每次碰撞导致 ~140k tokens cache miss → 0.056 元额外支出。高频碰撞场景（用户习惯性发"继续"）可在 50 轮会话中累积 ~2.8 元。

**修复方案**：
- `Map<string, string>` → `Map<string, string[]>`
- 每个 content key 存储数组，重复消息按出现顺序分配 index（0, 1, 2...）
- `frozenFetchIndex: Map<string, number>` 追踪每轮调用的取回顺序
- 重复消息检测：`lastMessageCount` + `lastMessageHash` 区分「真正的重复消息」和「同一消息的 tool-call 轮次」
- eviction 策略：按数组总长度计数，从最长数组的头部移除

**验证**：27 cache stability tests + 21 engine tests + 2369 full suite 全部通过。

### 3.2 planModeState/worktreeReality 未显式 strip（低风险） — `4a45f05`

**根因**：`buildVolatileBlockInternal` 中有 `planModeState`（L381-385）和 `worktreeReality`（L374-379）的渲染代码。`buildStableVolatileBlock` 没有显式 strip 这两个字段。

**实际影响**：当前无——frozen base 在 constructor 中从 `config.volatileCtx` 构建，此时这两个字段是 `undefined`。`setPlanModeState()` 不触发 `rebuildFrozenBase()`。但这是**隐式依赖**，如果未来有人在 `rebuildFrozenBase` 中传入 planModeState，就会破坏缓存。

**修复**：在 `buildStableVolatileBlock` 中显式设置 `planModeState: undefined` 和 `worktreeReality: undefined`。

### 3.3 eviction 测试适配 — `e2ca89e`

`frozenUserMerged` 类型变更后，eviction 策略和测试断言需要适配。测试更新为只检查最近 64 条消息有 merged content。

---

## 四、遗留问题

### 4.1 `cachedFreshForUser` 对重复消息的缓存跳过（已缓解，未完全解决）

**位置**：`engine.ts:152`

**现状**：当 `userContent === cachedFreshForUser` 且不是 true duplicate 时，跳过 fresh block 重建。这意味着同一消息的第二次调用（tool-call 轮次）复用缓存——这是正确的。

但 true duplicate（用户真的又发了一次"继续"）在 `isDuplicate` 检测为 true 时会强制重建。检测依赖 `oaiMessages.length === lastMessageCount && msgHash !== lastMessageHash`。

**边缘情况**：如果用户在完全相同的消息数组上再次调用 `buildOaiRequest`（无任何变化），`isDuplicate` 为 false，不会重建。这是正确的——同一数组的重复调用应复用缓存。

**风险**：极低。当前检测覆盖了所有实际场景。

### 4.2 compaction 是否破坏 frozen prefix（待确认）

**位置**：`src/compact/`, `src/agent/compaction-controller.ts`

**疑点**：compaction 会替换/截断历史消息。如果 compaction 修改了已经被 frozen 的 user message 内容，frozenUserMerged 中的 snapshot 与实际消息不一致。

**已知防护**：
- `trySessionSplit` 在 86% context 阈值触发，创建新 session 而非修改当前消息
- `semanticPruneLayer1` 和 `detectStaleness` 跳过 `CACHE_ANCHOR_MESSAGES` 之前的 messages
- 1M+ 窗口跳过 pruning/masking（避免 mutate 历史消息）

**待确认**：
- compaction 是否会 splice/replace 历史 user messages
- 如果会，frozenUserMerged 的 stale entries 是否会导致 prefix 不一致
- 已启动后台审计 agent，结果待整合

### 4.3 `gitStatusCache` 后台刷新盲区（设计如此）

**位置**：`volatile-git.ts:57-63`

**机制**：`gitStatusCache.get()` 在 TTL 过期时触发异步刷新，但立即返回旧值。下次 `buildDynamicAppendix` 拿到的是 30s 前的 git status。

**时序问题**：
1. 用户发消息 → agent 执行 edit_file → `markGitDirty()`
2. agent 执行第二个 tool → 触发 buildOaiRequest → `refreshGit = true`
3. `buildDynamicAppendix` 调用 `gitStatusCache.get()` → 返回旧值（edit_file 的 git status 还在刷新中）
4. 用户看到的 git status 是 edit_file 之前的状态

**影响**：极低。git status 是信息性内容，不影响 agent 决策。30s TTL 保证了最终一致性。

**不建议修复**：阻塞刷新会增加 API 调用延迟。

### 4.4 `firstUserIdx` 双消息推送（极低风险）

**位置**：`engine.ts:207-214`

**机制**：当 `firstUserIdx` 没有 frozen entry 时（首次构建请求，或 eviction 后），推送 2 条消息（volatile block + raw message）而非 1 条 merged message。

**触发条件**：PromptEngine 被复用且 frozenUserMerged 被清空（eviction 超过 64 条）。实际上 eviction 只移除最早的 entries，`firstUserIdx` 对应的消息通常在 eviction 范围之外。

**影响**：消息数组长度在首次调用和后续调用之间不一致。下游代码如果按 index 假设消息结构会出错。但当前下游代码（API client）只遍历 messages，不依赖固定 index。

### 4.5 `rebuildFrozenBase` 使用初始 config（设计如此）

**位置**：`engine.ts:370-374`

**机制**：`rebuildFrozenBase()` 从 `config.volatileCtx` 构建 frozen base，这是 constructor 传入的初始值。如果 `rivetMd` 或 `workingSet` 在 session 中通过外部机制更新，rebuild 不会拿到最新值。

**实际影响**：无。`readRivetMd(ctx.cwd)` 有 30s TTL 缓存，`buildVolatileBlockInternal` 内部调用时会自动读取最新缓存。

### 4.6 coordinator.ts 3527 行（非缓存问题，但值得注意）

超过 800 行约定上限。是重构候选，但与缓存无关。拆分不影响缓存链路。

---

## 五、缓存健康指标

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| git-status 在 frozen prefix | ✅ 已移除 (d9256bc) | ✅ 保持 |
| consolidatedBlock 在 frozen prefix | ✅ 已移除 (a23724c) | ✅ 保持 |
| planModeState/worktreeReality strip | ❌ 隐式依赖 | ✅ 显式 strip (4a45f05) |
| frozenUserMerged key 碰撞 | ❌ 覆盖旧 snapshot | ✅ occurrence array (e2ca89e) |
| 1M+ 窗口 pruning/masking | ✅ 跳过 | ✅ 保持 |
| trailer mode append-only | ✅ | ✅ |
| frozenUserMerged eviction | ✅ max 64 | ✅ max 64 (数组适配) |

---

## 六、验证覆盖

| 测试文件 | 测试数 | 状态 |
|---------|--------|------|
| engine-cache-stability.test.ts | 27 | ✅ |
| engine.test.ts | 21 | ✅ |
| volatile.test.ts | — | ✅ |
| static.test.ts | — | ✅ |
| npm test (full suite) | 2369 | ✅ |
| tsc --noEmit | — | ✅ |

---

## 七、建议后续行动

| 优先级 | 行动 | 工作量 |
|--------|------|--------|
| P2 | 确认 compaction 是否 mutate 历史 user messages（4.2） | 1h |
| P3 | 为 frozenUserMerged 添加专门的 duplicate message 测试（当前测试文件语法问题暂缓） | 30min |
| P4 | coordinator.ts 拆分（非缓存相关） | 1-2d |

---

*审计完成于 2026-06-01。涉及 commits: d9256bc, 4a45f05, e2ca89e, 7c7367c。*
