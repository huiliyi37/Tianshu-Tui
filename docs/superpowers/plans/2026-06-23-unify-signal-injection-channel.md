# 统一信号注入通道——完成 injectUserMessage 向 AdvisoryBus 迁移

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现。

**目标：** 将所有 hook 中的 `injectUserMessage` 调用迁移到统一的 AdvisoryBus，消除 message-array 注入通道，并添加 System Prompt / Star Domain 优先级显式规则。

**架构：** 问题 8 的两个子问题——(A) 四个 hook 仍直接调用 `injectUserMessage` 将系统信号注入到 user message 流中，绕过 AdvisoryBus 统一出口，且可能被模型误读为"用户在纠正我"；(B) System Prompt（`static.ts`）通用规则与星域特化指令在没有显式优先级时依赖模型隐式偏好裁决。修复方案：给 mcts-planning / blind-exploration / anchor-break-scout 添加 `advisoryBus` 参数，将 signal-consumer 剩余的 `injectUserMessage` 调用迁移到 bus，清理 courage / kick 中已是死代码的 `injectUserMessage` 回退分支，在 `static.ts` 添加一行星域优先级规则。改动仅影响 prompt 渲染位置（从 message 流移到 dynamic appendix 的 `<星域-advisory>` 块），不改变语义内容。

**技术栈：** TypeScript strict，node:test + node:assert/strict

---

## 调研背书

### 全量 injectUserMessage 调用点枚举

通过 `grep` 全量扫描 `src/agent/hooks/`，共 7 个 hook 文件 10 处调用：

| 文件 | 行号 | 调用方 | advisoryBus 路径已有？ | 生产环境 advisoryBus 传入？ |
|------|------|--------|----------------------|--------------------------|
| `signal-consumer-hook.ts` | 35 | `search-breadth` 注入 | ❌ | ✅ 是，但此路径未用 |
| `signal-consumer-hook.ts` | 47 | `task-decomposition` 注入 | ❌ | ✅ 是，但此路径未用 |
| `signal-consumer-hook.ts` | 91 | `dead-end` 注入 | ✅ 已有（优先走 bus） | ✅ 是 |
| `courage-hook.ts` | 110 | `CONSTITUTIONAL_HINT` / `RISK_HINT` | ✅ 已有（优先走 bus） | ✅ 是 |
| `kick-hook.ts` | 62 | `dissipative-kick` 注入 | ✅ 已有（优先走 bus） | ✅ 是 |
| `mcts-planning-hook.ts` | 57 | `allJunk` 警告 | ❌ | ❌ 否 |
| `mcts-planning-hook.ts` | 65 | `seeds` 注入 | ❌ | ❌ 否 |
| `blind-exploration-hook.ts` | 25 | `seedFree` 指令 | ❌ | ❌ 否 |
| `anchor-break-scout-hook.ts` | 136 | 外域 scout 发现注入 | ❌ | ❌ 否 |
| `dedup-guard-hook.ts` | 77 | 重复检测（已完全迁移，无回退） | ✅ 仅 bus | ✅ 是 |

### 调用链路追踪

```
hook.ctx.effects.injectUserMessage(text)
  → turn-perception.ts:105: addUserMessage(message)
    → wrapSystemReminder(text) → "<system-reminder>\n...\n</system-reminder>"
      → 进入 message 数组，role='user'
        → engine.ts buildOaiRequest(): isSystemReminder() → 跳过边界检测
          → 作为独立 user message 传入 API（缓存安全，但位置在 message 流中）
```

对比 advisoryBus 路径：
```
hook → advisoryBus.submit(entry)
  → turn-step-producer.ts:303: advisoryBus.render(activeStarName)
    → promptEngine.setHarnessAdvisoryBlock(rendered)
      → volatile.ts buildDynamicAppendixParts(): <harness-advisory>
        → 作为 dynamic appendix 子块，位于最新 user message 末尾
```

### 存在原因分析

- **mcts-planning-hook**: 反锚定探索（opt-in via `antiAnchoring`），将 lightweight seed model 生成的探索路径注入主模型上下文。仅运行一次（`hasRun` 守卫）。存在原因：让主模型看到多角度探索结果，打破首次锚定。
- **blind-exploration-hook**: 反锚定探索（opt-in via `antiAnchoring.blindExploration`），在首轮注入"广泛探索"指令。仅运行一次。存在原因：防止模型过早收敛到用户的第一种表述。
- **anchor-break-scout-hook**: P2 外域侦察（opt-in via `anchorBreakScout`），派遣正交星域 worker 探索后注入发现。仅运行一次。存在原因：打破单一星域的认知盲区。
- **signal-consumer-hook L35/L47**: `search-breadth` 和 `task-decomposition` 信号。每次触发可能运行（有 `once` 去重）。存在原因：响应 sensorium 策略信号，调整探索广度或建议任务拆分。

### 生产环境 advisoryBus 可用性确认

`create-runtime-hooks.ts` 中：
- `createSignalConsumerRuntimeHook({ advisoryBus: deps.advisoryBus })` — 始终传入
- `createCourageHook({ ..., advisoryBus: deps.advisoryBus })` — 始终传入
- `createKickRuntimeHook({ ..., advisoryBus: deps.advisoryBus })` — 始终传入
- `createDedupGuardHook({ ..., advisoryBus: deps.advisoryBus })` — 始终传入
- `createBlindExplorationHook(...)` — **未传入**，需添加
- `createMCTSPlanningHook(...)` — **未传入**，需添加
- `createAnchorBreakScoutHook(...)` — **未传入**，需添加

`RuntimeHookDeps.advisoryBus` 字段由 `main.tsx` 或 `loop-factory.ts` 的调用方创建 `new AdvisoryBus()` 后传入，始终存在。

### 边缘情况

1. **courage-hook 回退路径**：`CONSTITUTIONAL_HINT`（~280 chars）和 `RISK_HINT`（~130 chars）作为 advisory entry 的 `content` 字段，不含 XML 标签。advisoryBus 的 `render()` 用 `escapeXml` 包裹——与原来 `injectUserMessage` 直传裸 XML 不同。需确认：`CONSTITUTIONAL_HINT` 和 `RISK_HINT` 内部已含 `<天权-感知>` XML 标签，经过 `escapeXml` 后 `<` 会变成 `&lt;`——这会破坏语义。这是 **已有 bug**：当前走 advisoryBus 路径时，courage 的 XML 标签已被错误转义。修复方案：将 courage entry 的 content 改为纯文本（去掉 XML 标签），因为 advisoryBus 自己会包裹 `<entry>` 标签。

2. **signal-consumer L35/L47**：`<search-breadth mode="wide" />` 和 `<天梁-感知 type="decomposition">...` 是 XML，同样面临 escapeXml 问题——但它们是纯 XML 标签，没有需要保留的文本内容。`search-breadth` 可以转为纯文本 advisory；`task-decomposition` 可以提取内文。

3. **MCTS/blind-exploration/anchor-break-scout 的内容**：均含 `<破军-探索>` XML 标签。迁移到 advisoryBus 时需去掉 XML 外层标签，因为 bus 自己会包裹 `<entry>`。

---

## 任务

### 任务 1：给 blind-exploration-hook 添加 advisoryBus 参数

- [ ] 修改 `src/agent/hooks/blind-exploration-hook.ts:7-20`
- [ ] 修改 `src/agent/create-runtime-hooks.ts:217-219`（blind-exploration 装配点）
- [ ] 测试 `src/agent/__tests__/blind-exploration-hook.test.ts`

**目标：** blind-exploration-hook 不再调用 `injectUserMessage`，改为向 advisoryBus 提交 entry。

**实现：**

修改 `BlindExplorationHookOpts` 接口，添加 `advisoryBus?: AdvisoryBus`：
```typescript
// blind-exploration-hook.ts
import type { AdvisoryBus } from '../advisory-bus.js'

export interface BlindExplorationHookOpts {
  activeTurns?: number[]
  /** A1: unified advisory bus — exploration directive routes through Bus instead of injectUserMessage. */
  advisoryBus?: AdvisoryBus
}
```

修改 `run` 方法，当 advisoryBus 存在时走 bus，否则回退 injectUserMessage（过渡期兼容，任务 5 统一清理）：
```typescript
run(ctx: RuntimeHookContext) {
  if (!activeTurns.has(ctx.snapshot.turn)) return
  
  if (opts.advisoryBus) {
    opts.advisoryBus.submit({
      key: 'blind-exploration',
      priority: 0.6,
      category: 'cerebellar',
      tier: 'operational',
      content: '【破军】广泛探索：在确定方案前，考虑替代框架、相邻问题和非常规角度。不固守最显而易见的理解。',
    })
  } else {
    ctx.effects.injectUserMessage(
      '<破军-探索 type="blind-exploration">Before committing to an approach: ' +
      'explore the problem space broadly. Consider alternative framings, ' +
      'adjacent problems, and non-obvious angles. ' +
      'Do not fixate on the most obvious interpretation of the request.</破军-探索>',
    )
  }
}
```

修改 `create-runtime-hooks.ts` 装配点，传入 advisoryBus：
```typescript
// create-runtime-hooks.ts line ~217
...(deps.antiAnchoring?.enabled && deps.antiAnchoring.blindExploration
  ? [createBlindExplorationHook({ activeTurns: [deps.antiAnchoring.planningTurn], advisoryBus: deps.advisoryBus })]
  : []),
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/blind-exploration-hook.test.ts
```

**提交：**
```bash
git add src/agent/hooks/blind-exploration-hook.ts src/agent/create-runtime-hooks.ts
git commit -m "refactor(hooks): add advisoryBus to blind-exploration-hook (任务 1/6)"
```

---

### 任务 2：给 mcts-planning-hook 添加 advisoryBus 参数

- [ ] 修改 `src/agent/hooks/mcts-planning-hook.ts:1-70`
- [ ] 修改 `src/agent/create-runtime-hooks.ts:220-228`（MCTS 装配点）
- [ ] 测试 `src/agent/__tests__/mcts-planning-hook.test.ts`

**目标：** mcts-planning-hook 不再调用 `injectUserMessage`，改为向 advisoryBus 提交 entry。

**实现：**

修改 `MCTSPlanningHookOpts` 接口，添加 `advisoryBus?: AdvisoryBus`：
```typescript
import type { AdvisoryBus } from '../advisory-bus.js'

export interface MCTSPlanningHookOpts {
  // ... 现有字段 ...
  /** A1: unified advisory bus — planning results route through Bus instead of injectUserMessage. */
  advisoryBus?: AdvisoryBus
}
```

修改 hook 工厂函数签名和 `run` 方法：

```typescript
export function createMCTSPlanningHook(opts: MCTSPlanningHookOpts): PreTurnRuntimeHook {
  // ... 现有初始化代码 ...

  return {
    phase: 'preTurn',
    name: 'mcts-planning',
    async run(ctx: RuntimeHookContext) {
      // ... 现有守卫逻辑 ...
      
      if (result.allJunk) {
        if (opts.advisoryBus) {
          opts.advisoryBus.submit({
            key: 'mcts-all-junk',
            priority: 0.7,
            category: 'cerebellar',
            tier: 'operational',
            content: '【破军】MCTS 警告：所有探索路径均为任务措辞的纯回声。尝试从更高抽象层重构问题。贪狼胶囊（docs/seed-capsule-tanlang.md）有探索方法论。',
          })
        } else {
          ctx.effects.injectUserMessage(
            '<破军-探索 type="mcts">WARNING: All explored paths are pure echo of the task wording. ' +
            'Consider reframing at a higher level of abstraction. 贪狼胶囊（docs/seed-capsule-tanlang.md）有探索方法论。</破军-探索>',
          )
        }
      } else {
        const seedList = result.seeds
          .map((s, i) => `- Seed ${i + 1}: ${s.text}`)
          .join('\n')
        if (opts.advisoryBus) {
          opts.advisoryBus.submit({
            key: 'mcts-seeds',
            priority: 0.6,
            category: 'cerebellar',
            tier: 'operational',
            content: `【破军】MCTS 探索路径：\n${seedList}`,
          })
        } else {
          ctx.effects.injectUserMessage(
            `<破军-探索 type="mcts">以下是从不同角度生成的探索路径，供参考：\n${seedList}</破军-探索>`,
          )
        }
      }
    },
  }
}
```

修改 `create-runtime-hooks.ts` 装配点：
```typescript
...(deps.antiAnchoring?.enabled && deps.antiAnchoring.mctsPlanning && deps.callAntiAnchoringSeedModel && deps.getInitialUserMessage
  ? [createMCTSPlanningHook({
      callSeedModel: deps.callAntiAnchoringSeedModel,
      branches: deps.antiAnchoring.branches,
      planningTurn: deps.antiAnchoring.planningTurn,
      threshold: deps.antiAnchoring.projectionThreshold,
      getUserMessage: deps.getInitialUserMessage,
      onResult: deps.onAntiAnchoringMCTSResult,
      advisoryBus: deps.advisoryBus,
    })]
  : []),
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/mcts-planning-hook.test.ts
```

**提交：**
```bash
git add src/agent/hooks/mcts-planning-hook.ts src/agent/create-runtime-hooks.ts
git commit -m "refactor(hooks): add advisoryBus to mcts-planning-hook (任务 2/6)"
```

---

### 任务 3：给 anchor-break-scout-hook 添加 advisoryBus 参数

- [ ] 修改 `src/agent/hooks/anchor-break-scout-hook.ts:10-140`
- [ ] 修改 `src/agent/create-runtime-hooks.ts:239-248`（scout 装配点）
- [ ] 测试 `src/agent/__tests__/anchor-break-scout.test.ts`

**目标：** anchor-break-scout-hook 不再调用 `injectUserMessage`，改为向 advisoryBus 提交 entry。

**实现：**

修改 `AnchorBreakScoutHookDeps` 接口，添加 `advisoryBus?: AdvisoryBus`：
```typescript
import type { AdvisoryBus } from '../advisory-bus.js'

export interface AnchorBreakScoutHookDeps {
  // ... 现有字段 ...
  /** A1: unified advisory bus — scout findings route through Bus instead of injectUserMessage. */
  advisoryBus?: AdvisoryBus
}
```

修改 `run` 方法中的注入逻辑（约 line 136）：
```typescript
if (dispatched) {
  if (deps.advisoryBus) {
    deps.advisoryBus.submit({
      key: 'anchor-break-scout',
      priority: 0.55,
      category: 'cerebellar',
      tier: 'operational',
      content: `【破军】外域侦察（${foreignDomainId}）：\n${packet}`,
    })
  } else {
    ctx.effects.injectUserMessage(formatScoutInjection(packet, foreignDomainId))
  }
}
```

修改 `create-runtime-hooks.ts` 装配点：
```typescript
if (deps.anchorBreakScout?.config.enabled && deps.sessionId) {
  hooks.push(createAnchorBreakScoutHook({
    config: deps.anchorBreakScout.config,
    getCoordinator: deps.anchorBreakScout.getCoordinator,
    getSessionId: () => deps.sessionId,
    getObjective: deps.getObjective ?? (() => null),
    getActiveDomainId: deps.getDomainId ? () => deps.getDomainId!() ?? null : undefined,
    getDoomLoopLevel: deps.getDoomLoopLevel,
    getAbortSignal: deps.anchorBreakScout.getAbortSignal,
    store: deps.meridianIndexer?.getDb() ?? null,
    advisoryBus: deps.advisoryBus,
  }))
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/anchor-break-scout.test.ts
```

**提交：**
```bash
git add src/agent/hooks/anchor-break-scout-hook.ts src/agent/create-runtime-hooks.ts
git commit -m "refactor(hooks): add advisoryBus to anchor-break-scout-hook (任务 3/6)"
```

---

### 任务 4：将 signal-consumer-hook 剩余 injectUserMessage 迁移到 advisoryBus

- [ ] 修改 `src/agent/hooks/signal-consumer-hook.ts:32-50`
- [ ] 测试 `src/agent/__tests__/signal-consumer-hook.test.ts`

**目标：** `search-breadth` 和 `task-decomposition` 信号不再走 `injectUserMessage`，改为走 advisoryBus。

**实现：**

替换 L35 的 `search-breadth` 注入：
```typescript
// Before (L31-36):
if (strategy?.explorationBreadth !== undefined && strategy.explorationBreadth > 0.6) {
  once('search-breadth:wide', () => {
    ctx.effects.injectUserMessage('<search-breadth mode="wide" />')
  })
}

// After:
if (strategy?.explorationBreadth !== undefined && strategy.explorationBreadth > 0.6) {
  once('search-breadth:wide', () => {
    if (options.advisoryBus) {
      options.advisoryBus.submit({
        key: 'search-breadth',
        priority: 0.5,
        category: 'cerebellar',
        tier: 'operational',
        content: '【破军】探索广度扩展——当前任务需要更广泛的搜索。不要过早收敛到第一个方案。',
      })
    } else {
      ctx.effects.injectUserMessage('<search-breadth mode="wide" />')
    }
  })
}
```

替换 L47 的 `task-decomposition` 注入：
```typescript
// Before (L45-48):
if (pressure?.suggestion === 'task_decomposition') {
  once('pressure:task-decomposition', () => {
    ctx.effects.injectUserMessage('<天梁-感知 type="decomposition">检测到任务过大，建议拆分为子步骤后逐一完成。天梁的分波执行节奏：先完成一个子目标并验证，再推进下一步。</天梁-感知>')
  })
}

// After:
if (pressure?.suggestion === 'task_decomposition') {
  once('pressure:task-decomposition', () => {
    if (options.advisoryBus) {
      options.advisoryBus.submit({
        key: 'task-decomposition',
        priority: 0.6,
        category: 'discipline',
        tier: 'operational',
        content: '【天梁】检测到任务过大，建议拆分为子步骤后逐一完成。先完成一个子目标并验证，再推进下一步。',
      })
    } else {
      ctx.effects.injectUserMessage('<天梁-感知 type="decomposition">检测到任务过大，建议拆分为子步骤后逐一完成。天梁的分波执行节奏：先完成一个子目标并验证，再推进下一步。</天梁-感知>')
    }
  })
}
```

注意：L88-95 的 `dead-end` 路径已有 advisoryBus 优先逻辑，只需确认回退路径保留。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/signal-consumer-hook.test.ts
```

**提交：**
```bash
git add src/agent/hooks/signal-consumer-hook.ts
git commit -m "refactor(hooks): migrate signal-consumer search-breadth and task-decomposition to advisoryBus (任务 4/6)"
```

---

### 任务 5：清理 courage-hook 和 kick-hook 的 injectUserMessage 死代码

- [ ] 修改 `src/agent/hooks/courage-hook.ts:104-114`
- [ ] 修改 `src/agent/hooks/kick-hook.ts:58-66`
- [ ] 测试 `src/agent/__tests__/courage-hook.test.ts`、`src/agent/__tests__/courage-hook-constitutional.test.ts`
- [ ] 测试 `src/agent/__tests__/kick-hook.test.ts`

**目标：** 移除 courage-hook 和 kick-hook 中的 `injectUserMessage` 回退分支。生产环境中 `advisoryBus` 始终由 `create-runtime-hooks.ts` 传入（已确认），回退分支是死代码。

**实现：**

courage-hook.ts L104-114：移除 `if (config.advisoryBus) { ... } else { ctx.effects.injectUserMessage(...) }` 中的 else 分支，改为仅走 advisoryBus：

```typescript
// Before (L104-114):
if (config.advisoryBus) {
  config.advisoryBus.submit({ ... })
} else {
  ctx.effects.injectUserMessage(constitutional ? CONSTITUTIONAL_HINT : RISK_HINT)
}

// After:
config.advisoryBus!.submit({
  key: 'courage',
  priority: constitutional ? CONSTITUTIONAL_PRIORITY : 0.5,
  tier: constitutional ? 'constitutional' : 'operational',
  category: 'constitutional',
  content: constitutional ? CONSTITUTIONAL_HINT : RISK_HINT,
})
```

同时修复 **已有 bug**：`CONSTITUTIONAL_HINT` 和 `RISK_HINT` 当前含有 `<天权-感知>` XML 标签。advisoryBus 的 `render()` 方法会对 content 做 `escapeXml`，导致标签被转义为 `&lt;天权-感知&gt;`——破坏语义。将这两个常量的 XML 标签去掉，改为纯文本：

```typescript
// Before:
const RISK_HINT = '<天权-感知 type="risk">风险信号出现。在下一个工具调用之前...'

// After (纯文本，advisoryBus 自行包裹 <entry> 标签)：
const RISK_HINT = '风险信号出现。在下一个工具调用之前，用一句话说出当前方向的最大风险。如果没有风险，说"风险评估：无阻塞风险"。天权胶囊（docs/seed-capsule-tianquan.md）有称量方法论可供参考。'
```

```typescript
// Before:
const CONSTITUTIONAL_HINT = '<天权-感知 type="constitutional">信念宪法：连续多轮无验证推进...'

// After:
const CONSTITUTIONAL_HINT = '信念宪法：连续多轮无验证推进，信心单调下降。你必须输出一次实质性验证——包含三件不可省略的信息：①你读了哪个文件的哪几行、②从这些行中确认了什么具体事实、③这个事实如何影响你的下一步决策。缺任何一件，方向暂停。不可用"已验证/无问题/检查通过"替代——那是不履行。'
```

kick-hook.ts L58-66：同样移除 else 分支：

```typescript
// Before:
if (deps.advisoryBus) {
  deps.advisoryBus.submit({ ... })
} else {
  ctx.effects.injectUserMessage(fullMessage)
}

// After:
deps.advisoryBus!.submit({
  key: 'dissipative-kick',
  priority: 0.55,
  tier: 'operational',
  category: 'discipline',
  content: fullMessage,
})
```

同步更新 `KickRuntimeHookDeps` 和 `CourageHookConfig` 接口：将 `advisoryBus?: AdvisoryBus` 改为 `advisoryBus: AdvisoryBus`（必填），反映生产环境实际语义。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/courage-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/courage-hook-constitutional.test.ts
npm exec -- tsx --test src/agent/__tests__/kick-hook.test.ts
```

**提交：**
```bash
git add src/agent/hooks/courage-hook.ts src/agent/hooks/kick-hook.ts
git commit -m "refactor(hooks): remove injectUserMessage dead code in courage and kick hooks (任务 5/6)"
```

---

### 任务 6：在 static.ts 添加 System Prompt / Star Domain 优先级规则

- [ ] 修改 `src/prompt/static.ts:BASE_PROMPT` 中的 `<rules>` 段
- [ ] 测试 `npx tsc --noEmit`（纯文本修改，不影响类型）

**目标：** System Prompt 与 Star Domain 指令之间存在隐式优先级真空。当通用规则（如 `<beliefs>` 中的"直接说出异议"）和星域特化指令（如天梁的"不为一处不确定停摆整条交付"）在同一场景给出不同倾向时，模型依赖隐式偏好裁决。添加一行显式优先级规则。

**实现：**

在 `static.ts` 的 `BASE_PROMPT` 常量中，`<rules>` 段末尾（`</rules>` 闭合标签之前）添加一条新规则：

```typescript
// 在 <rule name="state-machine-boundary-scan"> 闭合后，</rules> 闭合前添加：
  <rule name="star-domain-precedence">
  星域指令（以【星名】标注的 consolidated 块内容，如【天权】【天梁】）优先级高于本提示词中的通用行为指引。当两者在同一场景给出不同倾向时，遵循星域指令——它是针对当前任务类型特化的行为约束。无星域指令覆盖时，通用规则完整适用。
  </rule>
```

位置：在 `static.ts` 约第 100 行的 `</rules>` 之前，`state-machine-boundary-scan` 规则之后。

**认知影响说明**：此修改不改变任何现有行为——星域指令与通用规则在现有星域定义中不存在已知的实质冲突。它作为安全网，确保未来新增星域或修改 volatileBlock 时，星域特化约束不会被通用规则无声覆盖。

**验证：**
```bash
npx tsc --noEmit  # 纯文本修改，typecheck 通过即可
```

**提交：**
```bash
git add src/prompt/static.ts
git commit -m "feat(prompt): add star-domain precedence rule in system prompt (任务 6/6)"
```

---

## 验证总览

全部任务完成后，运行全量 typecheck 和相关测试：

```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/blind-exploration-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/mcts-planning-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/anchor-break-scout.test.ts
npm exec -- tsx --test src/agent/__tests__/signal-consumer-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/courage-hook.test.ts
npm exec -- tsx --test src/agent/__tests__/courage-hook-constitutional.test.ts
npm exec -- tsx --test src/agent/__tests__/kick-hook.test.ts
```

预期：全部通过，typecheck 零错误。

---

## 自检

1. **规格覆盖**：问题 8 的两个子问题均映射到任务——子问题 A（injectUserMessage 迁移）→ 任务 1-5；子问题 B（优先级真空）→ 任务 6。
2. **占位符扫描**：无 TODO / TBD / 待定 / 补充细节 / "添加适当的错误处理" / 未定义的类型。
3. **类型一致性**：所有接口变更（`advisoryBus?: AdvisoryBus`）在 `create-runtime-hooks.ts` 装配点同步传入，名称/签名/路径跨任务一致。
4. **调研背书**：所有 10 处 injectUserMessage 调用均已枚举，每个修改操作的调用方和存在原因已确认。advisoryBus 在生产的可用性已通过 `create-runtime-hooks.ts` 确认。
5. **指标选择自检**：注入通道数量从 5 减为 4（`injectUserMessage` 实质上被 advisoryBus 完全替代作为 hook 信号的唯一出口），以"仍在使用的注入通道数"作为有效性判据。
