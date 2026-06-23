# Phantom Continuation 优化方案

## 现状

### 文件

- **决策函数**: `src/agent/phantom-continuation.ts`
- **调用方**: `src/agent/turn-orchestrator.ts:774-792`
- **注入**: `this.deps.appendSystemReminder(phantom.message)` → 下一轮作为 `<system-reminder>` 注入

### 触发条件

Agent 一轮结束时 **没有 tool call**（`consecutiveNoToolTurns` 递增），进入 phantom continuation 检测。

`evaluatePhantomContinuation()` 两层判断：

**Layer 1 — task-contract 信号（最可靠）**:
- 条件: `activeContract.isActionable && status !== 'ready_to_deliver' && status !== 'blocked'`
- 只要 contract 存在且状态是 `in_progress`/`exploring`，**直接判定需要继续**，不看文本内容

**Layer 2 — action-intent 启发式（fallback）**:
- 条件: `!isSocialOrTrivial(text)` + 文本尾部同时匹配 `ACTION_PROMISE_PATTERN`（让我/接下来/I'll）和 `TOOL_VERB_PATTERN`（grep/read/edit/run）
- 两者同时匹配才触发

判定 `shouldContinue` 时，注入 `[CONTINUATION]` 提示消息，`continue` 再跑一轮。

### 硬闸门（不会误触发的情况）

- `maxAutoContinue <= 0` → 功能关闭
- `autoContinueCount >= maxAutoContinue` → 预算耗尽
- `convergenceEscalated` → doom-loop 已介入
- `text.length === 0` → 空回合

## 问题

**Layer 1 不检查回合性质。** 纯对话回合（用户问"有什么区别""查一下浏览器""为什么一直说无待办"）的正确行为是直接回答，不需要 tool call。但 contract 可能仍处于 `in_progress` 状态，Layer 1 直接判定 shouldContinue，导致：

1. Agent 回答完用户问题后被强制再跑一轮
2. 下一轮 Agent 只能说"已回答完毕"之类的话
3. 又触发一轮 phantom continuation（直到预算耗尽）
4. 用户看到每条回答后面都跟一条多余的续接消息

Layer 2 有正确的防护——要求 action promise + tool verb 同时存在。但 Layer 1 绕过了这个检查。

## 根因分析

问题的直接原因是 Layer 1 不看回合性质，但更深一层的根因在 **contract 状态机未及时收束**。

contract 从 `executing` 推进到 `ready_to_deliver` 的唯一触发路径是 `contractStatusFromPhaseClass('deliver')`，这依赖 agent 在回合中触发 deliver phase classification。当用户插入一个纯问答回合（"有什么区别""为什么一直说无待办"）时：

1. agent 进入问答模式，正确回答用户问题
2. 该回合未触发 deliver phase —— 因为 agent 没有"交付任务"的意图
3. contract 滞留在 `executing` / `exploring`
4. Layer 1 看到 contract 仍开放 → 误触发 phantom continuation

理想状态下，contract 状态机应有能力识别"本回合是纯信息查询而非任务推进"并维持（而非推进）contract 状态。这属于 contract 层面的改进，不在当前修复范围内，但标注于此作为长期治本方向。当前修复（方案 A）是治标——让 phantom continuation 的门控更严，不依赖 contract 状态的单一信号。

## 修复方案

### 方案 A: Layer 1 加 action-intent 附加条件（推荐）

在 Layer 1 的 contract 检查后，追加 Layer 2 的文本启发式作为必要条件。即：contract 开放 **且** 文本包含行动承诺+工具动词，才触发。

```typescript
// Layer 1: task-contract signal + action-intent gate
if (
  activeContract &&
  activeContract.isActionable &&
  activeContract.status !== 'ready_to_deliver' &&
  activeContract.status !== 'blocked'
) {
  // 即使 contract 开放，如果这轮回合的文本不包含行动意图，
  // 说明 agent 在回答用户问题而非执行任务——不触发续接
  const tail = text.length > 600 ? text.slice(-600) : text
  if (ACTION_PROMISE_PATTERN.test(tail) && TOOL_VERB_PATTERN.test(tail)) {
    return { shouldContinue: true, reason: 'contract-open', message: CONTINUE_HINT }
  }
}
```

**效果**: 纯问答回合（无行动承诺/工具动词）即使在 contract 开放期间也不会被误触发。

**风险**: 如果 agent 真的在执行任务但用了一种不含行动承诺的表达方式（如直接列出计划），可能漏触发。但实际场景中，真正的执行回合几乎必然包含"我要做 X"的表达——双模式同时匹配的概率极高。且漏触发（false negative）的代价远小于误触发（false positive）：前者只需用户手动 nudge 一次，后者浪费 token 并产生 UI 噪音。另外注意：方案 A 之后 Layer 1 和 Layer 2 使用完全相同的双模式门控——如果 Layer 1 因模式不匹配而未触发，Layer 2 走到同样的判断也会得出同样结论。不存在"Layer 2 兜底捕获"的机制，这里的取舍是：**宁可漏触发也不误触发**。

### 方案 B: Layer 1 检查 user message 性质

检查当前 user message 是否是查询/讨论类（疑问句、查询词），如果是则跳过。

**不推荐**: 需要访问 user message 内容（当前函数签名没有这个输入），增加耦合度，且自然语言分类不可靠。

### 方案 C: 连续两轮无 tool call 才触发

把阈值从 1 改成 2——连续两轮无 tool call 才触发 phantom continuation。

**不推荐**: 延迟了正确的续接，且不解决根因。

## 推荐方案 A 的具体改动

文件: `src/agent/phantom-continuation.ts`

将 Layer 1 块改为：
```typescript
if (
  activeContract &&
  activeContract.isActionable &&
  activeContract.status !== 'ready_to_deliver' &&
  activeContract.status !== 'blocked'
) {
  const tail = text.length > 600 ? text.slice(-600) : text
  if (ACTION_PROMISE_PATTERN.test(tail) && TOOL_VERB_PATTERN.test(tail)) {
    return { shouldContinue: true, reason: 'contract-open', message: CONTINUE_HINT }
  }
}
```

Layer 2 保持不变（已经是对的条件）。

**设计说明**:

- **tail slicing**: 当前 Layer 1 完全不看文本内容，方案 A 引入 `text.length > 600 ? text.slice(-600) : text` 以与 Layer 2 保持一致——行动承诺总是在文本尾部。这是一个行为变化，但对性能无影响（600 字符的正则匹配可忽略不计）。
- **isSocialOrTrivial 的缺位**: Layer 2 有 `if (!isSocialOrTrivial(text))` 前置检查，方案 A 的 Layer 1 路径没有。这不构成问题：社交/琐碎文本（"好的，谢谢""了解了"）不可能同时匹配 ACTION_PROMISE_PATTERN 和 TOOL_VERB_PATTERN，双模式匹配本身就是比 isSocialOrTrivial 更强的过滤。显式调用反成冗余。

### 测试

新增测试用例：
1. contract 开放 + 纯回答文本（无行动承诺）→ shouldContinue=false
2. contract 开放 + 行动承诺+工具动词 → shouldContinue=true（reason='contract-open'）
3. contract 开放 + 行动承诺但无工具动词 → shouldContinue=false
4. contract 开放 + 工具动词但无行动承诺 → shouldContinue=false（如 `"需要修改 src/tools/bash.ts"`，"需要"不在 ACTION_PROMISE_PATTERN 中，"修改"在 TOOL_VERB_PATTERN 中——仅一边匹配不触发）

### 认知影响

此修改影响 agent 自身的循环行为。修改后：
- 纯对话回合不再被误续接，减少 token 浪费和用户体验噪音
- 真正的任务执行回合（有行动意图）不受影响
- phantom continuation 的触发率会下降，但只在应该下降的时候下降
