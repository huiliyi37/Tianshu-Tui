# lossiness 字段：设计记录与未来场景

> 状态：已播种（bash.ts 设值），硬闸门（detector 基于文本标记检测），结构化消费待建。
> 文档标记：后续讨论。

## 当前状态

### 字段定义

`src/tools/types.ts` — `ToolResult.lossiness?: 'lossless' | 'truncated' | 'collapsed' | 'preview_only'`

| 值 | 含义 | 当前生产者 |
|----|------|-----------|
| `lossless` | 完整输出，无截断/折叠 | bash.ts（stdout 未超 32KB 且未被 accumulator 折叠） |
| `truncated` | 输出被裁剪（ring buffer、行数限制） | bash.ts（stdout 超 32KB） |
| `collapsed` | 输出被聚合摘要替代 | 待实现（accumulator 应覆盖为 collapsed） |
| `preview_only` | 输出是 head+tail 预览 | 待实现（read_file 大文件、grep 超 100 结果） |
| `undefined` | 向后兼容默认值，等同于 lossless | 所有未显式设置的工具 |

### 当前设值点

`src/tools/bash.ts` — 三处 `buildResult` return：
```ts
lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' : 'lossless'
```

### 当前消费路径

**无结构化消费。** `lossiness` 在 `ToolResult → ContentBlock` 转换（`tool-pipeline.ts`）处被丢弃。实际生效的防线走文本标记路径：

- **NegativeFactDetector** (`src/agent/negative-fact-detector.ts`)：检测 content 字符串中的 `[storm-collapsed]`、`[output truncated]`、`[stdout truncated]` 等标记，不读 `lossiness` 字段
- **提示词规则** (`src/prompt/static.ts`: `lossy-observation-discipline`)：模型通过自然语言理解文本标记，不依赖结构化字段

### 为什么不急着接

文本标记方案在**当前架构的约束下**是更优选择：
1. `ContentBlock` 不承载元数据，接 `lossiness` 需要改 API 类型或加 side channel
2. 文本标记已被所有防线（detector + prompt rule + 模型理解）统一消费
3. `lossiness` 字段的语义和文本标记完全同构——接了不会有**新能力**，只改变**读取方式**

`lossiness` 作为结构化锚点的价值在**未来场景**中释放，而非当前。

---

## 未来消费场景

### 第一层：统计与可观测性（近期可行）

**场景**：每个 session / turn 聚合 lossiness 分布。

```
session.aggregateLossiness() → {
  lossless: 142,
  truncated: 18,
  collapsed: 3,
  preview_only: 0,
  lossyRatio: 0.13  // (truncated + collapsed + preview_only) / total
}
```

**触发条件**：连续 N 轮 lossyRatio > 60% → 上下文压力已大到工具输出被系统性折叠。

**行动**：
- 主动触发 compact（上下文回收）
- GlanceBar 显示警告
- 通知用户 "当前上下文压力大，建议 /compact 或开启新会话"

**为什么需要结构化字段**：文本标记检测不稳定（不同工具格式不同），结构化字段一次判断。

---

### 第二层：上下文预算策略（中期）

**场景**：compact 选择保留/丢弃哪些消息时，按 lossiness 排优先级。

当前 compact 策略：按 token 数 + 时间远近一刀切。

有了 lossiness：
```
保留优先级：lossless > truncated > preview_only > collapsed
```

- `lossless` 结果优先保留（完整信息源，丢弃后不可恢复）
- `collapsed` 结果优先丢弃（本身已是摘要，二次摘要几乎无价值）
- `preview_only` 可进一步压缩（只保留 head/tail 中的关键行）

**为什么需要结构化字段**：compact 在消息层面操作，需要按条判断，不能扫描文本。

---

### 第三层：工具行为差异化（中期）

**当前**：只有 bash.ts 设了 lossiness。

**可扩展的工具**：

| 工具 | 触发条件 | lossiness |
|------|---------|-----------|
| `grep` | >100 条匹配结果 | `preview_only` |
| `read_file` | 大文件 head+tail | `preview_only` |
| `run_tests` | 输出被 per-message budget 截断 | `truncated` |
| `delegate_task` | worker 返回汇总 | 待定新值 `summarized` |
| `glob` | >500 文件 | `preview_only` |
| `semantic_search` | 结果被截断 | `preview_only` |

每个工具设 lossiness 后，detector 可以**去掉硬编码的文本标记正则**，统一用 `result.lossiness !== 'lossless'` 判断。新工具接入时只需设字段，不需要改 detector。

---

### 第四层：Eval Harness 分层评估（远期）

**场景**：自动化评估 agent 输出质量时，区分两类错误：

- **Type A**：信息完整但仍犯错 → 模型能力问题
- **Type B**：信息不完整导致犯错 → 上下文/工具链问题

通过 lossiness 过滤：
```
correctOnLossless / totalLossless   → 模型在信息完整时的准确率
correctOnLossy / totalLossy         → 模型在有损信息下的表现
```

两类错误的优化方向完全不同：Type A 换模型/prompt，Type B 优化工具链/上下文管理。

---

### 第五层：Confidence Calibration（远期）

**场景**：agent 自我感知——当信息有损时，结论置信度应该打折。

```
if (result.lossiness !== 'lossless') {
  conclusion.confidence *= 0.6  // 基于有损信息的结论置信度降低
  conclusion.caveats.push('基于不完整工具输出')
}
```

这需要 agent 架构支持"结论置信度"概念，属于远期设计方向。

---

## 连接点：要让 lossiness 真正流动起来需要做什么

当前唯一的断点是 `ToolResult → ContentBlock` 转换处。要让结构化消费生效：

**方案 A（轻量）**：在 `tool-execution.ts` 中，调用 `addToolResults` 前，用 side-channel Map 存储 lossiness，下游按 `tool_use_id` 查询。

**方案 B（彻底）**：扩展 `ContentBlock` 类型，让 tool_result 携带 `lossiness` 字段。改动面大（API 类型、序列化、worker 传输）。

**方案 C（当前）**：维持文本标记路径，等至少一个结构化消费场景有明确需求时再选方案。

推荐在当前阶段保持方案 C。第一个结构化消费场景出现时（大概率是第一层"统计与可观测性"），方案 A 足够。

---

## 与其他字段的关系

| 字段 | 作用 | 与 lossiness 的关系 |
|------|------|-------------------|
| `rawBytes` / `rawLines` | 原始输出规模 | 互补——lossiness 说"是否完整"，rawBytes 说"原始有多大" |
| `rawPath` | 完整输出落盘路径 | 互补——lossiness ≠ lossless 时，rawPath 是恢复完整输出的路径 |
| `exitCode` | 命令退出码 | 独立——exitCode 不反映输出保真度 |
| `command` | 执行的命令 | 独立——用于折叠摘要中的命令展示 |

---

## 讨论记录

- 2026-06-21：字段播种（bash.ts 设值），detector 走文本标记路径。确认当前不接结构化消费。
- 待讨论：第一个结构化消费场景的优先级和时间点。
