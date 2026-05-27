# 增补集：实时流式输出与跨 Turn 去重审查

> 日期：2026-05-27  
> 类型：文化文档 / 审查增补 / 能力侧写  
> 范围：`TurnStreamController` token 级流式输出、`AgentLoop` turn 级去重三态机、DeepSeek 重复 chunk 防御。  
> 状态：已完成代码审阅、增补修复与局部验证；本文记录审查结论、已落地修复与剩余后续项。

---

## 0. 一句话结论

这轮实现证明天枢已经具备“从症状进入链路、从链路拆出层级、从层级反推风险”的能力：它不再只是把文本推快，而是在实时性、模型噪声、跨 turn 叙事重复、TUI 可见性之间建立了两层防线。

但这份增补也记录一个关键提醒：**流式系统里，“当前已完全匹配上一轮”不等于“本轮已经结束”。任何中途 suppress 都可能误吞后续合法文本。**

---

## 1. 背景：为什么需要这份增补

最近的目标是把 TUI 从“stream 结束后一次性显示文本”推进到“token/delta 到达即显示”。相关提交包括：

- `5601667 feat(stream): real-time token-by-token text delta pushing`
- `d2722b9 fix(stream): non-consecutive chunk dedup + comprehensive edge-case tests`
- `69f5792 docs(reflection): planning process review for real-time stream implementation`

此前 `docs/analysis/2026-05-27-tui-stall-visibility-fix.md` 已明确区分过两个问题：

1. **可见性缺失**：模型或工具仍在工作，但 TUI 没有显示 heartbeat/waiting 状态。
2. **真实实时输出缺失**：provider text delta 被 `TurnStreamController` 缓冲到 stream 结束才推给 TUI。

这轮实现处理的是第二个问题，并且引入了一个必要的架构分层：

- 第一层：`TurnStreamController` 处理 provider/chunk 级噪声。
- 第二层：`AgentLoop` 处理 tool-use turn 之间的重复叙述。

这份增补不是替代实现计划，而是给审查者一份“如何读这次改动”的文化索引：哪些判断是成熟的，哪些地方仍要保持警觉。

---

## 2. 已确认的实现事实

### 2.1 TurnStreamController 已改为实时 delta 推送

`src/agent/turn-stream.ts` 中，provider 的 `onTextDelta` 现在会：

1. 更新内部累计文本；
2. 维护 prewarm 触发；
3. 累积 `turnDisplayBuffer` 供 fingerprint 使用；
4. 经过 chunk 重复保护后立即调用上层 `input.callbacks.onTextDelta(text)`。

这意味着 TUI 不再必须等待 stream 完整结束才能收到文本。

对应测试：

- `src/agent/__tests__/turn-stream.test.ts`：`pushes text deltas in real-time during stream`

### 2.2 chunk 级重复保护已经从 lastChunk 扩展为 recent-history

最新实现不是只跳过“连续两个完全相同且 ≥50 字符的 chunk”，而是维护最近 5 个长 chunk：

- 当前 chunk 长度 `< 50`：永远放行。
- 当前 chunk 长度 `>= 50` 且最近 5 个长 chunk 出现过：跳过 UI 推送。
- 否则加入历史并推送。

这对应 `d2722b9` 的意图：DeepSeek 的重复有时不是严格相邻，而可能隔一个 chunk 再重复。

对应测试：

- `suppresses consecutive duplicate chunks (≥50 chars)`
- `suppresses non-consecutive duplicate chunks (≥50 chars)`
- `passes through short duplicate chunks (<50 chars)`

### 2.3 fingerprint 仍保留，用于跨 turn 判断

`TurnStreamController` 仍然用完整 `turnDisplayBuffer` 计算 fingerprint：

```ts
const dedupedBuffer = stripIntraTurnRepetition(turnDisplayBuffer)
const nextFingerprint = displayTextFingerprint(dedupedBuffer)
```

这保留了原本“跨 turn 重复叙述抑制”的基础能力，只是把真正的 suppress 决策上移到了 `AgentLoop`。

对应测试：

- `computes fingerprint for cross-turn dedup`
- `propagates fingerprint across two turns for cross-turn dedup`

---

## 3. 架构上做对的地方

### 3.1 没有把实时性和去重揉成一个黑盒

这次最重要的进步不是“更快显示 token”，而是把两个问题拆开了：

| 层级 | 问题 | 所属模块 | 判断依据 |
|------|------|----------|----------|
| chunk 级 | provider 可能重复发送相同长 chunk | `TurnStreamController` | 这是流传输噪声，离 provider 最近 |
| turn 级 | tool-use 循环中模型重复上一轮叙述 | `AgentLoop` | 这是 agent 迭代语义，需要知道上一 turn fingerprint |
| TUI 级 | 收到文本后如何渲染 | `BlockStreamWriter` / `StreamOutput` | 只负责展示，不承担模型语义去重 |

这个分层是健康的。它避免了把 TUI 变成语义修复层，也避免了让底层 stream client 理解 agent turn 语义。

### 3.2 代码没有预先改动 BlockStreamWriter

此前反思文档已经指出，规划阶段曾误以为需要改 `BlockStreamWriter`。实际审阅后可以确认：

- `BlockStreamWriter` 和 `StreamOutput` 已具备流式消费能力；
- 旧瓶颈在 `TurnStreamController` 把 delta 缓冲到 stream end；
- 因此这轮没有扩大改动面，是正确选择。

这反映出天枢现在的一个能力：**能从“看起来卡在 UI”回溯到真正的数据流阻塞点，而不是在可见层盲改。**

### 3.3 测试不只覆盖 happy path

新增测试覆盖了：

- 实时推送；
- 长 chunk 连续重复；
- 长 chunk 非连续重复；
- 短 chunk 重复不误杀；
- mid-stream error 前 partial text 已经送达；
- fingerprint 跨 turn 传播。

这说明本轮实现没有只证明“它能跑”，而是在证明“它面对 DeepSeek 已知异常时仍可控”。

---

## 4. 需要审查者重点看的风险

### 4.1 关键风险：跨 turn suppress 不能在 stream 中途定案

当前 `AgentLoop` 三态机的目标是：如果本 turn 文本完全重复上一 turn 的 fingerprint，则抑制本 turn 文本，避免 tool-use 循环中反复出现同一句“我发现了 N 个问题……”。

这个目标正确，但流式语义里有一个陷阱：

> 当前累计文本等于上一 turn fingerprint，只能说明“到目前为止相同”，不能说明“本 turn 最终只有这些文本”。

危险示例：

```text
上一 turn fingerprint：
我来检查这个文件。

当前 turn delta 1：
我来检查这个文件。

当前 turn delta 2：
接下来继续分析第二个问题。
```

如果在 delta 1 到达时立即进入 `suppressed`，delta 2 就可能被吞掉。用户最终看不到新增内容。

因此，审查建议是：

- streaming 过程中可以判断“是否仍是上一 fingerprint 的 prefix”；
- 一旦偏离，应立即 flush pending 并进入直通；
- 但“完全相等”不应在中途直接进入最终 suppress；
- 只有 stream end 时最终 fingerprint 仍等于上一 turn fingerprint，才可丢弃整段 pending。

这条原则可命名为：

> **流式去重终局原则：只在边界判死刑，不在半句中宣判。**

### 4.2 recent-history chunk 去重比“连续重复”更激进

当前第一层实现会抑制最近 5 个长 chunk 内的重复，不只是连续重复。

这可能是合理的，因为 DeepSeek 的重复 chunk 不一定严格相邻；但它也扩大了误杀面。例如：

- 合法重复的长表格行；
- 重复引用同一长路径或日志片段；
- 文档生成中故意重复的章节模板；
- 代码解释中重复展示同一长代码块。

审查建议：

1. 如果产品目标只是防“连续 chunk 级抖动”，应收窄为 lastChunk。
2. 如果确认要防“近邻重复”，应把注释与文档统一成 recent-history dedup。
3. 可以考虑只对 provider 已知异常模型启用 recent-history 策略，或把 history 大小配置化。

### 4.3 UI 去重与 session history 可能不一致

当前 chunk 重复被跳过的是 UI 推送，但重复文本仍可能进入：

- `streamedText`；
- `turnDisplayBuffer`；
- provider 最终 `ContentBlock`；
- session assistant message。

这意味着用户看到的文本可能已经去重，但后续模型上下文中仍保留重复内容。

这不一定是立刻要修的 bug，但审查者应明确它的边界：

- 如果目标是“只改善用户视觉体验”，当前策略可以接受；
- 如果目标是“消除模型上下文污染”，还需要对 assistant block/session history 做一致性处理。

---

## 5. 建议补充的测试

### 5.1 prefix-then-new-content 不能被吞

这是最高优先级测试。

场景：

```text
turn 1 输出：A
turn 2 先输出：A
turn 2 继续输出：B
```

期望：turn 2 的 `B` 必须显示，不能因为开头等于上一轮 fingerprint 而整段 suppress。

### 5.2 当前 turn 是上一 fingerprint 的短前缀时，stream end 要 flush

场景：

```text
上一 fingerprint：abcdefg
当前 turn：abc
```

期望：当前 turn 结束时输出 `abc`。

这能保护“tracking 到结尾仍未偏离”的分支。

### 5.3 明确 UI 与 session history 的一致性预期

场景：

```text
onTextDelta(longA)
onTextDelta(longA)
onContentBlock({ type: 'text', text: longA + longA })
```

需要明确断言：

- UI 是否只显示一次？
- session assistant content 是否也只保留一次？
- 如果不一致，是否在测试名中显式承认这是当前边界？

---

## 6. 这件事侧面反映的天枢能力

这次审阅不是一次普通代码 review，它暴露了天枢当前能力栈的几个变化。

### 6.1 从症状定位到链路

用户看到的是“卡住”或“不是实时输出”。天枢没有停在 UI 表象，而是沿链路拆解：

```text
provider delta → TurnStreamController → AgentLoop callback → BlockStreamWriter → StreamOutput
```

这说明系统已经具备链路级定位能力。

### 6.2 从单点修复转向分层防御

实时输出本可以被粗暴实现为“每个 delta 直接推”。但 DeepSeek 的重复输出、跨 turn narration 重复、TUI waiting fallback 共同说明：

- 快不等于对；
- 实时不等于无脑直通；
- 去重不应破坏流式边界。

这次实现至少开始建立“实时性 + 防噪声 + 语义边界”的三方平衡。

### 6.3 能接受外部审查并转化为方法论

`docs/analysis/2026-05-27-规划过程反思.md` 已记录规划阶段的遗漏：没有先读 `dedup.ts`，误判了 `BlockStreamWriter`，测试设计初期偏 happy path。

现在的增补继续把一次实现审阅转化为可复用原则：

- 不在半句中宣判 suppress；
- UI 去重和 history 去重要分清；
- provider 异常防御要有误杀边界；
- 先读链路，再改组件。

这就是天枢的成长方式：不是假装没有错，而是把错沉淀成下一轮更好的秤。

---

## 7. 后续决策状态

### 已落地

1. 已为 `AgentLoop` 增加 “prefix-then-new-content” 测试，覆盖当前 turn 先完整匹配上一 turn fingerprint、随后继续输出新内容的场景。
2. 已调整跨 turn 去重状态机：streaming 过程中只判断 prefix/divergence；完全重复 turn 的最终 suppress 只在 stream end 边界判定。

### 必做

3. 把 chunk dedup 注释统一为 recent-history dedup，避免文档和代码语义不一致。

### 应做

4. 明确 UI 去重与 session history 的一致性策略。
5. 若 history 也要去重，设计 `ContentBlock` 修正路径，避免只修 UI。

### 可选

6. 将 chunk dedup 策略按 provider profile 配置化。
7. 暴露 debug/telemetry 计数：本 turn suppress 了多少 chunk、是否触发跨 turn suppress。

---

## 8. 审查用摘要

如果只给审查者 1 分钟，可以读这一段：

> 本轮实时流式输出实现的分层方向正确：`TurnStreamController` 负责 provider chunk 噪声，`AgentLoop` 负责跨 tool-use turn 的重复叙述，TUI 保持展示层职责。测试已覆盖实时 delta、长 chunk 去重、短 chunk 放行、partial error 和 fingerprint 传播。审查发现的跨 turn 三态机流式边界风险已经补测并修复：当当前累计文本刚好等于上一 turn fingerprint 时，不再中途判定整 turn suppress，而是在 stream end 做最终判定；若后续 delta 包含新增内容，会 flush pending 并进入直通。此外，recent-history chunk 去重比“连续重复”更激进，仍应统一文档语义并明确 UI 去重与 session history 是否需要一致。

---

## 9. 留给未来天枢的一句话

**实时系统的敌人不是慢，而是边界模糊；审查的价值不是否定实现，而是让每个边界在出错前被看见。**
