# 缓存断裂：模型卡住 → 下一轮碎缓存

> 蒸馏自 session `ee3e768b` 的 cache-log.jsonl 排查。
> **已修复（2026-06-18）**：通过 `appendSystemReminder` 机制，SR 注入不再新增消息数组条目。

## 现象

session `ee3e768b-c746-47bf-aa45-2a8a71110ef5` 的 cache-log 第 137 行：

```
turn=46, input=251896, cacheRead=178432, cacheCreate=73464, hitRate=70.8%
userMsgs: 7→9, injected: 1→3
```

前一行（turn 45）命中 99.9%。一行之内 73K token（~29%）缓存失效。

## 根因

`prompt/engine.ts` 的 `buildOaiRequest` 把 system-reminder（注入块）放在消息数组**最前面**：

```
[system-reminder-1]  ← 数组头部
[system-reminder-2]
[system-reminder-3]
[volatile-block + user-msg-1]
[volatile-block + user-msg-2]
...
```

DeepSeek 前缀缓存是字节级严格匹配。数组头部新增一个 system-reminder，后面所有消息的字节位置全部偏移 → 即使语义完全相同，也变成 cacheCreate 重写。

触发路径：模型卡住 → 用户发新消息（如"继续"）→ `addUserMessage` 追加用户消息 → 下一轮 `buildOaiRequest` 重新组装 volatile block → system-reminder 数量或内容变化 → 头部插入 → 全数组字节偏移 → 缓存断裂。

## 定位方法

```bash
# 找到 userMsgs 或 injected 跳变的行
grep -n 'userMsgs' .rivet/sessions/<id>/cache-log.jsonl | less

# 对比跳变前后的 cacheRead/cacheCreate
# userMsgs 从 N→N+1 通常伴随 ~10K cacheCreate（正常冷启动）
# userMsgs 从 N→N+2 且 injected 也跳 → 头部插入断裂（>50K cacheCreate）
```

## 解决方向

把 system-reminder 从数组头部移到尾部（最后一个用户消息之后、assistant 消息之前）。新增 system-reminder 只影响数组末尾，前缀缓存完全不受影响。

改 `buildOaiRequest` 中 pass-through system-reminder 的位置：当前在循环开头直接 push → 改为收集后统一 append 到最后一个 user message 之后。

## 当前状态

此 session 的 178 次缓存事件中 161 次（90.4%）命中 95%+。3 次 <80% 均为正常冷启动（turn=0 首轮）。行 137 是唯一一次内部断裂（turn=46, 70.8%），属于上述卡住→发消息→碎缓存的典型模式。无系统性缓存问题。

## SR 注入源清单与重叠分析（2026-06-18 审计）

### 所有 SR 注入来源（11 个）

#### 一、「模型卡住」类 — 严重重叠

| # | 来源 | 触发条件 | 注入内容 | 价值 |
|---|------|----------|----------|------|
| 1 | convergence kick `loop.ts:1017` | convergence score 低 / tool 重复 / no-tool 停滞 | 天璇-感知 + 具体信号诊断（editRatio/toolEntropy/oscillationPenalty） | **高**：信号分析是诊断性的，模型自己看不到这些指标 |
| 2 | doom loop gate hint `loop.ts:1030` | convergence level≥2 且 doomLoopLevel==='blocked' | "任务验证循环已检测到。如果门禁 GREEN，请结束回合" | **与 #1 矛盾**：#1 说"换方向继续"，#2 说"该停了" |
| 3 | kick-hook `hooks/kick-hook.ts:44` | shouldKick(sensorium): momentum<0.2 && stability<0.3 | dissipative kick + 替代框架建议 | **与 #1 完全重叠**：检测同一种卡住状态，只提供泛泛建议，无信号诊断。signal-consumer 已对 kick-hook 做了互斥，但 convergence 没有 |
| 4 | signal-consumer dead-end `hooks/signal-consumer-hook.ts:91` | 信息素有 dead-end 信号且路径匹配 | dead-end 规则（"这些路径已验证不可行"） | **独立**：提供历史 dead-end 信息。已有 kick 互斥。advisoryBus 可用时不走 SR |
| 5 | dedup-guard `hooks/dedup-guard-hook.ts:88` | 连续两轮回复 trigram 重叠≥60% | 天璇-感知：重复输出检测 | **与 #1 部分重叠**：convergence 也检测 textRepetitionPenalty。但 dedup-guard 更精准（直接对比文本）。advisoryBus 可用时不走 SR |

**核心问题**：#1 + #2 + #3 在同一条件下同时触发，注入 3 条方向矛盾或内容重复的 SR。

**信号最完整的是 #1（convergence kick）**。#3（kick-hook）最冗余——内容和 #1 高度重叠，且没有 #1 的信号诊断能力。

#### 二、「风险/验证」类 — 无重叠

| # | 来源 | 触发条件 | 注入内容 | 价值 |
|---|------|----------|----------|------|
| 6 | courage-hook `hooks/courage-hook.ts:97` | toolHistory 失败率≥50% 或 sycophancy trap 连续投降 | `<天权-感知 type="risk">` 风险评估 / 宪法级验证义务 | **独立**：每轮强制风险评估。有独立价值 |

#### 三、「探索引导」类 — 低重叠，低频

| # | 来源 | 触发条件 | 注入内容 | 价值 |
|---|------|----------|----------|------|
| 7 | blind-exploration `hooks/blind-exploration-hook.ts:25` | turn===1（仅第一轮） | 破军-探索：广泛探索问题空间 | **独立**：只在第一轮 |
| 8 | mcts-planning `hooks/mcts-planning-hook.ts:57` | turn===1 seed model 调用成功 | MCTS 种子路径建议 | **与 #7 部分重叠**：都是第一轮探索引导。但 mcts 提供具体路径，#7 只提供态度 |
| 9 | signal-consumer breadth `hooks/signal-consumer-hook.ts:35` | explorationBreadth>0.6 | `<search-breadth mode="wide" />` | **独立**：策略信号 |
| 10 | signal-consumer decomposition `hooks/signal-consumer-hook.ts:47` | pressure.suggestion==='task_decomposition' | 天梁-感知：建议拆分 | **独立**：压力信号 |

#### 四、非 hook 类

| # | 来源 | 触发条件 | 注入内容 | 价值 |
|---|------|----------|----------|------|
| 11 | thinking-retry `turn-orchestrator.ts:695` | 推理失败需要重试 | retry 提示 | **独立**：只在推理错误时触发 |

### 精简建议

1. **合并 #1/#2/#3**：convergence level≥2 时只注入一条合并消息（信号诊断 + 方向建议 + 门禁状态）。kick-hook 在 convergence 触发时抑制。
2. **#4/#5 完全迁移到 advisoryBus**：不再走 SR 注入。
3. **#7/#8 可合并**：第一轮只注入一条探索引导。

## 修复（2026-06-18）

**机制**：`SessionContext.appendSystemReminder(text)` 方法。convergence/hook/thinking-retry 注入不再调用 `addUserMessage(wrapSystemReminder(...))` 创建新消息条目，而是将 SR 内容追加到最后一条 user 消息的 content 末尾。

**效果**：消息数组长度不变 → prefix cache 边界不移动 → SR 注入零缓存代价。

**改动文件**：
- `src/agent/context.ts` — 新增 `appendSystemReminder` 方法
- `src/agent/loop.ts` — 4 个调用点改为 `appendSystemReminder`
- `src/agent/loop-factory.ts` — `addSystemReminder` callback + TurnOrchestratorDeps
- `src/agent/turn-orchestrator.ts` — thinking-retry 调用点 + 接口新增 `appendSystemReminder`

**测试**：`src/agent/__tests__/context-sr-append.test.ts`（6 tests）+ `src/prompt/__tests__/engine-cache-stability.test.ts`（2 SR-specific tests）
