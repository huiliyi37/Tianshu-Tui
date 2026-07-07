# 天枢 Changelog — 2026-06-01 缓存链路审计与修复

## 🔍 审计范围

对 DeepSeek prefix cache 完整链路进行代码审计，覆盖：
- `src/prompt/volatile.ts` — frozen/dynamic 分离
- `src/prompt/engine.ts` — trailer mode、frozenUserMerged、消息组装
- `src/prompt/volatile-git.ts` — git status 缓存
- `src/prompt/static.ts` — 系统提示词
- `src/compact/` — 压缩对前缀的影响

审计结论：`d9256bc`（2026-05-23 git-status 移至 dynamic appendix）之后的 ~80 个 commit 没有破坏缓存链路。发现并修复了 3 个潜在缺陷。

---

## 🐛 修复

### 1. frozenUserMerged key 碰撞（中风险） — `e2ca89e`

**根因**：`frozenUserMerged` 使用消息原文作为 Map key。当用户发送两条相同内容（如"继续"、"ok"、"y"），第二条覆盖第一条的 frozen snapshot。

**影响链路**：
```
Turn 3: 用户发 "继续" → frozenUserMerged.set("继续", FROZEN_T3)
Turn 7: 用户发 "继续" → frozenUserMerged.set("继续", FROZEN_T7) ← 覆盖
回溯 Turn 3: frozenUserMerged.get("继续") → FROZEN_T7 ← 字节变了
从 Turn 3 到请求末尾的整个前缀 → cache miss
```

**修复**：
- `Map<string, string>` → `Map<string, string[]>`，每个 content key 存储数组
- 重复消息按出现顺序分配 index（0, 1, 2...），互不覆盖
- `frozenFetchIndex` 追踪每轮调用的取回顺序
- 重复消息检测：通过 `lastMessageCount` + `lastMessageHash` 区分「真正的重复消息」和「同一消息的 tool-call 轮次」

**涉及文件**：`src/prompt/engine.ts`, `src/prompt/__tests__/engine.test.ts`

### 2. planModeState/worktreeReality 未显式 strip（低风险） — `4a45f05`

**根因**：`buildVolatileBlockInternal` 中有 `planModeState` 和 `worktreeReality` 的渲染代码，但 `buildStableVolatileBlock` 没有显式 strip 这两个字段。

**实际影响**：当前无——frozen base 在 constructor 中构建时这两个字段是 undefined，`setPlanModeState()` 不触发 `rebuildFrozenBase()`。但这是隐式依赖，未来修改可能意外破坏缓存。

**修复**：在 `buildStableVolatileBlock` 中显式设置 `planModeState: undefined` 和 `worktreeReality: undefined`。

**涉及文件**：`src/prompt/volatile.ts`

### 3. eviction 测试适配（无风险） — `e2ca89e`

**根因**：`frozenUserMerged` 从 `Map<string, string>` 改为 `Map<string, string[]>` 后，eviction 策略需要适配数组结构。

**修复**：更新 eviction 逻辑为「按数组总长度计数，从最长数组的头部移除」。测试断言更新为只检查最近 64 条消息。

**涉及文件**：`src/prompt/__tests__/engine.test.ts`

---

## ✅ 验证

| 测试套件 | 结果 |
|---------|------|
| engine-cache-stability.test.ts (27 tests) | ✅ 全部通过 |
| engine.test.ts (21 tests) | ✅ 全部通过 |
| volatile.test.ts | ✅ 全部通过 |
| static.test.ts | ✅ 全部通过 |
| tsc --noEmit | ✅ 无错误 |

---

## 📋 缓存架构快照（修复后）

```
API Request = [system_prompt, ...messages]

frozenBase (buildStableVolatileBlock — 永不变):
  <environment>           — cwd/platform/os
  <sober>                 — 天枢锚点（静态）
  <project-instructions>  — AGENTS.md + .rivet.md (30s TTL)
  <project-memory>        — .rivet/knowledge/memory.jsonl
  <seed-capsule>          — 天璇胶囊 L1
  <working-set>           — session 启动时确定
  [planModeState]         — 已 strip，不会进入 frozen
  [worktreeReality]       — 已 strip，不会进入 frozen

dynamicAppendix (buildDynamicAppendix — 每轮变):
  <tool-history>          — 最近 8 条
  <task-progress>         — 任务进度
  <git-status>            — git status（30s TTL + dirty flag）
  <recent-commits>        — 最近 5 条 commit
  <session-state>         — session 状态快照
  <cross-session-events>  — 跨 session 事件
  <worktree-warning>      — worktree 不一致警告

frozenUserMerged (per-content array — 每条 user message 冻结一次):
  key: 消息原文
  value: [FROZEN_T1, FROZEN_T2, ...]  ← 重复消息各自独立
  fetchIndex: 每轮调用重置，按序取回
```

---

*涉及 3 个 commit（4a45f05, e2ca89e），覆盖 prompt 子系统。*
