> **Status: COMPLETED** — 2026-06-19

# loop.ts 拆分交接：W-L5~L8 进度 + 缓存 setter 时序缰绳

> **接棒说明**：本文给新会话理解 `src/agent/loop.ts` 拆分的当前状态与下一步。
> 上一阶段（W-L4 及之前）见 [`W-L4-交接-turn-orchestrator.md`](W-L4-交接-turn-orchestrator.md)。
> 本文覆盖 W-L5~L8（已全部落地）+ 终局高危波（turn-step 生产者，**已落地**）。
> 分支 `desktop/antigravity-base`，loop.ts 当前 **1045 行**（起点 2698 → W-L4 后 ~1952 → W-L8 后 1531 → 终局后 1045）。

## 1. 整体进度

| 波次 | 内容 | 提交 | 状态 |
|------|------|------|------|
| W-L1~L4 | PlanTrace / CompactBoundary / RuntimeHooks(私有方法) / TurnOrchestrator | 见 W-L4 交接文 | ✅ |
| W-L5a | SessionPersist 监听器 → `session-persist-listener.ts`(纯函数) | `8da9e8a1` | ✅ |
| W-L5b | 推理强度簇 → `ReasoningEffortController` | `dd24559d` | ✅ |
| W-L5c | 意图检索路由 → `IntentRetrievalRouteController` | `9d6992b9` | ✅ |
| W-L6a | HEARTH 反锚定 → `AntiAnchoringController` | `51b520ef` | ✅ |
| W-L6b | 模型路由影子遥测 → `ModelRoutingShadowController` | `f1e31cc9` | ✅ |
| W-L7a | 跨会话内存预热加载体 → `session-memory-warmup.ts`(纯函数) | `0b7c78db` | ✅ |
| W-L7b | 文件预热 → `PrewarmController` | `9c3c2179` | ✅ |
| W-L8a | `mapQueriedPheromones` → `pheromone-map.ts`(拆环依赖) | `7ba64882` | ✅ |
| W-L8b | runtime-hooks 流水线构造体 → `createRuntimeHooksPipeline(self)` | `0597d526` | ✅ |
| **终局** | **turn-step 生产者外迁（方案 B 自传 self）→ `turn-step-producer.ts`** | 未提交 | ✅ |

## 2. 当前代码结构

### 穿线模式（必须沿用）
```
loop-factory.ts:  export function createXxx(self: AgentLoop): Xxx { ... }   // class 控制器
loop-factory.ts:  export function loadXxx(deps): ...                         // 无状态纯函数体
loop.ts:          this.xxx = createXxx(this)                                 // 构造函数中创建
```
- 工厂函数 `import type { AgentLoop }` → 无运行时循环依赖。
- 子控制器文件 **绝不 import `AgentLoop`**，经 deps 接口（getter/setter 闭包）访问字段。
- 纯函数体（无状态）走 W-L5a/W-L7a 式独立模块，直接 `import` 进 loop.ts。
- **跨模块共享的纯函数**（如 `mapQueriedPheromones`）必须放独立模块（`pheromone-map.ts`），不能从 loop.ts 导出再被 loop-factory import —— 否则 loop→loop-factory→loop 运行时成环（W-L8a 的根因）。

### loop-factory.ts 现有工厂（14 个）
`createTurnStreamController` / `createTurnCompletionController` / `createToolExecutionController` / `createPlanTraceCoordinator` / `createCompactBoundaryCoordinator` / `createTurnOrchestrator` / `createTurnStepProducer` / `createReasoningEffortController` / `createIntentRetrievalRouteController` / `createAntiAnchoringController` / `createModelRoutingShadowController` / `createPrewarmController` / `createRuntimeHooksPipeline` / `buildRuntimeSnapshot`

### W-L5~L8 新增文件
- `src/agent/session-persist-listener.ts`（纯函数 `attachSessionPersistListener`）
- `src/agent/reasoning-effort-controller.ts`
- `src/agent/intent-retrieval-route-controller.ts`
- `src/agent/anti-anchoring-controller.ts`
- `src/agent/model-routing-shadow-controller.ts`
- `src/agent/session-memory-warmup.ts`（纯函数 `loadSessionMemories`）
- `src/agent/prewarm-controller.ts`
- `src/agent/pheromone-map.ts`（纯函数 `mapQueriedPheromones`）

### 终局波新增文件（方案 B 自传 self）
- `src/agent/turn-step-producer.ts`（`TurnStepProducer(self: AgentLoop)`，`import type` 仅类型无运行时成环）：承载 `initializeRun` / `buildTurnRequest` / `runPerception` + 私有 `runCognitivePrep`，方法体逐字搬运（`this.`→`this.self.`，`runCognitivePrep` 自调除外），`PHASE_CLASS_MAP` 常量随 `runPerception` 移入本文件。
- `src/agent/__tests__/turn-cache-timing.test.ts`（安全网）：spy `invalidateFreshCache` / `refreshGitContextIfNeeded` / `setHarnessAdvisoryBlock` / `buildOaiRequest` 调用序，锁定 §3 三条时序不变量；外迁前后均 3/3 绿，证明字节不变。
- 去私有化（终局波追加）：方法 `createTurnStreamController` / `createTurnCompletionController` / `recordModelRoutingShadow` / `bindSessionDomain` / `abortStalledTurn` / `refreshReliabilityDecision` / `startFsWatcher`；字段 `_turnInterruptCount` / `_pendingAbort` / `latestPolicySignals` / `sessionAffordanceAdaptations` / `pressureMonitor` / `perception` / `intent` / `compactBoundaryCoordinator` / `intentRoute` / `lastSeenEventId` / `baselineFingerprint` / `latestCognitiveSnapshot` / `persist` / `_taskDepthLayer` / `_planMethodology`。

### 已去私有化字段（W-L5~L8 累计，供 factory 经 self 访问）
`taskContract` / `_currentEffortShadow` / `_lastRetrievalRoute` / `initialUserMessage` / `prewarmController` /
`thetaState` / `stigmergyStore` / `loadedPheromones` / `sensoriumSnapshots` / `sessionDomain` /
`pendingLeaveMark` / `_sessionNumericId` / `prevAnchorGraphHash` / `prevStreamedText` / `antiAnchoring` / `stanceTally`(readonly)

## 3. 缓存 setter 时序：到底影响哪些（核心）

终局波要动的 `initializeRun` / `buildTurnRequest` / `runPerception` 是 **prompt 组装的生产路径**，密集调用 `config.promptEngine.set*`。前缀缓存（DeepSeek exact-prefix cache）是项目核心优化，命中率 99%+ vs 击穿后 ~16%。机械外迁这三个方法时，**setter 的调用顺序 + 相对 `buildOaiRequest` 与「用户消息边界」的位置必须逐字保留**，否则击穿缓存。

### 3.1 PromptEngine 的两层缓存机制（[`src/prompt/engine.ts`](../../src/prompt/engine.ts)）
- **frozenBase / volatileBlock**：稳定前缀。`volatileBlock` 只在「新用户消息边界」从 `frozenBase` swap（`buildOaiRequest` 内 L233）。tool-call 轮次复用旧 `volatileBlock` → 前缀字节不变。
- **cachedFreshForUser / cachedAppendix**：每条用户消息生成一次 fresh volatile，tool 轮全程复用。`invalidateFreshCache()` 清空它 → 下一轮 appendix 变化 → 前缀击穿。

### 3.2 两类 setter（决定影响面）

**A 类 — 会击穿缓存（调用时机是硬约束）**：
| setter | 副作用 | loop.ts facade/调用点 |
|--------|--------|----------------------|
| `updateSessionMemory` | `rebuildFrozenBase()` + `invalidateFreshCache()` | `loop.updateSessionMemory`(:636) |
| `setActionableTurn` | 值变化时 `invalidateFreshCache()` | `initializeRun`(:1081) |
| `setIntentRetrievalRoute` | `invalidateFreshCache()` | `intentRoute.buildForTurn`→ (`initializeRun`:1091) |
| `updateTools` | 重算 `fingerprint`（tools 进稳定前缀） | `loop.updateTools`(:640) |

A 类的铁律：**只能在「用户消息边界」（每条 user message 一次、`buildOaiRequest` 之前）触发**。若外迁把它们挪到 tool-call 轮次之间、或挪到首个 `buildOaiRequest` 之后，fresh cache 在 tool 轮被清 → 命中率 99%→16%；若 `rebuildFrozenBase` 后 `volatileBlock` 在错误时点 swap → 首条 user message 从 byte 0 变化 → 0% 击穿（engine 注释 cache-log #28/#44 根因）。

**B 类 — 缓存安全（只写字段，渲染进 dynamic appendix 或下个边界）**：
`setSessionState` / `setWorktreeReality` / `setCognitiveProjection` / `setPhaseHint` / `setTaskProgress` / `setBehaviorMirror` / `setStrategyShift` / `setRepairHint` / `setImpactHint` / `setAffordanceHint` / `setPolicyGuidance` / `setPlanCacheAdvisory` / `setPlanTraceAppendix` / `setHarnessAdvisoryBlock` / `setDecisions` / `setCrossSessionEvents` / `setActiveDomain` / `setPlanModeState` / `setTaskDepthLayer` / `setPlanMethodology` / `setSkillAdvisoryBlock` / `setCrossSessionMemoryBlock` / `setMentionContextBlock`
—— 这些**不调用 invalidateFreshCache**，外迁时只需保持「在 `buildOaiRequest` 之前完成」，相互顺序无字节影响（但建议仍逐字保留，避免隐性耦合）。

### 3.3 `buildTurnRequest` 尾部的时序锚点（[loop.ts](../../src/agent/loop.ts):1199-1258）
逐字保留这条链，顺序不可换：
```
setHarnessAdvisoryBlock(advisoryBus.render())   // B 类
→ setCrossSessionEvents(...)                     // B 类（跨会话事件，仅进 appendix）
→ setSessionState(renderForVolatile())           // B 类
→ await refreshGitContextIfNeeded(cwd)           // 必须 await 完成，否则 buildOaiRequest 读到 30s 旧 git
→ buildOaiRequest(messages, toolHistory, ctxWindow)  // 所有 setter 必须已落定
```
**影响面小结**：终局外迁动这三个方法时，受影响的是「A 类 setter 的边界归属」「git 预刷新的 await 完成点」「全部 setter 早于 buildOaiRequest」三条；B 类只要不被挪到 buildOaiRequest 之后即安全。

## 4. 终局高危波执行要点（turn-step 生产者）

> **状态：✅ 已落地（方案 B 自传 self）。** 先建 §4.2 安全网（外迁前 3/3 绿基线）→ 机械外迁三方法 + `runCognitivePrep` 到 `turn-step-producer.ts` → 验证：`tsc` src/agent 零错、安全网外迁后仍 3/3 绿（时序字节不变）、`loop.test.ts` 33/34（getCacheDiagnostic 预存失败）、loop.ts 1531→1045。下文为当时的执行剧本，留作复盘。

### 4.1 范围
`initializeRun`(:968) / `buildTurnRequest`(:1156) / `runPerception`(:1384) —— prompt 组装 + 首轮请求构造。

### 4.2 必补测试（搬运前先建安全网）
现有 `loop.test.ts` 的 `getCacheDiagnostic` 项是**预存失败**（HEAD 既有，非回归，唯一允许失败）。终局波前需补「缓存 setter 时序测试」：
1. **A 类 setter 边界单测**：断言 `updateSessionMemory`/`setActionableTurn`/`setIntentRetrievalRoute`/`updateTools` 在一条 user message 的多 tool 轮内**只触发一次** invalidate（可用 `getCacheEventStats()` 的 `volatileSwaps`/计数器断言）。
2. **顺序锚点测试**：mock promptEngine，断言 `buildTurnRequest` 中 B 类 setter + `refreshGitContextIfNeeded`(await) 全部早于 `buildOaiRequest`。
3. **fresh 复用测试**：同一 user message 连续多轮 `buildOaiRequest`，断言 `cachedFreshForUser` 不被清（命中率代理指标）。

### 4.3 建议节奏
独立会话、单波单提交。先补 §4.2 测试全绿 → 再机械外迁（diff 只见搬运，控制流零改写）→ 每步 `tsc --noEmit`(src/agent 零错) + 安全网 + `loop.test.ts`(33/34)。

## 5. 硬缰绳速查
```
❌ 禁止改变 A 类 promptEngine setter 的调用时机/边界归属
❌ 禁止把任何 setter 挪到 buildOaiRequest 之后
❌ 禁止 refreshGitContextIfNeeded 不 await 就 buildOaiRequest
❌ 禁止 anchor 前重排消息 / mid-round 调 replaceMessages
❌ 禁止 coordinator / 纯函数模块 import AgentLoop（避免运行时成环）
❌ 跨模块共享纯函数放独立模块，不从 loop.ts 再导出给 loop-factory
✅ 只搬运不改逻辑：每波 diff = 方法体移动 + this→self + 字段去私有化
```

## 6. 验证命令
```bash
npx tsc --noEmit 2>&1 | rg "src/agent" || echo "无 src/agent 错误"   # 并发 TUI 会话的 src/tui/__tests__ 报错非本线
node --import tsx --test src/agent/__tests__/loop.test.ts             # 主测试，当前 33/34（1 预存失败）
wc -l src/agent/loop.ts                                                # 当前 1531
```

## 7. 遗留项（非拆分范围）
| 遗留项 | 说明 |
|--------|------|
| `loop.test.ts` getCacheDiagnostic | 预存失败，`'First turn — building prefix cache'` vs `null`，HEAD 既有 |
| `createToolExecutionController` 薄 facade | W-L8 后仍保留私有 facade 方法（与直调风格不一致，可后续统一） |
| 并发会话工作区 | 本仓库常有并发 agent 会话改 `src/tui/*`、`src/agent/star-event.ts` 等，提交只 add 本会话目标文件 |
