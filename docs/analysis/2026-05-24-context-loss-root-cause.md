# 上下文丢失与"反沉淀"机制根因报告

**日期**: 2026-05-24
**作者**: Claude (with banxia)
**状态**: 诊断完成，待修复决策

## 摘要

调查"为什么 MiMO/GLM 反复丢失上下文重新做诊断"以及"为什么 DeepSeek 1M 窗口下也会突然忘掉前面已完成的诊断"。结论：**这不是 token 阈值问题**。当前实现里有 **6 处独立的"反沉淀"路径**，其中至少 **3 处与 token 数完全无关**，它们叠加导致模型每隔几轮就被剥夺上下文，被迫从早期 user 消息重新推理。

最严重的发现：**消息从未被持久化到磁盘**。磁盘上的 session 文件全是 compact_start/compact_end 标记，零条真实消息。任何非 `/exit` 退出都会丢光当次会话所有内容。

## 直接证据

### 证据 1：cache-log 显示 token 远低于任何阈值

```
路径: .rivet/cache-log.jsonl
记录数: 393 条
input token 峰值: 78,663
```

按当前 `provider-profile.ts` + `constants.ts` 的策略表：

| 模型 | 窗口 | 策略档 | watch 阈值 | 78K 是否触发 |
|---|---|---|---|---|
| MiMO | 1M | aggressive | 500K (50%) | ❌ 不到零头 |
| GLM | 200K | aggressive | 100K (50%) | ❌ 78% 接近但未触发 |
| DeepSeek | 1M | cache-preserving | 720K (72%) | ❌ 不到零头 |
| Claude | 200K | balanced | 130K (65%) | ❌ 60% 接近未触发 |

**结论：观测到的"上下文丢失"不可能由 token 比例阈值（tier 1/2/3）解释。**

### 证据 2：磁盘 session 文件零真实消息

```
session-123:                          3184 行 = 1592 start + 1592 end + 0 真实消息
session-ab:                           1272 行 = 636 start + 636 end + 0 真实消息
3b0c5457-dc02-4c78-9492-d35fb96fd13d: 142 行 = 71 start + 71 end + 0 真实消息
95ce506a-86e7-4b16-908c-437f58983e61: 132 行 = 66 start + 66 end + 0 真实消息
a052b0ca-fa1e-49a1-9db1-c19beb408bb2: 108 行 = 54 start + 54 end + 0 真实消息
2537dc1c-6729-4e0c-baba-62f2388e182d: 106 行 = 53 start + 53 end + 0 真实消息
ce35539c-bc54-4210-a2d7-36216ddae601:  84 行 = 42 start + 42 end + 0 真实消息
7c503ca1-4eb4-4189-89fe-39d92a29a124:  16 行 = 8 start + 8 end + 0 真实消息
```

老版本会话（无 compact 标记）保留了完整消息（300-800 行真实数据）；**引入 compact_start/end 后的所有会话，磁盘上零条消息**。

`compact_start.messageCount` 字段在涨（1, 4, 6, 8, 10, ...），证明内存里 messages 确实在累积，**只是从未被 write 到磁盘**。

## 根因 1：消息持久化缺失（致命）

### 现象

`SessionPersist` 类提供了 `appendOaiWithChecksum` 和 `appendWithChecksum`，**但生产代码里从未调用过**。

```bash
$ grep -rn "appendOaiWithChecksum\|appendWithChecksum" src/ --include="*.ts" | grep -v __tests__
src/agent/session-persist.ts:176:  async appendOaiWithChecksum(message: OaiMessage): ...
src/agent/session-persist.ts:260:  async appendWithChecksum(message: Message): ...
# 0 个调用方
```

`agent/loop.ts` 里 `this.persist.*` 只调用了两个方法：
- `appendCompactStart(turn, messageCount)` — `loop.ts:901`
- `appendCompactEnd(turn, messageCount)` — `loop.ts:976`

唯一会真正写消息的是：
- `compactOai(messages)` — 在 `/exit` 和 `/compact` 命令里全量重写
- `appendTurnSnapshot(...)` — 写到 `*.snapshots.jsonl`，**只记录 turn/timestamp/messageCount/tokens 元数据，不含消息内容**

### 影响

- **Ctrl+C 退出 → 当次会话所有消息丢失**
- 进程崩溃 → 同上
- 网络掉线导致进程异常退出 → 同上
- **唯一保留消息的方式是用户主动键入 `/exit`**

唯一加载磁盘 session 的入口是 `/resume` 命令（`slash-commands.ts:362-389`）。chat-mode 启动**不**自动加载磁盘——所以即使有数据也只能手动 resume。

### 误导性证据

snapshots.jsonl 文件存在且每轮在写——容易让人以为消息在持久化。但实际只是个元数据计数器。

---

## 根因 2：每轮无条件 AgentDiet（严重）

### 现象

`agent/loop.ts:940-946`：

```ts
if (!compactResult.compacted) {
  // P3-B AgentDiet: 每轮无条件跑，不看 token
  const dietBefore = this.session.getMessages()
  const dietResult = this.p3.dietMessages(dietBefore as any)
  if (dietResult.removedCount > 0) {
    this.session.replaceMessages(dietResult.messages as any)
  }
  // ...
}
```

`applyAgentDiet` 没有 token 闸门。**只要主压缩没跑，每轮都跑一次**。它的判断维度只有：

1. 同一文件后续被再读 → 旧 tool_result 替换为 `[diet:redundant]`
2. 同一文件后续被 edit → 旧 tool_result 替换为 `[diet:expired]`

### 影响

模型形成的"我在哪、读了什么"的认知被**字面上每一轮都清洗一次**。78K 上下文用量下，距离任何阈值都很远，但 diet 仍在每轮主动删除"重复读过"的内容。

形成负反馈：
```
turn N:   read_file A → tool_result(完整内容)
turn N+3: 模型想回看 A → 看不到完整内容（已被 stale-round 截到 1200 字符）
turn N+3: 重新 read_file A → diet 立即把 turn N 的标为 redundant
turn N+5: 重新 read_file A → diet 又把 turn N+3 的标为 redundant
→ 上下文里堆满 [diet:redundant] 占位符，模型再也学不到东西
```

---

## 根因 3：消息数 > 6 触发 stale-round（严重）

### 现象

`compact/stale-round.ts:13-15`：

```ts
const RECENT_MESSAGES_TO_KEEP = 4
const CACHE_ANCHOR_MESSAGES = 2  // 来自 constants.ts

if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_MESSAGES_TO_KEEP) return messages
// 即：消息数 > 6 就开始裁
```

裁的方式：把"非首两条 + 非末四条"区间内所有 `role === 'tool'` 的消息 content 截到 1200 字符（`DEFAULT_STALE_PREVIEW_CHARS`）。

### 影响

打开会话 → 一个交接文档 → 读 3 个文件，消息数就到 8，**触发**。第一个文件的完整 tool_result 被截到 1200 字符。模型几轮后回看 → 信息已经不全 → 重读 → diet 标 redundant。

跟 token 用量完全无关。

---

## 根因 4：堆压力驱动强制压缩（严重）

### 现象

`agent/loop.ts:957-972`：

```ts
const heapRatio = snap
  ? snap.memory.heapUsedBytes / snap.memory.memoryLimitBytes
  : 0

if (!compactResult.compacted && heapRatio >= 0.6 && messages.length >= 10) {
  const before = this.session.getMessages()
  // virtualWindow = window × 0.3
  const virtualWindow = Math.floor((this.config.contextWindow ?? 1_000_000) * 0.3)
  const { messages: trimmed } = microCompactOai(before, virtualWindow, ...)
  if (trimmed.length < before.length || trimmed !== before) {
    this.session.replaceMessages(trimmed)
  }
}
```

触发条件是 **V8 堆使用率 ≥ 60%**——和 token 数无关。

触发后用"假装窗口只有 30%"的方式调用 `microCompactOai`。如果 estimatedTokens 超过 virtualWindow，就走第二阶段 round-removal：

`compact/micro.ts:100-110`：

```ts
for (const round of rounds) {
  if (round.startMessageIndex >= anchorEnd && round.endMessageIndex <= tier2RecentStart && round.apiInvariant === 'ok') {
    // ...
    for (let idx = round.startMessageIndex; idx < round.endMessageIndex; idx += 1) {
      removeIndexes.add(idx)  // ← 整轮删除：assistant + tool_calls + tool_result 全没了
    }
    // ...
  }
}
```

**整轮删除——包括 assistant 的诊断文本。**

### 触发概率

- 78K token 在 V8 堆里通常是 60-100MB
- 加上 claim store / stigmergy / playbook / TUI 历史 / source map 等
- Node 默认堆上限 ~1.5GB，但 TUI 进程经常更小
- 调试场景下读几个大文件就接近 60%

**这是 DeepSeek 1M 窗口下"突然忘掉诊断"的最可疑路径**：token 没到 720K (cache-preserving 档 watch 线)，但 heap 到了 60%，触发了 round-removal。

### 副作用

`virtualWindow = 1_000_000 * 0.3 = 300K`——`estimatedTokens` 用 char/4 估算，含汉字按 1.5。中文场景下估算容易偏高，加上 reasoning_content 累积，30 万估算并不难达到。

---

## 根因 5：pre-compact-handoff 摘要密度极低（中等）

### 现象

`compact/pre-compact-handoff.ts:21-61` 提取的"摘要"实际只有 4 项：

- `filesModified`（仅 edit_file/write_file 的 file_path）
- 最近 5 次 tool call 名字
- `hadFailures` 布尔
- `total_tool_calls` 计数

典型产物：

```
files_modified: [a.ts, b.ts]
recent_tools: read_file, grep, read_file, edit_file, bash
had_failures: false
total_tool_calls: 27
```

完全不包含：模型的诊断推理、读取的文件内容、grep 命中的关键行、识别出的问题、得出的结论。

### 影响

每轮 `loop.ts:909-915` 把这个摘要塞进 `setSessionState`：

```ts
const handoff = generateHandoff(this.session.getMessages() as any)
if (handoff.summary && (handoff.filesModified.length > 0 || handoff.hadFailures)) {
  this.config.promptEngine.setSessionState(
    `<pre-compact-handoff>\n${handoff.summary}\n</pre-compact-handoff>`,
  )
}
```

这意味着：即使触发了 enforceContextCeiling 走 checkpoint-resume 路径，能保留下来的"摘要"也是这 4 项元数据。**模型的所有理解归零。**

---

## 根因 6：incomplete-compact 检测的设计陷阱（潜在风险）

### 现象

`agent/session-persist.ts:320-351` 定义了 `detectIncompleteCompact`，配合 `loadRecoverableMessages` 在检测到"未完成压缩"时回滚到上一个 snapshot：

```ts
loadRecoverableMessages() {
  const hadIncompleteCompact = this.detectIncompleteCompact()
  const loaded = this.loadWithChecksum()
  const preflight = runResumePreflight(loaded)

  if (preflight.safe && !hadIncompleteCompact) {
    return { messages: preflight.messages, ... }
  }

  // 回退路径：截断到 snapshot.turn 之前
  const snapshot = this.loadLastSnapshot()
  const snapshotMessages = this.loadUpToTurn(snapshot.turn)
  // ...
}

loadUpToTurn(turn: number): Message[] {
  // ...
  if (currentTurn === turn) return messages.slice(0, i + 1)
  // ↑ 截到这条 user 消息为止——assistant 的输出全部丢弃
}
```

`compact_start` 在每轮**开始**写入（`loop.ts:901`），`compact_end` 在每轮**结束**写入（`loop.ts:976`）。中间隔了：压缩、API 调用、tool 执行……几十秒到几分钟。**任何中间的中断都会留下未关闭的 compact_start。**

### 当前是否触发

**目前 `loadRecoverableMessages` 没有任何生产代码调用方**——`/resume` 走的是 `loadOai` + `runResumePreflightOai`，绕过了这段逻辑。

### 风险

如果未来有人把 chat-mode 启动接到 `loadRecoverableMessages`（看起来是开发者意图），这就会变成致命 bug：

1. 用户 Ctrl+C 退出 → compact_start 已写、compact_end 未写
2. 重新打开 → `detectIncompleteCompact()` 返回 true
3. 走回退路径 → `loadUpToTurn(snapshot.turn)`
4. **截断到某个旧的 user 消息**，slice 包含该 user 但其后所有 assistant 输出丢弃
5. 模型只看到早期 user → 重新做诊断

设计陷阱在于：`compact_start/end` 命名暗示它包"压缩动作"，实际包了"整一轮"。把"轮中断"误判为"压缩中断"是必然的。

---

## 完整反沉淀机制清单

| # | 机制 | 触发条件 | 与 token 关系 | 影响内容 | 严重度 |
|---|---|---|---|---|---|
| 1 | **消息持久化缺失** | 任何非 `/exit` 退出 | 无关 | 整次会话所有消息 | **致命** |
| 2 | `applyAgentDiet` | 每轮无条件 | 无关 | 同文件历史 read_file 结果 | 严重 |
| 3 | `compactStaleRoundsOai` | 消息数 > 6 | 无关 | N-2 轮以前 tool_result 截到 1200 字符 | 严重 |
| 4 | `pruneStaleToolResults` | `maybeCompact` 入口 | 间接（tier ≥ 1 才进入） | 中段 tool_result 替换占位符 | 中 |
| 5 | **heap-driven 强制压缩** | V8 heap ≥ 60% | 无关 | **整轮删除（assistant 文本+ tool 全丢）** | **严重** |
| 6 | `pre-compact-handoff` | 每轮 | 无关 | 摘要密度极低，丢失所有推理 | 高 |
| 7 | `microCompactOai` 第一阶段 | tier > 0 | 有关 | tool 截断 + reasoning 截到 200 字 | 中 |
| 8 | `microCompactOai` 第二阶段 | estimateOaiTokens > window | 有关 | 整轮删除 | 严重（但难触发）|
| 9 | `enforceContextCeiling` | tokens > window × 95% | 有关 | 全替换为 `<checkpoint-resume>` 摘要 | 高（难触发）|
| 10 | `detectIncompleteCompact` 回滚 | 任何中断 + 未来某次接入 | 无关 | 截断到 user 边界 | 致命（潜在）|

## 问题归因

> 用户原话："MiMO 不可能到阈值。打开会话一个交接文档，然后查问题的过程中间就反复失败和丢失"

不是 token 阈值问题。机制 2/3 几乎在第一轮读完几个文件后就开始撕，机制 5 在 heap 上来后随时整轮砍。

> 用户原话："DeepSeek 1M 推理出了整个诊断的问题记录。但是在有两次对话中，他甚至把前面的诊断记录全都忘掉了，又根据我前文的对话内容重新做一轮诊断"

最可疑的是机制 5（heap-driven）和机制 1（持久化缺失）。如果是同一次进程内的"丢失"，机制 5 整轮删除最匹配现象——它会保留早期 anchor messages（包含 user 输入），删除中段所有 assistant 诊断输出。

如果用户中途退出再重开 → 机制 1 直接造成磁盘上零消息，看到的 user 历史只能来自 TUI 屏幕回滚或重新输入。

## 立即修复建议

按修复成本排序，从最便宜到最贵：

### Fix 1（最优先）：消息持久化

接入 `appendOaiWithChecksum`：

- `context.ts` 的 `addUserMessage` 之后调用
- `context.ts` 的 `addAssistantBlocks` 之后调用
- `replaceMessages` 之后调用 `compactOai` 全量重写（保证压缩后的状态也被持久化）

不需要新增任何机制——API 已经存在，只是没接进去。

### Fix 2：给 stale-round / agent-diet 加 token 闸门

在 `loop.ts:940` 和 `:948` 之前判断：

```ts
const tokenRatio = estimatedTokens / contextWindow
if (tokenRatio < 0.5) {
  // 跳过 diet 和 stale-round——窗口还很空，没必要"省"
}
```

`< 50%` 完全不跑——窗口空间充足时让模型沉淀理解，不要用机械规则破坏。

### Fix 3：废掉 heap-driven 强制压缩，改成内存压力提示

把 `loop.ts:957-972` 的整轮删除替换为：

- 提示：日志 warn，告诉用户 "memory pressure high, consider /compact"
- 软压：只跑 `microCompactOai` 第一阶段（截 tool 内容、reasoning），**不进第二阶段**
- 不要整轮删 assistant 输出

整轮删除 assistant 输出永远不该被一个 V8 内部信号触发。

### Fix 4：pre-compact-handoff 接入真实摘要

至少要包含：

- 最近完成的诊断/结论文本片段（从 assistant content 里抽取最近几轮非空文本）
- 最后 N 次 grep/read_file 命中的关键内容（不只是文件名）
- 当前 task state（已经有 `extractTaskState`，没用上）

### Fix 5：移除 compact_start/end 这个机制本身

现状：

- `compact_start/end` 在文件里写得到处都是，污染严重（70+ 标记 / 0 真实消息）
- `detectIncompleteCompact` 没有调用方，逻辑死代码
- 命名本身是错的（包了整轮，不只是压缩）

建议：直接删掉 start/end 标记和 `loadRecoverableMessages`、`detectIncompleteCompact`、`loadUpToTurn`。改用：

- 每条消息单独 append + checksum（Fix 1）
- crash 后用 `runResumePreflightOai` 修复 orphan tool_use
- 不需要 fuzzy checkpoint

## 长期重新设计

当前所有机制都在做"剥夺"——决定哪些信息应该被遗忘。但模型真正需要的是"沉淀"——决定哪些理解应该被结构化保存。

设计原则（待讨论）：

1. **沉淀优先于剥夺**：读完一个文件 → 立刻提取关键事实/结论到 sediment 区 → 然后才允许这个文件的字节被裁
2. **比例 + 绝对值双闸门**：MiMO 1M 不能用 50% 阈值（500K 已超有效注意力），需要"min(ratio × window, hard_cap)"
3. **token 阈值是唯一压缩入口**：废掉所有"消息数 > 6"、"heap ≥ 60%"等无关触发
4. **assistant 文本永远不被整轮删除**：assistant 推理是稀缺资产，比 tool_result 重要得多
5. **持久化是默认行为，不是用户必须主动触发的功能**

## 待讨论问题

1. Fix 1 是否需要异步 append，会不会影响 turn latency？
2. Fix 3 之后，heap 真正过载该怎么办？（建议：触发用户提示而不是默默削减）
3. sediment 区设计：放在 `sessionState` 里？单独一类消息？anchor 之后的特殊段？
4. 现存的损坏 session 文件（71 个 marker / 0 消息）是否需要清理工具？

## 相关文件

- 持久化：`src/agent/session-persist.ts`, `src/agent/loop.ts:893-980`
- 压缩：`src/compact/{micro,prune,stale-round,semantic-prune,pre-compact-handoff,agent-diet}.ts`
- 策略：`src/compact/constants.ts`, `src/api/provider-profile.ts`
- 控制：`src/agent/compaction-controller.ts`, `src/context/compact-policy.ts`
- 实测日志：`.rivet/cache-log.jsonl`, `~/.rivet/sessions/*.jsonl`
ol_calls 计数

  const summary = parts.join('\n')
  // 完全不含 assistant 文本内容
}
```

产物示例：
```
files_modified: [a.ts, b.ts]
recent_tools: read_file, grep, read_file, edit_file, bash
had_failures: false
total_tool_calls: 27
```

`loop.ts:909-915` 每轮把这个摘要塞进 `sessionState`：

```ts
const handoff = generateHandoff(this.session.getMessages() as any)
if (handoff.summary && (handoff.filesModified.length > 0 || handoff.hadFailures)) {
  this.config.promptEngine.setSessionState(
    `<pre-compact-handoff>\n${handoff.summary}\n</pre-compact-handoff>`,
  )
}
```

### 影响

设计意图是"压缩前留个能恢复状态的摘要"。但这个摘要**完全不含模型的诊断文本**——一旦真正发生压缩，模型只剩下：

- 文件路径列表（不知道每个文件做了什么）
- 工具名字列表（不知道结果）
- 失败标志（不知道失败什么）

实际效果：摘要约等于 noise。模型恢复时看到 `<pre-compact-handoff>files_modified: [a.ts]</pre-compact-handoff>`，没有任何提示前面诊断了什么、得出了什么结论，**只能从早期 user 消息重新推理**——这正是用户报告的现象。

---

## 根因 6：未完成压缩检测设计错误（潜在 bug，未触发）

### 现象

`agent/session-persist.ts:320-351` 实现了 `detectIncompleteCompact`：从后向前扫描 session 文件，如果找到 compact_start 但没找到 compact_end，判为"未完成压缩"。

`loadRecoverableMessages`（line 204-238）使用它：

```ts
const hadIncompleteCompact = this.detectIncompleteCompact()
const loaded = this.loadWithChecksum()
const preflight = runResumePreflight(loaded)

if (preflight.safe && !hadIncompleteCompact) {
  return { messages: preflight.messages, ... }
}

// ↓ 回退到 snapshot.turn
const snapshot = this.loadLastSnapshot()
const snapshotMessages = this.loadUpToTurn(snapshot.turn)
return { messages: snapshotPreflight.messages, ..., usedSnapshot: true }
```

`loadUpToTurn(turn)` 从前向后扫，找到第 `turn` 个 user 消息时 `slice(0, i + 1)` —— **截到该 user 消息为止，丢弃后续所有 assistant 输出**。

### 命名误导

- 写入位置：`loop.ts:899-902`（每轮第一件事）和 `loop.ts:974-977`（每轮最后一件事）
- 注释写的是"Fuzzy checkpoint: 记录 compact 开始/结束"
- **实际上这两个标记包了一整个 turn，不是真正的 compact 操作边界**

任何中断都会留下 unmatched compact_start。回退时 `loadUpToTurn` 截到 user 消息为止 = "保留 user 输入丢弃 assistant 输出"。

### 当前未触发

`loadRecoverableMessages` 在生产代码里**没有调用方**。`/resume` 走的是 `loadOai()`（跳过 markers 直接全量加载）。

**但**：根因 1 已经决定了"消息从未持久化"——所以即使 `loadRecoverableMessages` 被接进去，它也只能从 0 真实消息中"恢复"。这两个 bug 互相掩盖。

---

## 根因 7：provider-profile 把"无 cache"全归到 aggressive（设计层面）

### 现象

`api/provider-profile.ts` + `compact/constants.ts:54-58`：

```ts
function strategyForCacheType(cacheType, persistent) {
  if (cacheType === 'exact-prefix' && persistent) return 'cache-preserving'  // 仅 deepseek
  if (cacheType === 'none') return 'aggressive'  // ← mimo / glm / minimax / claude
  return 'balanced'
}
```

cacheType === 'none' 的 provider 全部归到 aggressive 档：watch 50% / compact 70% / reactive 84%。

### 问题

把"是否惜压"等同于"是否有 cache"，但这两件事相关度有限：

| Provider | 窗口 | cache | 有效注意力 | 当前档 | 应该 |
|---|---|---|---|---|---|
| DeepSeek 1M | 1M | 是 | 高 | cache-preserving (72%) | ✓ |
| MiMO 1M | 1M | 否 | 低 | aggressive (50%) | 应更早，因有效远小于 1M |
| GLM 200K | 200K | 否 | 中 | aggressive (50%) | 应更晚，保护稀缺窗口 |
| Claude 200K | 200K | 显式 | 高 | aggressive (50%) | 应 balanced |

### 影响

aggressive 档 watch=50% 意味着窗口刚过半就开始 tier 1 压缩。在低 token 场景下确实不会触发——但叠加根因 2/3/4，模型反正在每轮都被"削"，token 阈值是不是合理已经变得无关紧要。

不过**当 token 真的爬上来时**（比如 GLM 用了 100K），这套档位会让 GLM 比 Claude 200K 早 30K 开始压。

---

## 用户观察到的现象 → 根因映射

> "MiMO 反复失败和丢失，看起来 token 不可能到阈值"

→ **根因 2 + 3 + 4**。每轮 diet（无条件）+ 消息数>6 stale-round（无条件）+ 堆压力强制压缩（无条件）。三者叠加，跟 token 没关系。

> "DeepSeek 1M 也把诊断忘了，根据我前文重新做诊断"

→ 最可疑：**根因 4**（heap ≥ 60% 触发 round-removal，整轮删除，包括诊断 assistant）。

→ 也可能：**根因 5**（pre-compact-handoff 用零密度摘要替换 sessionState，然后某次 microCompactOai 第一阶段把 reasoning_content 截到 200 字，把 tool_result 也压了——表面诊断文本还在 assistant.content 里，但所有支撑材料没了，模型表现为"忘了"）。

> "session 之间丢失（重开/Ctrl+C 后）"

→ **根因 1**。磁盘上零真实消息，任何非 `/exit` 退出都会让会话**完全消失**。即使用 `/resume` 也加载不到任何东西。

---

## 修复优先级建议

### P0 — 必须立即修

1. **接入消息持久化**。每条 message 入库时立即 `appendOaiWithChecksum`。否则其他所有"上下文"工作都是建在沙上的。
2. **为根因 4 的 heap-driven compaction 加保护**：
   - 至少加一个最小估算 token 闸门（比如 `estimatedTokens > virtualWindow` 才允许 round-removal，否则只截 tool_result）
   - 或：heap-driven 路径**绝对不删整轮**，只允许 tool_result 截断
3. **修复根因 6 的命名/语义**：把 `appendCompactStart/End` 改名为 `appendTurnStart/End`，或者把 `detectIncompleteCompact` 删掉（它已经写死回退到 snapshot.turn，会丢 assistant 输出）

### P1 — 降低反沉淀强度

4. **根因 2**：给 `applyAgentDiet` 加 token 闸门。比如 `estimatedTokens / contextWindow < 0.3` 时跳过 diet。让模型有沉淀期。
5. **根因 3**：把 `RECENT_MESSAGES_TO_KEEP` 从 4 提到 12（保留最近 6 个完整 round），消息数 6→18 才开始截。或同样加 token 闸门。
6. **根因 5**：`generateHandoff` 增加"提取最近 N 条 assistant text 的关键句"。或者放弃这个低密度摘要，直接保留最后一条完整 assistant text。

### P2 — 设计层面

7. **根因 7**：把 cacheType 和 strategy 解耦。引入第二维度（"有效注意力范围"），让 MiMO/GLM/Claude 各自有合适的曲线。
8. **重新设计 diet/sediment 双轨**：让 diet 服务于"读完文件已沉淀关键事实"之后才允许裁，而不是替代沉淀。

---

## 附录：关键文件位置

```
src/agent/loop.ts                       # 主循环，上述大部分触发点
  :899-902    appendCompactStart（每轮开头）
  :909-915    pre-compact-handoff 注入
  :940-946    每轮无条件 AgentDiet
  :948-955    stale-round 调用
  :957-972    heap-driven 强制压缩
  :974-977    appendCompactEnd（每轮结尾）
  :1063       enforceContextCeiling

src/agent/session-persist.ts
  :176        appendOaiWithChecksum  ← 没人调用
  :260        appendWithChecksum     ← 没人调用
  :247        compactOai             ← 仅 /exit 和 /resume preflight 调
  :293-314    appendCompactStart/End
  :320-351    detectIncompleteCompact
  :373-383    loadUpToTurn

src/agent/compaction-controller.ts
  :44-105     maybeCompact（tier-based 主压缩）
  :107-138    enforceContextCeiling

src/compact/agent-diet.ts             # 每轮无条件跑
src/compact/stale-round.ts            # 消息 > 6 触发
src/compact/micro.ts                  # 第一阶段截断 + 第二阶段整轮删
src/compact/pre-compact-handoff.ts    # 零密度摘要
src/compact/prune.ts                  # maybeCompact 入口的轻量裁剪
src/compact/semantic-prune.ts         # 不在主路径上调用？需进一步确认

src/api/provider-profile.ts           # cacheType → strategy 映射
src/compact/constants.ts              # tier 阈值表
```

## 附录：cache-log 数据样本

```
路径: .rivet/cache-log.jsonl
393 条记录
input token: max=78663, p99 ≈ 78K, p50 ≈ 16-22K
cacheRead: 全 0
cacheCreate: 全 0
hitRate: 全 0.0%
```

注：cache 全 miss 是另一个问题，可能与 anchor 不稳、prompt drift、或测试 provider 不支持 cache 有关，不在本次诊断范围。
