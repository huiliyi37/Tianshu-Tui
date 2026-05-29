# Spec Review Checklist

> 在从外部 spec 生成 plan 之前，逐象限检查。每项通过才能进入 Task 拆解。
> 触发时机：接收到外部 spec 或用户提供的设计方案后，writing-plans 之前。

---

## Q1: 约束提取完整性

**目标：** spec 中所有显式/隐式约束都被提取并映射到 plan 的 task 约束中。

| 步骤 | 操作 |
|------|------|
| 1.1 | grep spec 文档中的关键字：`约束` `必须` `不能` `只能` `硬` `上限` `下限` `窗口` `lookback` `最多` `最少` `前提` `退出条件` |
| 1.2 | 将每个约束逐条列出，标注出处（spec 行号或章节） |
| 1.3 | 确认每个约束在 plan 的至少一个 task 中有对应实现或显式标记为"不适用" |
| 1.4 | 特别关注 spec 中 "已知坑"/"注意"/"风险" 章节——这些是作者已知但容易在 plan 中遗漏的约束 |

**失败信号：** spec 中提到但 plan 中无对应 task 的约束 ≥ 1 条。

**本轮实例：** spec 第 3 节 "其他已知坑" 第 1 条 "lookback window 20 个 block——对话增长超 20 block 会 miss"，plan Task 3 未接住 → Q1 应标红。

---

## Q2: 协议行为完整性

**目标：** 涉及新 API / provider 时，确认 plan 代码对每个 event type / API field 的处理覆盖了完整的生命周期。

| 步骤 | 操作 |
|------|------|
| 2.1 | 列出目标 API 的所有 SSE event type（或 REST response field） |
| 2.2 | 对每个 streaming event type，确认 plan 代码处理了 `start → delta(s) → stop` 完整序列 |
| 2.3 | 特别检查：增量字段（如 `input_json_delta`）是否在 `content_block_start` 被误读为完整值 |
| 2.4 | 对每个 API field，追踪从接收 → 解析 → 回调/存储 的完整路径 |

**失败信号：** 任何 event type 的处理只有 start 没有 delta 累积，或 delta 被注释 "handled via start" 但 start 中实际无处理逻辑。

**本轮实例：** Anthropic SSE 的 `content_block_start.tool_use.input` 在流式下是空 `{}`，真实参数通过 `content_block_delta.input_json_delta.partial_json` 增量拼接。plan 代码在 `content_block_start` 直接读了 `block.input` → Q2 应标红。

---

## Q3: 字面值对齐

**目标：** spec 中的数值、枚举、TTL、threshold 与 plan 代码中的对应值严格一致。

| 步骤 | 操作 |
|------|------|
| 3.1 | 提取 spec 中所有带单位的数值：`\d+\s*(h|m|s|ms|token|block|KB|MB)` |
| 3.2 | 提取 spec 中所有枚举值：`"xxx"` 引号内的固定字符串 |
| 3.3 | 在 plan 代码中搜索对应常量/配置，逐项 diff |
| 3.4 | 特别注意默认值——spec 可能写了显式值但 plan 用了 API 默认值 |

**失败信号：** spec 数值 vs plan 数值不一致 ≥ 1 处。

**本轮实例：** spec 断点表明确写 `TTL: 1h`（BP1/BP2），plan 代码用 `{ type: 'ephemeral' }`（无 ttl 字段 = 默认 5m）→ Q3 应标红。

---

## Q4: 测试表面审计

**目标：** 每个新增/修改的源文件都有对应的测试覆盖，且测试覆盖了关键协议路径。

| 步骤 | 操作 |
|------|------|
| 4.1 | 列出 plan 中所有新增/修改的源文件 |
| 4.2 | 确认每个源文件都有对应的 `__tests__/` 测试文件 |
| 4.3 | 检查测试是否覆盖了**流式路径**（不仅是请求构建/静态转换） |
| 4.4 | 如果新代码有 SSE/stream 处理逻辑，必须有流式测试（mock ReadableStream） |

**失败信号：** 有 stream 处理代码但无 mock stream 测试。

**本轮实例：** AnthropicClient 有完整的 `processSSEStream` 方法，但测试只覆盖了 `buildRequestBody` → Q4 应标黄（流式测试缺失）。

---

## Q5: 边界条件与降级路径

**目标：** spec 中的退出条件、降级策略、边界情况在 plan 中有对应处理。

| 步骤 | 操作 |
|------|------|
| 5.1 | 提取 spec 中所有 "如果…则…"/"否则…"/"退出条件"/"降级" 段落 |
| 5.2 | 确认每个条件分支在 plan 中有对应 task 或显式标记 |
| 5.3 | 对"降级"场景，确认 plan 中有降级后的行为描述 |

**失败信号：** spec 中的条件分支在 plan 中无对应处理 ≥ 1 处。

**本轮实例：** spec 第 1 节 "退出条件"："若 Anthropic system 段无法做到完全无日期注入，断点 2 降级或合并到断点 3"。plan 验证了 system 无日期注入 → 该退出条件不触发，但审查应显式标记"已验证不触发"。

---

## 审查结论

- **全部 5Q 绿灯** → 可以进入 Task 拆解
- **Q1/Q2/Q3 任一红灯** → 阻塞，必须先修正 plan
- **Q4/Q5 黄灯** → 可进入 Task 拆解但须在 plan 的 Verification 节标注未覆盖项
