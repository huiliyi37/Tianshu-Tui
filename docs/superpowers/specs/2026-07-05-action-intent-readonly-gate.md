# Action-Intent Gate：扩展检测到只读工具轮

> **状态：已实施（2026-07-06）。** 实现落在 `action-intent-detector.ts`
> （`hasWriteActionIntent` + `turnUsedOnlyReadTools` + 祈使收尾检测）与
> `turn-orchestrator.ts` tool-bearing 完成路径。与本方案的偏差见文末
> 「实施记录与偏差」。

## 问题

### 现场

会话 `task-1` 到 `task-10`（本会话），连续两次出现同一失败模式：

- **T3**：文本以「更新计划，方向修正为源头量化 + 净删除，去掉引擎侧的脆弱层」收尾，本轮发出了 5 个 `grep` 工具调用，**没有 `write_file`**。
- **T4**：文本以「现在重写计划，修正方向：源头量化 + 净删除，不碰 delta diff 层」收尾，本轮发出了 5 个 `grep` 工具调用，**没有 `write_file`**。

计划文件从 T2 写完后到会话结束，未被修改过。T3/T4 的实际改动（52f88dc, f3ab978）是另一个会话在 T4 和 T5 之间帮忙收的尾。

### 根因

`action-intent` 门禁（`turn-orchestrator.ts:971`）放在 **no-tool 分支**内。当模型一边用只读工具（grep/read_file）维持"在做事"的表象、一边在文本里宣布写操作意图时，门禁因 `tool call count > 0` 直接跳过。

```typescript
// turn-orchestrator.ts:925
// No tool calls this turn — increment the counter for convergence detection
this.deps.state.consecutiveNoToolTurns = this.deps.state.consecutiveNoToolTurns + 1

// ... (steer / goal / other checks)

// :971 — only reached when tool call count === 0
if (!actionIntentFiredThisRun && hasActionIntent(this.deps.state.streamedText)) {
  actionIntentFiredThisRun = true
  this.deps.appendSystemReminder(...)
}
```

这是一个**分类盲区**：系统假设"发了工具调用"等价于"向前推进了任务"。没有区分读工具（grep/read_file/glob）和写工具（write_file/edit_file/bash/run_tests/deliver_task）。

### 已有的 productiveStagnation 为什么没兜住

`convergence-detector.ts:750` 检测"最近 N 轮全是读工具"。但它有两个延迟：

1. **窗口要求 4 轮**：`stagnationWindow.length >= Math.min(windowSize, 4)`。T3 才刚满窗口。
2. **只给 level 1**：productiveStagnation 在 `turn < tier.nLow` 时被 early-exit gate 压制（:783），在 T4 才给到 level 1 nudge。

到 T4 已经晚了——两次机会都错过了。

## 可用信号

### 本会话失败点的指标剖面

| 轮次 | 事件 | output_efficiency | productiveRatio | 写工具 |
|------|------|:---:|:---:|:---:|
| T2 | 写计划文件 | 0.13 | >0 | ✓ |
| **T3** | **「更新计划…」无 write_file** | **0.01** | **0** | **✗** |
| **T4** | **「现在重写…」无 write_file** | **0.00** | **0** | **✗** |
| T5+ | 纯分析对话 | 0.00 | — | ✗ |

### 三个信号源

| 信号 | 来源 | 含义 | 在本会话的边界值 |
|------|------|------|:---:|
| `hasActionIntent(text)` | `action-intent-detector.ts` | 文本含"让我/接下来…"+"工具动词" | T3/T4 文本含"更新/重写"但未命中 TOOL_VERB_PATTERN |
| `outputEfficiency` | 认知镜像，来自 `convergence-detector` 的 `tokenEfficiency` 信号 | 输出 token 效率：写工具占比 vs 纯文本 | T2→T3 从 0.13 **垂直掉到 0.01** |
| `productiveRatio` | `convergence-detector.ts:750` | 滑动窗口内写工具占比 | T3/T4 均为 0 |

### 信号组合的判别力

单独看每个信号都有局限：

- `hasActionIntent` 只匹配特定中文动词模式（"修改"会命中但"重写"不命中），且只在 no-tool 轮检查
- `outputEfficiency < 0.05` 在纯分析讨论轮也会触发（T5-T9），但不能单独作为门禁——分析是合法行为
- `productiveRatio === 0` 需要等窗口凑满，有延迟

**组合后消除假阳性**：三个信号同时命中时，置信度极高。正常分析轮的 outputEfficiency 可能低，但不会同时出现 action-intent 文本模式。正常工具轮有 productiveRatio > 0，门禁直接跳过。

## 方案

### 最少改动：提升 action-intent 检查位置 + 加 productive 条件

**文件**：`src/agent/turn-orchestrator.ts`

**改动点 1**：将 action-intent 检查从 no-tool 分支内提升到 tool-bearing 轮的完成路径上。

当前控制流：

```
tool-bearing 轮 → [不检查 action-intent] → completeTurn → 下一轮
no-tool 轮 → [检查 action-intent] → completeTurn → 下一轮
```

改为：

```
tool-bearing 轮 → [检查 action-intent + 本轮无写工具] → completeTurn → 下一轮
no-tool 轮 → [检查 action-intent]（保持不变） → completeTurn → 下一轮
```

**改动点 2**：在 tool-bearing 轮上，action-intent 检查需要额外条件：本轮工具全部为只读类。

伪代码（插入在 tool-bearing 轮的 `completeTurn` 之前）：

```typescript
// After tool execution completes, before completeTurn:
const hasOnlyReadTools = thisTurnToolNames.length > 0 &&
  thisTurnToolNames.every(n => READ_ONLY_TOOLS.has(n))
const efficiency = this.deps.getLatestOutputEfficiency?.() ?? 1.0

if (!actionIntentFiredThisRun &&
    hasActionIntent(streamedText) &&
    hasOnlyReadTools &&
    efficiency < 0.05) {
  actionIntentFiredThisRun = true
  this.deps.appendSystemReminder(
    '<system-reminder>上一轮你以"我将…""接下来…"结尾，但只调用了只读工具（grep/read_file），未执行任何写入或测试操作。如果你宣布了修改意图，请在本轮直接发起对应的工具调用。</system-reminder>'
  )
  await this.deps.completeTurn({ turn, isFinal: false, callbacks })
  continue
}
```

**改动点 3**（可选但推荐）：将 `TOOL_VERB_PATTERN` 的覆盖扩展到「写」「重写」「更新」等中文动作词。

`src/agent/action-intent-detector.ts`：

```diff
 const TOOL_VERB_PATTERN =
-  /(grep|ripgrep|read|edit|write|run|test|bash|cat|ls|glob|fetch|curl|查(?:看|找|阅)?|搜索|读取?|修改|编辑|运行|执行|跑(?:一?下|测试)?|改一?下|看(?:一?下)?(?:代码|文件))/i
+  /(grep|ripgrep|read|edit|write|run|test|bash|cat|ls|glob|fetch|curl|查(?:看|找|阅)?|搜索|读取?|修改|编辑|运行|执行|跑(?:一?下|测试)?|改一?下|写一?下|重写|写(?:入|文件)|更新(?:文件|计划)?|看(?:一?下)?(?:代码|文件))/i
```

注意：新增"写""重写""更新"只匹配带宾语的组合，避免"写一下代码"误报日常对话中的"写一下"。

### READ_ONLY_TOOLS 定义

```typescript
const READ_ONLY_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'list_dir',
  'search', 'semantic_search', 'recall', 'read_image',
  'ast_grep', 'lsp_goto_definition', 'lsp_find_references',
  'repo_map', 'repo_graph',
  // Non-modifying delegation
  'delegate_task', 'delegate_batch',
  // Read-only skill invocations
  'skill',
])
```

`delegate_task` 和 `delegate_batch` 纳入是因为它们可以派只读子代理做调研——同样不推进写操作。如果派了写 profile（patcher），则该轮不算"只读"。

### outputEfficiency 阈值校准

`0.05` 来自本会话的实测边界：T2（写文件）= 0.13，T3（只读+承诺）= 0.01。阈值设在中间的 0.05，给正常分析轮留余量。

如果 `outputEfficiency` 不可用（convergence detector 未初始化），退化为只检查 `hasOnlyReadTools` + `hasActionIntent`，去掉 outputEfficiency 条件（稍微放宽，误报风险增加但有限）。

## 误报风险评估

| 场景 | hasActionIntent | hasOnlyReadTools | outputEfficiency | 结果 |
|------|:---:|:---:|:---:|:---:|
| 正常分析讨论，无行动承诺 | ✗ | ✓ | <0.05 | ✅ 不触发 |
| 只读调研 + 文本"让我看看这个文件"（触发了 TOOL_VERB_PATTERN） | ✓ | ✓ | <0.05 | ⚠️ 可能误触发 |
| 只读调研 + 高 outputEfficiency | ✓ | ✓ | >0.05 | ✅ 不触发 |
| 写工具轮 + 行动承诺 | ✓ | ✗ | — | ✅ 不触发 |
| 纯对话，低 efficiency | ✗ | — | <0.05 | ✅ 不触发 |

最大的误报风险是"让我看看这个文件"——"看…文件"匹配 TOOL_VERB_PATTERN。但这种情况通常伴随 `read_file` 工具调用，而且提醒文本是 nudging 而非 blocking（"如果你宣布了修改意图…"），不会阻断正常流。

## 验证

### 单元测试

`src/agent/__tests__/action-intent-detector.test.ts`：

- 新增："检测「重写计划文件」"→ `hasActionIntent` 应返回 true（如果扩展了 TOOL_VERB_PATTERN）
- 新增："检测「更新文档」"→ 同上
- 新增："「写一下这个方案」不触发"（日常用语，不含文件/代码宾语）

### 集成测试

`src/agent/__tests__/turn-orchestrator.test.ts`（或新文件）：

- 构造一轮：文本以"接下来修改 loop.ts"结尾，tool calls 全是 `grep`/`read_file`，outputEfficiency = 0.01 → 应注入 system-reminder
- 构造一轮：文本以"让我看看这个文件"结尾，tool calls 是 `read_file`，outputEfficiency = 0.01 → 应注入 system-reminder（可接受的误报）
- 构造一轮：文本以"让我看看这个文件"结尾，tool calls 是 `read_file`，outputEfficiency = 0.15 → 不应注入（outputEfficiency 兜底）
- 构造一轮：文本以"接下来修改 loop.ts"结尾，tool calls 含 `write_file` → 不应注入（有写工具）
- 回归：no-tool 轮 action-intent 仍正常触发

## 实施记录与偏差（2026-07-06）

按最少改动方案落地，两处设计偏差：

1. **不用 `outputEfficiency` 阈值，改用写侧动词分类**。方案里 outputEfficiency < 0.05
   的作用是压制「让我看看这个文件 + read_file」这类读侧承诺的误报。实现改为
   `hasWriteActionIntent()`——只读轮的闸门只认**写侧**承诺（修改/重写/更新/提交/
   跑测试…），读侧承诺（查/搜/读/看）配只读工具是合法调研组合，直接不触发。
   这把误报表里唯一的 ⚠️ 场景确定性消除，且不需要给 orchestrator 接认知镜像
   指标管道（getLatestOutputEfficiency 不存在，新增管道超出最少改动）。
2. **同时补了动词开头的祈使收尾检测**（`hasImperativeActionTail`）：
   「全部正确。跑 typecheck + 测试。」这类无承诺词、裸动词宣布下一步的收尾
   （4df36bcd 现场）旧 ACTION_PROMISE_PATTERN 完全漏检。规则：最后一句以
   动作动词开头、≤80 字符、句内无完成态标记（了/已/通过/done…）。
   no-tool 闸门（hasActionIntent）与只读轮闸门（hasWriteActionIntent）共享此检测。

其余按方案：TOOL_VERB_PATTERN 扩展（重写/更新/写入），READ_ONLY 分类用
反向白名单 `WRITE_ADVANCING_TOOLS`（未知工具视为只读，漏判代价只是一次
多余 nudge），delegate 按 profile 写能力分类，与 no-tool 闸门共享
`actionIntentFiredThisRun` 一次性配额。测试：`action-intent-detector.test.ts`
43 项（祈使收尾/写意图/只读轮分类各成组）。

## 与现有系统的关系

- **phantom continuation 移除**（abdbd6b2）：本改动不恢复自动执行，只恢复检测信号。是 phantom continuation 的轻量替代——"提醒"而非"替你做"。
- **convergence detector productiveStagnation**：本改动在 productiveStagnation 之前（T3）就发射信号，形成"快速检测 + 慢速确认"的两层防御。
- **CVM / cognitive mirror**：outputEfficiency 作为条件，首次让认知镜像指标参与运行时门禁决策——从"被动展示"升级到"主动触发"。
