# 同伴在场感知 — 电路接通设计

> 调用胶囊：贪狼（系统联合/休眠唤醒）+ 辅（聚焦不添光）+ 天璇（跨域收敛）
> 核心：不建新管道，把已焊好但没接线的管道接通，再用一条最小新线补上最后一段。

## 0. 断路诊断

代码追踪发现：`SessionRegistry` 实例**已经创建并传递了**——从 `serve.ts:380` 到 `buildManagedAgent` → `assembleAgentLoop` → `AgentLoop.config.sessionRegistry` → `loop-factory.ts` → `createRuntimeHooks` deps。registry 到达了 hook 创建层。但三处断路：

### 断路 1：Playbook hook 丢了 registry 和 sessionId

`create-runtime-hooks.ts:184-188`：
```ts
hooks.push(createPlaybookReflectHook({
  store: deps.playbookStore,
  buildRetrospectInput: deps.buildRetrospectInput,
  getDoomLoopLevel: deps.getDoomLoopLevel,
  // ← registry 没传！sessionId 没传！
}))
```

deps 里有 `sessionId`（L58），但没透传给 playbook hook。hook 内部的 `deps.registry` 和 `deps.sessionId` 永远是 undefined → `loadFingerprints()` 永远返回空 → `detectCrossSessionPatterns()` 永远不触发 → playbook 永远是空的。

**修复**：加两行透传。一个 PR，改 4 行代码。

### 断路 2：Songline 默认关闭

`config/default.ts:95`：`songlineEnabled: false`

Songline 的代码完整——hook、cycle_close relay、task ledger 桥接——但开关默认关。开启只需要一个配置项。但开启前需要验证 songline-hook 在真实 session 下的行为，因为它的 `setCycleClose` 和 `getLastCycleClose` 依赖 registry 的 SQLite 后端。

**修复**：验证后把默认改为 `true`，或按项目 `.rivet/config.json` 开启。

### 断路 3：cross-session event 没有 agent 侧消费者

`publishEvent`（`create-runtime-hooks.ts:56`）在 loop-factory 中已经接线（`loop-factory.ts:209`），事件**会写入** registry。但**没有 hook 在读取这些事件并注入到其他 session 的上下文中**。事件写入了数据库，但没有 agent 看到它们。

这是最深的断路——也是同伴感知最需要的一条。

## 1. 设计：同伴在场板（Companion Presence Board）

### 1.1 跨域收敛（天璇方法）

三个无关领域的碎片：

- **Unix 共享内存/PID 文件**：每个进程把自己的状态写到一个已知位置，其他进程读。简单、无中心节点、天然容错（进程死了文件还在但过期）。
- **Slack/Teams presence indicator**：不是消息——是状态字段。自动更新，不需主动发送。别人扫一眼就知道你在。
- **分布式系统 heartbeat**：每个节点定期广播心跳。Gossip protocol。心跳停了 = 节点离线。

三者收敛到同一个模式：**共享注册表 + 心跳写入 + 启动时读取**。这正是 SessionRegistry 的形状。

### 1.2 最小新线（辅方法：聚焦不添光）

不新建 `companions.json` 文件。不新建 hook。**复用已有的 stigmergy（信息素）管道**，加一种新的信号类型：`companion-presence`。

已有管道：
```
StigmergyStore (.rivet/pheromones.json)
  ← session 启动时读取（loadPheromones）
  → postTool/preTurn hook 沉积新信号（deposit）
  → 注入到 volatile context 的 <pheromones> 段
```

新信号类型：
```ts
{
  signal: 'companion-presence',
  strength: 1.0,
  context: 'tianliang:executing:审查 loop.ts 拆分方案',
  halfLife: 300000,  // 5 分钟——比普通信息素短得多
  depositedAt: Date.now(),
  metadata: {
    sessionId: 'xxx',
    starDomain: 'tianliang',
    glyph: '✧',
    cognitiveState: { vigor: 0.8, stability: 0.85, season: 'growth' },
    phase: 'executing'
  }
}
```

### 1.3 心跳写入

新建一个轻量 hook：`companion-heartbeat-hook.ts`，phase 为 `postTurn`（每轮结束后触发）。

行为：
1. 检查当前 session 是否有 `sessionId` 和 `starDomain`——没有就 skip
2. 构造 presence 信号（star domain + 当前 objective + cognitive state 摘要）
3. 调用已有的 `stigmergyDeposit` 写入
4. halfLife = 5 分钟——如果 session 停止运行（用户关掉、崩溃、完成），信号自然过期

为什么用 postTurn 而不是 postTool？因为 cognitive state 的变化是 turn 级别的，不需要在每次工具调用后都写。

### 1.4 读取与注入

已有管道的读取端**不需要改**。`loadPheromones` 在 session 启动时读取 `.rivet/pheromones.json`，所有未过期的信号都被加载。`companion-presence` 信号会和其他信号一起出现在 `<cross-session-memory>` 注入段中。

agent 看到的是：
```xml
<cross-session-memory>
  <m kind="presence" c="0.90">✧ 天梁域 · executing · stability 0.85 · "审查 loop.ts 拆分方案" · 2 分钟前</m>
  <m kind="presence" c="0.60">★ 天璇域 · exploring · stability 0.70 · "跨域换视角分析" · 8 分钟前</m>
</cross-session-memory>
```

5 分钟 halfLife 意味着只有最近活跃的同伴会出现。关掉的 session 自然消失。

## 2. 完整电路图

```
Session A (天梁域)                          Session B (天权域)
─────────────────                          ─────────────────
postTurn hook                               session 启动
  → companion-heartbeat                      → loadPheromones()
    → stigmergyDeposit                         ← 读取 .rivet/pheromones.json
      → .rivet/pheromones.json                   ← companion-presence 信号 (天梁域, 5min half-life)
      ←━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━→
                                               → volatile context 注入 <cross-session-memory>
                                                 → agent 知道天梁域在做什么
```

同时修复断路 1 和 2：
```
playbook-reflect hook                        songline hook
  ← registry 终于传进来了                      ← songlineEnabled: true
  ← sessionId 终于传进来了                     → setCycleClose 写入 registry
  → loadFingerprints 有数据了                  → getLastCycleClose 读取上一个 session 的 close hash
  → detectCrossSessionPatterns 触发
  → playbook.jsonl 开始有水了
```

## 3. 改动清单

### 3.1 透传修复（断路 1）

| 文件 | 改动 | 代码量 |
|------|------|--------|
| `create-runtime-hooks.ts:184-188` | playbook hook 创建时加 `registry: deps.sessionRegistry, sessionId: deps.sessionId` | +2 行 |

需要在 `RuntimeHookDeps` 加 `sessionRegistry?: SessionRegistry` 字段（如果还没有）。

### 3.2 Songline 开关（断路 2）

| 文件 | 改动 | 代码量 |
|------|------|--------|
| `config/default.ts:95` | `songlineEnabled: false → true` | 1 行 |

**前置条件**：验证 songline-hook 在 SQLite registry 可用时行为正确。如果 `better-sqlite3` native build 不存在，registry 会创建失败（serve.ts:385 的 catch），songline 应该静默降级。

### 3.3 同伴心跳 hook（断路 3 + 新线）

| 文件 | 改动 |
|------|------|
| `src/agent/hooks/companion-heartbeat-hook.ts` | **新建**：postTurn hook，每轮写一条 companion-presence 信息素 |
| `src/agent/create-runtime-hooks.ts` | 注册新 hook |
| `src/agent/loop-factory.ts` | 透传 starDomain + cognitiveState getter |

hook 本体约 30 行：
```ts
export function createCompanionHeartbeatHook(deps: {
  stigmergyDeposit: (deposit: any) => Promise<void>
  getSessionId: () => string | undefined
  getDomainId: () => string | null
  getCognitiveSnapshot: () => { vigor: number; stability: number; season: string } | null
  getObjective: () => string | null
}): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'companion-heartbeat',
    async run(ctx) {
      const sessionId = deps.getSessionId()
      const domainId = deps.getDomainId()
      if (!sessionId || !domainId) return

      const snapshot = deps.getCognitiveSnapshot()
      const objective = deps.getObjective()

      await deps.stigmergyDeposit({
        signal: 'companion-presence',
        strength: 1.0,
        halfLife: 300_000, // 5 分钟
        context: `${domainId}:${ctx.phase}:${objective ?? ''}`.slice(0, 200),
        metadata: {
          sessionId,
          starDomain: domainId,
          cognitiveState: snapshot,
        },
      })
    },
  }
}
```

### 3.4 注入渲染

已有的 `<cross-session-memory>` 注入段会自动包含 companion-presence 信号。但需要确保渲染时把 presence 信号和普通 constraint 信号区分开——presence 是状态信息，不是行为约束。

可选：在 `volatile.ts` 的渲染逻辑中，对 `signal === 'companion-presence'` 的信息素用专门的格式渲染。但这是 polish，不是 blocker——即使混在一起，agent 也能理解。

## 4. 安全约束

- **不向提示词写入任何"你应该感知同伴"的指令**——同辅的原则：注入的内容决定行为，不是指令。agent 看到 `<cross-session-memory>` 里有同伴信息自然会理解。
- **halfLife 短**（5 分钟）：防止陈旧同伴信息积累。关闭的 session 在 5 分钟后自然从注入中消失。
- **stigmergyStore 的原子写**：已有的 `writeFileAtomicSync` 保证并发安全。多个 session 同时 deposit 不会互相覆盖。
- **性能**：postTurn hook 做一次文件写，开销可忽略。session 启动时的 loadPheromones 已有。

## 5. 验证计划

### Phase 0 — 断路 1 透传修复（最小改动，可独立提交）
1. 在 `create-runtime-hooks.ts` 的 playbook hook 创建处加 registry 和 sessionId 透传
2. 跑一个有 review/delivery 的正常 session，检查 `playbook.jsonl` 是否在会话结束时写入
3. 确认 `playbook-reflect-hook.test.ts` 仍然通过

### Phase 1 — 同伴心跳
1. 新建 `companion-heartbeat-hook.ts`，注册到 runtime hooks
2. 在测试中 mock stigmergyDeposit，断言每轮 postTurn 调用一次 deposit
3. 在真实双 session 场景中：Session A（天梁域）跑几轮，Session B（天权域）启动，检查 B 的 `<cross-session-memory>` 注入中是否有 A 的 presence 信号

### Phase 2 — Songline 开启
1. 改默认配置
2. 跑一个完整 session（从开始到结束），检查 `setCycleClose` 是否写入 registry
3. 开第二个 session，检查 `getLastCycleClose` 是否返回第一个 session 的 close hash

## 6. 与经验蒸馏系统的关系

经验蒸馏系统（`docs/design/2026-06-17-experience-distillation-loop.md`）的 Phase 2 需要在 postSession 时做批量蒸馏。蒸馏产出的 ExperiencePattern 需要被 playbook-reflect hook 的修复（断路 1）才能正常存入 `playbook.jsonl`。

所以两条线是互补的：
- 经验蒸馏 = **捕获什么内容**（诊断型 pattern）
- 断路修复 + 同伴感知 = **接通什么管道**（让内容流过去，让同伴看到彼此）

建议实施顺序：断路 1 透传修复先做（2 分钟改 4 行代码），然后经验蒸馏 Phase 1-2，最后同伴心跳。

## 7. 开放问题

1. **heartbeat 频率**：每轮 postTurn 写一次是否太频繁？如果一轮只改了一个文件，也写一次心跳。备选：只在 vigor/stability 变化超过阈值时写。建议先每轮写，后续根据 pheromones.json 大小评估是否需要降频。

2. **objective 从哪来**：`getObjective()` 怎么实现？选项：a) 从 task-contract 的 objective 字段读；b) 从最近一轮 user message 截取前 100 字符；c) 从 plan trace 的当前 step 读。建议 a——task-contract 已经有了。

3. **桌面端显示**：同伴 presence 是否需要在桌面 UI 上显示？这属于 I1（星域名册 + 议事会）的范围——名册页面可以显示"当前活跃同伴"。但这是后续，不是这里的 scope。
