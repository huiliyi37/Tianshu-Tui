# 天枢 Agent 主循环 — 经络图

> 「穴位」= 关键函数；「气血走向」= 数据流 / 调用顺序。
> 本文是定位任何 agent 运行时行为的入口地图。
>
- 基于代码版本：rivet 2.9.0（分支 feat/rivet-performance-optimization）
- 核心入口：`src/main.ts` → `bootstrap.ts` → `AgentLoop.run()` → `TurnOrchestrator.execute()`
- 实证数据来源：`~/.rivet/sessions/<slug>/<id>/cache-log.jsonl`（见文末）

---

## 一、总览：三层分离

```
用户输入
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  main.ts: onSubmit → agent.run(prompt, callbacks)       │  UI 层
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  AgentLoop.run() — 入口闩                                │  门卫层
│  _running 重入保护 → _pendingAbort 清零 → 新 AbortCtrl  │
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  TurnOrchestrator.execute() — 循环本体                   │  循环层
│  for turn in 0..maxTurns { … }                           │
└─────────────────────────────────────────────────────────┘
```

**架构要点**：`AgentLoop`（`loop.ts`，~1270 行）本身**不含循环逻辑**——它是个持有 ~80 个字段的「状态容器」，所有动作委托给控制器。`loop-factory.ts` 是**经络的绑定层**：每个控制器通过 `self.xxx` 闭包把穴位接到 AgentLoop 的字段上。

切换模型 / 会话时，`bootstrap.ts` 的 `switchAgentRuntime` / `switchAgentSession` **原地重建 AgentLoop**（保持 session / toolRegistry / persist 不变，前缀缓存不丢）。

---

## 二、核心经络：一次 `agent.run()` 的气血流转

### 穴位 0：`initializeRun`（TurnStepProducer，每 run 一次）

进入 turn 循环前的「开穴」，做的事极多，顺序极重要：

```
warmupMemories()              ← 跨会话记忆（physarum/immune/p3）懒加载
  │
abortController ??= new()     ← 确保 Esc 在 warmup 窗口也能生效
  │
startFsWatcher()              ← 文件变更信号（Zeitgeber）
  │
TurnHeartbeat(silentMs=20s, hardStallMs=240s)  ← 看门狗，核心保活机制
  │  └ onHardStall → abortStalledTurn()  ← 假死强解锁
  │
★ reset 全部累积状态           ← traceStore/prediction/evidence/sensorium...
  │
bindSessionDomain(userInput)  ← 星域人格绑定（注入方法论）
  │
recordUserInputClaims()       ← 从用户输入提取文件观察声明
  │
preUserMessageSplit()         ← 主动 session split（在 addUserMessage 之前！）
  │
session.addUserMessage(userInput)  ← 消息真正入栈
  │
classifyTurnMode → actionable/task/followUp/chat
  │
extractTaskContract() / mergeFollowUpIntoContract()  ← 任务契约
  │
intentRoute.buildForTurn()    ← 意图检索路由（决定调哪些工具）
  │
classifyTaskDepth / classifyPlanMethodology  ← 任务深度层 + TDD 策略
  │
★ PromptEngine 大量 setter：    ← 这些必须在 buildOaiRequest 之前
  │   setSkillAdvisoryBlock / setCrossSessionMemoryBlock
  │   setMentionContextBlock / setPlanCacheAdvisory
  │   setReasoningEffort (auto-reasoning + bandit delta)
  ▼
return { heartbeat, wrappedCallbacks, actionable, turnMode }
```

> **硬约束**（代码注释反复强调）：PromptEngine 的 setter 顺序、`refreshGitContextIfNeeded`、`buildOaiRequest` 三者的相对顺序是**硬约束**——乱序会破坏 DeepSeek exact-prefix cache。

### 穴位 1-N：turn 循环（TurnOrchestrator.execute 主体）

每个 turn = 一次完整 API 调用 + 工具执行。气血走向：

```
┌─ ① abort 检查 ──────────────────────────────────────────┐
│  signal.aborted? → removeLastMessage + onAbort + return │  出口
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ② ResourceSensor + TurnBudget ─────────────────────────┐
│  snap = getLatestResourceSnapshot()                     │  资源感知
│  rssRatio → createTurnBudget(rssRatio)                  │  内存吃紧→降级
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ③ runCompaction ───────────────────────────────────────┐
│  compactBoundaryCoordinator.runCompaction(turn, snap)   │
│   ├ trySessionSplit()    ← 86% 压力极限，冷启动边界      │
│   ├ maybeCompact()       ← LLM 压缩                     │
│   └ stale/heap rounds    ← 滞后压缩                     │
│  全程 rejectOnAbort(signal, task) 竞速                   │
│  shouldAbort? → onAbort + return                        │
│  userMessageConsumed? (split 会替换消息列表)            │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ④ reset 单 turn 状态 ──────────────────────────────────┐
│  streamedText='' / lastPrewarmAt=0                      │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑤ prewarmRecentReads ──────────────────────────────────┐
│  把最近读过的文件预热进 PrewarmCache                     │  加速
│  getGitChangeRate() 异步（文件变更率，季节信号）         │
│  setLatestFsWatcherState()（实时外部信号）              │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑥ runPerception ───────────────────────────────────────┐  ★ 大穴位
│  TurnStepProducer.runPerception():                      │
│   ├ pressureMonitor.check()  ← 上下文压力                │
│   ├ perception.perceive()    ← 产出 sensorium            │
│   │    (复杂度/压力/信心/稳定性 + 季节 + 阶段判定)        │
│   ├ classifySeason()         ← 认知季节                  │
│   ├ computeEFE()             ← 自由能信号                 │
│   ├ selectPolicy()           ← 策略选择                   │
│   ├ setToolContext()         ← 工具上下文注入提示         │
│   ├ advanceContractStatus()  ← 任务契约状态机            │
│   │    └ checkTddGate()      ← TDD 门禁                  │
│   └ runCognitivePrep()       ← 认知投影注入               │
│      (cognitive-mirror + 契约 + 验证缺口 + 免疫提示)      │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑦ runConvergenceCheck ─────────────────────────────────┐  防死循环
│  evaluateConvergence(turn, phaseClass, ...)             │
│   ├ L1: advisory（收敛警告）                             │
│   ├ L2: shouldKick → 注入 system-reminder               │
│   └ L3: shouldForceSplit → trySessionSplit              │
│       shouldAbort? → onAbort + return                   │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑧ runReplanCheck ──────────────────────────────────────┐
│  planTraceCoordinator: 计划偏离检测（U6）                 │
│  注入 course-correction 到 appendix                      │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑨ buildTurnRequest ────────────────────────────────────┐  ★ 大穴位
│  TurnStepProducer.buildTurnRequest():                   │
│   ├ intent.evaluate()       ← 意图评估，可能 veto        │
│   ├ refreshRepairHint()     ← 修复提示                    │
│   ├ advisoryBus.render()    ← A1 统一纠正信号 (≤3条/轮)   │
│   ├ refreshReliabilityDecision()  ← 可靠性降级判定        │
│   ├ enforceContextCeiling() ← 可能触发 LLM compact (30s)  │
│   ├ consumeEvents()         ← 跨会话事件同步              │
│   ├ loadPresence()          ← 同伴会话感知                │
│   ├ setSessionState()       ← 会话状态快照                │
│   ├ refreshGitContextIfNeeded()  ← ★ git 状态刷新         │
│   └ ★ buildOaiRequest()     ← 最终请求构造                │
│      (PromptEngine: frozen/volatile/appendix 三层)       │
│  action='veto' → continue | 'abort' → return            │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑩ turn-level thinking ─────────────────────────────────┐
│  工具执行轮 / plan mode → 关闭 thinking（省 reasoning）   │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑪ streamTurn ──────────────────────────────────────────┐  ★ 大穴位
│  heartbeat.disarmWatchdog()  ← 流期间解除 stall 看门狗   │
│  TurnStreamController.streamTurn():                     │
│   ├ SSE 解析 → onTextDelta / onThinkingDelta            │
│   ├ onToolUse / onToolHint                               │
│   ├ TTSR 规则匹配 → 中断+注入提醒+重试（cap=2次）        │
│   ├ 跨轮指纹去重（text + thinking）                      │
│   ├ 429 限流 → onRateLimit                              │
│   └ agent-reconnect（默认关）：相同 request 有界重连      │
│  finally: heartbeat.rearmWatchdog()                      │
│  ┌─ abort 检查（流后）─────────────────────────────────┐ │
│  │ aborted? → addUsage(估算) + runPostSession + onAbort │ │
│  │ streamError? → recordProviderOutcome(false) + onError│ │
│  └──────────────────────────────────────────────────────┘ │
│  recordProviderOutcome(true)  ← 成功才记录健康           │
│  addAssistantBlocks(collectedBlocks)  ← assistantResponded=true │
└──────────────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼ 有工具?  ▼ 无工具
```

#### 有工具分支（继续往下）：

```
         │ (toolUses.length > 0)
         ▼
┌─ ⑫ executeBatch ────────────────────────────────────────┐  ★ 大穴位
│  ToolExecutionController.executeBatch():                │
│   ├ 分组：concurrency-safe 连续块 → Promise.all 并行     │
│   │        非安全工具 → 串行                              │
│   ├ 每个工具走 executeToolUse (tool-pipeline.ts):        │
│   │   [10 层闸门链] → 执行 → [结果后处理链]               │
│   ├ enforceToolTypeBudgets / enforcePerMessageBudget     │
│   ├ enforceTurnReadBudget / enforceContextPressureTrunc  │
│   ├ Tool Storm Guard（同类工具连续调用折叠）              │
│   ├ T10 Tool Result Tiering（1M+ 窗口分级）              │
│   ├ guardLossyToolResult（损失观察保护）                  │
│   └ addToolResults()  ← 入 session                       │
│  rejectOnAbort(signal, executeBatch) 整批竞速            │
│  flushMeridianTurn()                                    │
│  endTurn? → completeTurn(isFinal:true) + break          │  (ask_user_question)
│  completeTurn(isFinal:false) + continue                 │  ← 回到 ①
└──────────────────────────────────────────────────────────┘
```

#### 无工具分支（收尾判定）：

```
         │ (toolUses.length === 0)
         ▼
┌─ ⑬ thinking-only retry ─────────────────────────────────┐
│  模型只产 reasoning 没出 text/tool? → evaluateThinkingRetry │
│  shouldRetry? → appendSystemReminder + continue         │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑭ Goal / Phantom continuation ─────────────────────────┐
│  tracker.isActive()? → judgeGoalCompletion()            │
│   ├ verified → accept (deliver_task 提示)                │
│   ├ rejected → continue + 未达成项提醒                    │
│   └ inconclusive → fail-open accept                      │
│  shouldContinueGoal? → completeTurn(false) + 注入续跑 + continue │
│  else → evaluatePhantomContinuation()                   │
│   (模型描述了动作却没调用?) → auto-continue ONE 次       │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌─ ⑮ final completion ────────────────────────────────────┐
│  completeTurn(turn, isFinal:true, emitBadge:true)       │  终态
│  resetEvidence()                                        │
│  break  ← 退出 for 循环                                  │
└──────────────────────────────────────────────────────────┘
```

---

## 三、工具执行支经络（executeToolUse 内部）

⑫ 内部每个工具的完整流转，10 层闸门 + 后处理链，是「单工具安全」的全部保障：

```
executeToolUse(tu, deps, callbacks, turn)
  │
  ├─[闸门1] Cerebellar gate: 预测错误率高→强制 read-before-edit
  ├─[闸门2] PreToolUse hook: 可 block / 改 input
  ├─[修复]  RepairPipeline: ctcl净化→四骑士→语义修复
  ├─[闸门3] Reliability gate: 降级模式拦截
  ├─[闸门4] Doom-loop block: 只拦真正循环的指纹（精确+类）
  ├─[闸门5] Exploration stall: 只读不行动→阻断
  ├─[闸门6] Plan-mode gate: planning 阶段禁写
  ├─[提示]  Sensitive preflight: 编辑敏感路径前提醒
  ├─[闸门7] Approval gate: sensorium 置信度自适应审批
  │         ├ canAutoApprove (高信心+低风险)
  │         ├ bashWriteRequiresApproval (无沙箱)
  │         └ protectionMode (doom 期破坏性 git)
  ├─[闸门8] 并发写冲突 block: sessionRegistry 文件锁
  ├─[快照] Checkpoint: 首个 mutating 工具前 createCheckpoint
  ├─[追踪] fileHistory.trackEdit / recordAgentTouchedFile
  │
  ├─[执行] harness.executeTool:
  │         ├ P3 投机命中（read-only）？
  │         ├ withToolTimeout + AbortSignal.any([loop, tool])
  │         └ toolRegistry.execute(name, params)
  │
  ├─[后处理链]
  │   ├ PostToolUse hook
  │   ├ trimEnd（稳定字节序列，喂缓存）
  │   ├ LSP changeFile + diagnostics 注入
  │   ├ bash 副作用记录（worktree diff 归属本 session）
  │   ├ artifactIntercept（超长→磁盘持久化→[artifact:ID]引用）
  │   ├ truncateSuccessfulToolResult
  │   ├ turnBudget.consume（耗尽→stored ref 预览）
  │   ├ readLoop 策略信号（重复读无信息→提示换工具）
  │   ├ trace 记录 + fingerprint（精确+类）
  │   ├ P3 mistake 检测 + immune 修复学习
  │   ├ TaskLedger 归属记录（read/write/git/verification/tool_exec）
  │   ├ claim 提取 + 冲突检测 + 项目记忆写入
  │   ├ repair hint + 抗体生成（失败时）
  │   ├ evidence + import-graph 更新（impact 分析）
  │   └ prewarm 失效（写后）/ batchPrewarm（grep 后）
  │
  └─→ callbacks.onToolResult(...)
```

---

## 四、四个贯穿全身的「护体经脉」

这些机制不是某个穴位，而是**贯穿整条经络的保护层**：

### 经脉 A：abort 协作（气血不滞）

所有 `await` 都包在 `rejectOnAbort(signal!, task, label)` 里。signal 一 abort，立即抛 AbortError，不等底层。这是反复在注释里强调的痛点来源——coordinator 泄漏、batch 假死、compaction 卡住。

### 经脉 B：Heartbeat 看门狗（假死强解）

- `silentMs=20s`：发 heartbeat 信号（UI 显示「still working」）
- `hardStallMs=240s`：调 `abortStalledTurn()`（不带 `_turnInterruptCount`，避免误判为用户中断）
- stream 阶段 `disarmWatchdog()` / `rearmWatchdog()`：避免长首 token 误判

### 经脉 C：前缀缓存保护（气血纯度）

`buildOaiRequest` 内部的 frozen / volatile / trailer-merge 机制保证：**同一 user message 内的 turn 2~50 共享前缀**。任何「重写历史」的动作（compact / collapse）都被推迟到**用户消息边界**。

- **frozenBase / volatileBlock 分离**：系统提示+工具定义+星域 = 冻结基座（永不变）；动态上下文 = 易变块
- **首条用户消息是 byte-0 锚点**：它的 frozen snapshot 被排除在 eviction 之外
- **trailer-merge**：volatileBlock 合并进最后一条用户消息（而非独立消息），保持消息数稳定
- **collapse 水位线**：request-time collapse 只在 fill-ratio > 0.5 时触发（重写历史 = 打破缓存）

### 经脉 D：Provider 健康反馈（自愈）

`recordProviderOutcome(ok)` 慢热快冷（success 缓慢升温，failure 4x 快速降温），degradation ratio 被 sensorium stability 和 coordinator worker 路由消费。

---

## 五、这套经络的五层作用

把一次孤立的 LLM API 调用，变成一个能自主完成多步骤编程任务、且不失控的 agent：

1. **动作闭环**：`思考→行动→观察→再思考` 的 turn 循环（agent vs 聊天机器人的根本区别）
2. **动作安全**：10 层闸门链（approval / checkpoint / 并发写冲突 / doom-loop 拦截）
3. **不卡死**：rejectOnAbort + Heartbeat 看门狗 + agent-reconnect
4. **跑得长**：runCompaction / enforceContextCeiling / artifact 持久化
5. **省时间省钱**：前缀缓存保护让同 run 内 turn 2~50 吃缓存读（~0.025元/M）而非全量重算（~3元/M，120 倍差价）。**命中缓存 = 跳过前缀 KV 重算 = 首 token 更快**——所以缓存优化不止省钱，还实打实降低 TTFT。

---

## 六、实证数据（cache-log 分析）

> 数据来源：`~/.rivet/sessions/<slug>/<id>/cache-log.jsonl`，由经络穴位 ⑪ `recordTurnCache`（loop-factory.ts）每轮写入。
> 分析日期：2026-06-26

### 6.1 三个会话命中率总览

| 会话 | 模型 | 轮数 | 平均命中 | P50 | 整体字节命中 | turn 中位间隔 |
|------|------|------|---------|-----|------------|--------------|
| 主会话A | glm-5.2 | 67 | 95.1% | 99.3% | 97.3% | 7.1s |
| 主会话B | deepseek-v4-pro | 172 | 98.1% | 99.7% | 99.0% | 4.2s |
| worker | deepseek-v4-flash | 12 | 87.6% | 87.8% | 89.4% | 4.6s |

**核心结论**：
- 主会话 B 跑 172 轮累计 30M token，**99% 走 cache-read**。这是这套经络「快」的根本证据。
- Warm-up 极快：主会话 B 第 1 轮 24%（冷启动），第 2 轮 86%，第 3 轮 98.5%。frozen/volatile/trailer-merge 几乎瞬间生效。
- worker 命中率低（87%）是**结构性代价**（短命会话 warm-up 占比大），反证主控经络的缓存保护在起作用。

### 6.2 read-ref 机制：累计省下 9.3MB 不进上下文

实现位置：`src/tools/read-file.ts:525-549`

```
模型再次 read_file 一个本会话已读且 mtime 未变的文件
  ↓ isUnchangedRepeatRead(canonical, mtime, offset, limit) == true?
  ↓ 是，且文件 > 2048 bytes（READ_REF_THRESHOLD）
返回一行引用，而非完整内容:
  "[read-ref] foo.ts 本会话已读且未变（320 行，8400 bytes）。
   完整内容在你上文的 tool_result 中——回看即可。
   需要具体区段：read_section(file_path=..., section=L{N}-L{M})"
  ↓
readRefSavedBytes += entryBytes   ← 累计省下的字节数
```

| 会话 | read-ref 次数 | 累计省字节 |
|------|-------------|-----------|
| 主会话A | 9 | 233 KB |
| 主会话B | 23 | 409 KB |
| worker | 214 | **8.7 MB** |

worker 省下 8.7MB = 读 214 个文件、平均每次省 41.9 KB。这些字节如果不省，会变成 `input_tokens` 膨胀上下文 → 每轮更慢 + 更容易触发缓存 eviction。**read-ref 既减小 input 体积，又保护前缀缓存稳定性——正循环。**

### 6.3 命中率低谷根因：100% 可解释，无异常

所有低命中轮归类：

| 低谷类型 | 出现位置 | 根因 | 是否问题 |
|---------|---------|------|---------|
| **turn 0** | 每段 run 第一轮 | 用户发新消息，必然重建前缀 | ❌ 正常 |
| **normal_growth** (diagnose) | 主会话B t12 (74.8%) | 单轮新增 14K token，超出已缓存前缀尾部 | ❌ 正常增长 |
| **worker diagnose** | worker t0/t3 | worker 短命，频繁冷启动 | ❌ worker 天性 |

**关键观察**：所有 diagnose 轮的**下一轮都立刻恢复 98%+**：
- 主会话B t12 74.8% → t13 98.9%
- worker t0 70.8% → t1 94.3% → t2 99.5%
- worker t3 76.8% → t4 98.6%

低谷是**一次性吸收新内容**，不是持续性缓存破坏。一旦新内容被 provider 缓存，后续轮次立即吃上。这正是 `cache-diagnostic.ts` 把 `< 0.8` 才标记 diagnose、`normal_growth` 归为 `info` 级的原因。

### 6.4 Provider 上报差异（数据可信度提醒）

| Provider | cacheCreate 字段 | 含义 |
|----------|-----------------|------|
| deepseek-v4-pro/flash | 每轮 > 0（如实报告） | 数据完整可信 |
| glm-5.2 | 全部 = 0（不上报） | 命中率数据缺一半，首轮「0%」实为冷启动但 cacheCreate 未记录 |

评估 glm 真实缓存表现，应用 deepseek 日志作参照。

---

## 七、定位指南（排查入口）

| 想找的问题 | 入口 |
|-----------|------|
| 某轮为什么慢/卡 | `cache-log.jsonl` 看该轮 `hitRate` / `diagnose` / 时间间隔 |
| 工具为什么被拦 | `tool-pipeline.ts` 的 10 层闸门链（按顺序排查） |
| 缓存为什么断 | `cache-diagnostic.ts` 的 reason 分类（prefix_drift / compaction / normal_growth） |
| 上下文为什么爆 | `compact-boundary-coordinator.ts` 的压缩决策树 |
| agent 为什么不结束 | turn-orchestrator.ts ⑬⑭⑮（thinking-retry / goal / phantom continuation） |
| 中断为什么不生效 | `rejectOnAbort` 是否包住了对应 await + Heartbeat hardStallMs |

---

*文档结束。后续如经络有结构性变更（新增穴位 / 闸门 / 经脉），在此追加更新。*
