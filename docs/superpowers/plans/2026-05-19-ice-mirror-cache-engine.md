# 天枢·冰鉴（Ice Mirror）上下文缓存引擎 — 设计方案

**目标：** 将 Rivet 的前缀缓存命中率从 ~5% 提升到 90%+，支持多 provider 适配。

**存在性证明：** CTCL + Claude Code + cliproxy 在 DeepSeek V4 Pro 上达到 99.8% 缓存命中率。

---

## 根因

`buildStableVolatileBlock` strip 了 `gitStatus`，导致 FROZEN ≠ FRESH → DeepSeek exact-prefix 在差异点之后全部 miss。

```
当前：
  Turn 1: system | user(FRESH-有git) | user("hello")
  Turn 2: system | user(FROZEN-无git) | user("hello") | ... | user(FRESH-有git) | user("read")
                          ↑ 字节不同，prefix cache 断裂

修复后：
  Turn 1: system | user(FROZEN-有git快照) | user("hello")
  Turn 2: system | user(FROZEN-有git快照) | user("hello") | ... | user(FROZEN + appendix) | user("read")
                                                                          ↑ FROZEN 部分字节相同
```

## 设计原则

1. **冻结即快照**：session 开始时拍完整快照，会话内不刷新
2. **FROZEN = FRESH（动态字段空时）**：FROZEN 是 FRESH 的字节前缀
3. **新内容只追加在尾部**：动态字段作为 `<context-update>` 附录
4. **provider-native 优先**：每个 provider 用原生缓存 API

## 双区布局

```
Messages Array:
  ┌── 冻结区 (字节不变，缓存命中) ──┐
  │ user(FROZEN-volatile)            │   ← session 快照
  │ user("hello")                    │
  │ assistant(...)                   │
  │ user(tool_result)                │
  │ ...所有历史轮次...               │
  └──────────────────────────────────┘
  ┌── 工作区 (每次变，接受 miss) ────┐
  │ user(FROZEN + dynamic appendix)  │   ← 最新消息
  │ user("new message")              │
  │ assistant(tool_use)              │
  │ user(tool_result)                │
  └──────────────────────────────────┘
```

## FROZEN 包含（session 快照）

- `<environment>` — platform, cwd, OS
- `<project-instructions>` — .rivet.md
- `<project-memory>` — .rivet/knowledge/*.md
- `<git-status>` — **session 开始时的快照**
- `<recent-commits>` — session 开始时
- `<working-set>` — session 开始时
- `<session-memory>` — 跨 session 记忆

## Dynamic Appendix（仅最新消息）

- `<tool-history>`, `<task-progress>`, `<behavior-mirror>`, `<active-claims>`, `<historical-lessons>`, `<decisions>`, `<strategy-shift>`, `<repair-hint>`, `<cerebellar-hint>`, `<star-domain>`, `<context-ledger>`

## 字节关系

```
FROZEN: <context>\nstable...\n</context>
FRESH（无动态）: <context>\nstable...\n</context>              ← 与 FROZEN 完全相同
FRESH（有动态）: <context>\nstable...\n</context>\n<context-update>\ndynamic...\n</context-update>
                 ↑ FROZEN 是 FRESH 的字节前缀
```

---

## 改动文件

| 文件 | 变更 |
|------|------|
| `src/prompt/volatile-snapshot.ts` | **新建**。`createVolatileSnapshot` — session 开始时拍快照冻结 |
| `src/prompt/volatile.ts` | `buildStableVolatileBlock` 不再 strip gitStatus。新增 `buildDynamicAppendix`。`buildLatestTurnVolatileBlock` = FROZEN + appendix |
| `src/agent/create-agent-config.ts` | 用 `createVolatileSnapshot` 替代裸 `{ cwd }` |
| `src/api/cache-strategy.ts` | breakpoint 放在冻结区/工作区边界 |

## 实施任务

| # | 任务 | 状态 |
|---|------|------|
| 1 | 创建 volatile-snapshot memoize 层 | ✅ 完成 |
| 2 | 修改 buildStableVolatileBlock + 新增 buildDynamicAppendix | ✅ 完成 |
| 3 | Wire snapshot into create-agent-config | ✅ 完成 |
| 4 | 多轮前缀稳定性测试 | ✅ 完成 |
| 5 | 改进 applyExplicitBreakpoints 边界 | 待执行 |
| 6 | 更新 fingerprint 测试 | 待执行 |
| 7 | 全量测试 + typecheck + 缓存验证 | 待执行 |

## 预期效果

| 指标 | 修改前 | 修改后 | CC+CTCL 基准 |
|------|--------|--------|-------------|
| Turn 2 cache hit | ~5% | ~50-70% | ~70% |
| Turn 5 cache hit | ~5% | ~75-85% | ~90% |
| Turn 10 cache hit | ~5% | ~85-92% | ~95%+ |

## 神经科学映射

| 冰鉴组件 | 神经对应 |
|----------|---------|
| 冻结区 | 新皮层（慢、稳定表征） |
| 工作区 | 海马体（快、情景记忆） |
| StarPhase 触发压缩 | sharp-wave ripple（记忆巩固） |
| Stigmergy 驱逐 | 选择性抑制 |
| PrefixFingerprint | 记忆再巩固检测 |
