# 天枢自我观测面板（Runtime Cockpit）

> **定位：** 天枢下一阶段优化提案  
> **状态：** 待设计  
> **来源：** 天枢复盘 2026-05-26 — "很多东西都有了，但还是分散的"  
> **目标：** 统一的 runtime 态势感知面板，让 agent 和用户建立共同态势感

---

## 1. 问题

当前天枢已有的运行时状态分散在多个独立子系统中：

| 子系统 | 当前获取方式 | 问题 |
|--------|-------------|------|
| Task Contract | prompt 注入 | agent 知道，用户看不到 |
| Cognitive Mirror | 内部 season 判断 | 隐式，无外部可观测性 |
| Season | prompt phase hint | 用户不知道当前处于哪个阶段 |
| Verification | TaskLedger.getVerificationStatus() | 需要调 deliver_task 才能看到 |
| Ownership | OwnershipLedger.getOwnedFiles() | 同上 |
| Cache Stats | CacheAdvisor 内部 | 无用户可见输出 |
| Session Memory | compact 后的 summary | 不可查询 |
| Risk | workspace-guard 内部 | 只在触发时可见 |

**核心矛盾：** agent 有丰富的内部状态，但没有统一的自我观测接口。用户无法建立态势感知，agent 自己也需要在 compact 后快速恢复上下文。

---

## 2. 目标产出

一个统一的 cockpit 视图，可被：
- **agent 自己**在 compact 后、任务切换时、交付前查询
- **用户**通过工具调用或 TUI 面板查看
- **prompt 系统**在关键节点自动注入（可选）

```
┌──────────────────────────────────────────────────────────┐
│ Task      executing / verifying / delivered               │
│ Ownership 7 owned / 3 external                           │
│ Verify    typecheck pass / tests partial / external fail │
│ Context   41% / split threshold 86%                      │
│ Cache     latest hit 92%                                 │
│ Memory    extracted 12 / durable 4                       │
│ Risk      low / stale git status warning                 │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 设计草案

### 3.1 数据源映射

| Cockpit 行 | 数据源 | 接口 |
|------------|--------|------|
| Task | TaskLedger + DeliveryGate state | `gate.getReport().state` |
| Ownership | OwnershipLedger | `ownership.getOwnershipReport()` |
| Verify | TaskLedger verifications | `taskLedger.getVerificationStatus()` + 细分 |
| Context | AgentLoop context usage | `session.getContextUsage()` / token count |
| Cache | CacheAdvisor | `cacheAdvisor.getStats()` |
| Memory | SessionMemory / compact history | 待定 |
| Risk | WorkspaceGuard | `guard.getCurrentRiskLevel()` |

### 3.2 接口形态（三选一或组合）

**A. 工具形态 — `cockpit` tool**

```typescript
// agent 或用户可随时调用
cockpit() → 返回格式化的状态面板文本
```

优点：最简单，复用现有工具基础设施。
缺点：需要 agent 主动调用。

**B. Prompt 注入形态 — volatile block**

在 `PromptEngine.buildOaiRequest()` 的 volatile 区域自动注入 cockpit 摘要。

优点：agent 每轮都能看到，compact 后自动恢复。
缺点：占用 token，需要控制长度。

**C. TUI 面板形态 — 侧边栏/状态栏**

在 TUI 界面中持续显示，类似 IDE 的状态栏。

优点：用户始终可见，不占 agent context。
缺点：需要 TUI 层改动，agent 看不到。

**推荐：A + B 组合。** 工具供按需查询，volatile 注入一行极简摘要（~50 tokens）供 agent 持续感知。

### 3.3 极简 volatile 摘要格式

```
[cockpit] task:executing own:7/3ext verify:pass/partial ctx:41% cache:92% risk:low
```

一行，~30 tokens，放在 volatile block 末尾。

---

## 4. 实现路径

### Phase 1：cockpit 工具（最小可用）

| 文件 | 职责 |
|------|------|
| `src/tools/cockpit.ts` | 新工具：聚合各子系统状态，返回格式化面板 |
| `src/main.tsx` | 注册 cockpit 工具 |

依赖：所有数据源已存在，只需聚合。

### Phase 2：volatile 摘要注入

| 文件 | 职责 |
|------|------|
| `src/prompt/cockpit-summary.ts` | 生成一行极简摘要 |
| `src/prompt/engine.ts` | volatile block 末尾追加 cockpit 摘要 |

### Phase 3：TUI 状态栏（可选）

| 文件 | 职责 |
|------|------|
| `src/tui/status-bar.tsx` | 渲染 cockpit 数据到 TUI 底部 |

---

## 5. 开放问题

| 问题 | 待决策 |
|------|--------|
| volatile 注入频率 | 每轮？每 N 轮？仅在 phase 切换时？ |
| Context 行的数据源 | token count 从哪里获取？session.messages.length vs 实际 token 估算 |
| Memory 行的语义 | "extracted 12" 指什么？compact 提取的 fact 数？session memory entries？ |
| Cache 行的粒度 | 只显示最近一次 hit rate？还是滑动窗口？ |
| 与 cognitive mirror 的关系 | cockpit 是否取代 mirror？还是 mirror 是 cockpit 的一个数据源？ |

---

## 6. 与现有系统的关系

```
cognitive_mirror ──┐
task_contract ─────┤
season/phase ──────┤
                   ├──→ cockpit (聚合层) ──→ tool output / volatile / TUI
ownership ─────────┤
verification ──────┤
cache_advisor ─────┤
workspace_guard ───┘
```

Cockpit 不替代任何子系统，它是**只读聚合层**。各子系统保持独立演进，cockpit 只做查询和格式化。
