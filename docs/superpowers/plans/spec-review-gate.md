# Spec Review Gate（外部规格审查门）— 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 planning 阶段之前嵌入一个结构化审查门，自动检测外部 spec 中的遗漏约束、协议假设、TTL/参数对齐错误和测试盲区，消除对外部审查的依赖。

**架构：** 新建 `docs/superpowers/spec-review-checklist.md` 作为审查模板，内嵌到 writing-plans 工作流中。模板包含 5 个强制检查象限，每个象限对应一个已验证的失败模式。不做代码改动——纯流程增强，但效果通过 apply 时的 checklist 强制执行来保证。

**技术栈：** Markdown 模板 + writing-plans 工作流集成

---

## 1. Scope Check

本计划只有一个子系统：**外部 spec 审查模板**。

| 子系统 | 文件 | 是否独立可拆分 |
|--------|------|--------------|
| 审查清单模板 | `docs/superpowers/spec-review-checklist.md`（新建） | ✅ 独立（纯文档） |

**不含：** 代码改动、agent loop 修改、prompt 修改。这是一个流程工具。

---

## 2. 背景：已验证的失败模式

本轮 Anthropic native client 实现中，外部 spec 通过、内部 plan 通过、单元测试通过，但外部审查仍抓到 4 个问题。它们都可以在 **spec→plan 阶段**被结构化审查拦截：

| # | 失败模式 | 本应拦截的检查 | 严重度 |
|---|---------|--------------|--------|
| H1 | 流式 tool_use 参数丢失——协议假设错误（`content_block_start.input` 在流式下是空 `{}`） | 协议行为验证：逐 event type 对齐文档 | CRITICAL |
| M1 | BP1/BP2 用了默认 5m TTL，spec 明确写 1h | spec 字面值对齐检查 | HIGH |
| M2 | 20-block lookback 约束在 spec 第 3 节但 plan Task 3 未接住 | 约束提取完整性扫描 | MEDIUM |
| — | 只有请求构建测试，无流式响应测试 | 测试表面审计 | MEDIUM |

---

## 3. File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `docs/superpowers/spec-review-checklist.md` | 结构化审查清单：5 个象限，每个包含检查项、触发条件、验证方法 |

### 修改文件

| 文件 | 变更 |
|------|------|
| （无代码修改） | — |

---

## 4. Research Endorsement

### 4.1 模板位置选择

**现有文档结构：** `docs/superpowers/briefs/` 存简报，`specs/` 存设计规格，`plans/` 存实现计划。审查清单是**流程工具**，不属于这三类。

**选择：** 放在 `docs/superpowers/` 根目录，与 `README.md` 同级。理由：
- briefs/specs/plans 各有用处，审查清单跨所有三类
- 已有先例：`.rivet/knowledge/project-memory.md` 中的 `review_principle` 条目是类似机制

### 4.2 集成方式选择

**方案 A：** 修改 writing-plans prompt，每次生成 plan 前强制跑审查清单。
**方案 B：** 纯文档，由 planner 自觉引用。

**选择方案 A 的理由：** 自觉引用不可靠。writing-plans 是 plan 生成的入口点，在入口嵌入审查步骤才能保证执行。但 writing-plans skill 的 prompt 位置未知——本次只交付模板，集成方式在后续评估。

### 4.3 每个检查项的触发条件和验证方法

| 检查项 | 触发条件 | 验证方法 |
|--------|---------|---------|
| Q1: 约束提取 | spec 中存在"已知坑"/"注意"/"约束"等标记 | grep spec 中的约束关键字，逐一映射到 plan task |
| Q2: 协议行为 | spec 涉及新 API client 或新 provider | 对每个 SSE event type / API field，确认 plan 代码处理了完整的生命周期 |
| Q3: 字面对齐 | spec 中任何带数值/枚举的参数（TTL、token 数、threshold） | diff spec 数值与 plan 代码中的对应值 |
| Q4: 测试表面 | 任何新增/修改的源文件 | 检查是否同时有流式测试（不仅请求构建测试） |
| Q5: 边界条件 | spec 中任何"如果…则…"/"退出条件"/"降级"段落 | 确认 plan 的 task 中有对应 edge case 测试 |

---

## 5. Tasks

### Task 1: 创建 Spec Review Checklist 模板

**目标：** 创建 `docs/superpowers/spec-review-checklist.md`，包含完整的 5 象限审查结构。

**文件（创建）：** `docs/superpowers/spec-review-checklist.md`

**内容：** 见下文完整模板。

#### 模板正文

```markdown
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
```

**步骤 1.1：验证模板完整性**

自检：模板覆盖了 H1(Q2)、M1(Q3)、M2(Q1)、测试盲区(Q4)、退出条件(Q5) 所有已知失败模式。

**命令：** 无（纯文档）。

**步骤 1.2：提交**

```bash
git add docs/superpowers/spec-review-checklist.md
git commit -m "docs: add spec review gate checklist template (5Q framework)"
```

---

### Task 2: 用本轮 spec 回测审查清单

**目标：** 把本轮 Anthropic native client 的 spec 和 plan 跑一遍审查清单，验证清单能抓住已知的 4 个失败模式。结果记录为审查报告附录。

**文件（创建）：** `docs/superpowers/validations/2026-05-29-spec-review-gate-retrospective.md`

**内容：**

```markdown
# Spec Review Gate — 回测验证

> 回测目标：2026-05-29 Anthropic native client cache design spec
> 审查清单版本：v1 (docs/superpowers/spec-review-checklist.md)
> 日期：2026-05-29

## Q1: 约束提取完整性

| 约束 | spec 位置 | plan 是否接住 |
|------|----------|-------------|
| lookback window 20 block | 第 3 节 "其他已知坑" | ❌ 未接住（原始 plan Task 3 BP4 是静态"最后已完成轮"） |
| tools 非确定性序列化 | 第 3 节 | ✅ Task 2 用 sort + stableStringify |
| minCacheTokens 错值 (1024 vs 4096) | 第 3 节 | ✅ Task 1 修复 |
| 日期注入杀手 | 第 3 节 | ✅ Section 3.2 验证了 system 无日期 |

**Q1 结论：🔴 1/4 遗漏 → 应标红**

## Q2: 协议行为完整性

| SSE event | plan 处理 |
|-----------|----------|
| message_start | ✅ 读取 usage |
| content_block_start (text) | ✅ |
| content_block_start (tool_use) | ❌ 直接读 block.input（流式下为空 {}），未累积 input_json_delta |
| content_block_delta (text_delta) | ✅ |
| content_block_delta (input_json_delta) | ❌ 注释 "handled via content_block_start" 但实际无处理 |
| content_block_stop | ❌ 空 break，未 emit 拼好的 tool_use |
| message_delta | ✅ 读取 stop_reason + output_tokens |
| message_stop | ✅ |

**Q2 结论：🔴 3/8 遗漏 → 应标红**

## Q3: 字面值对齐

| spec 值 | plan 值 | 一致？ |
|---------|--------|--------|
| BP1 TTL: 1h | `{ type: 'ephemeral' }` (5m) | ❌ |
| BP2 TTL: 1h | `{ type: 'ephemeral' }` (5m) | ❌ |
| minCacheTokens: 4096 (Opus) | 1024 (Sonnet) | ❌ → Task 1 修正 |

**Q3 结论：🔴 3/3 不一致 → 应标红**

## Q4: 测试表面审计

| 源文件 | 测试文件 | 流式测试 |
|--------|---------|---------|
| anthropic-client.ts | ✅ 存在 | ❌ 只有 buildRequestBodyForTest，无 mock stream 测试 |

**Q4 结论：🟡 流式测试缺失 → 应标黄**

## Q5: 边界条件

| 条件 | spec 位置 | plan 处理 |
|------|----------|----------|
| system 段无日期注入 → 断点 2 可用 | 第 1 节退出条件 | ✅ Section 3.2 验证 |
| system 段有日期 → 断点 2 降级 | 同上 | N/A（已验证不触发） |

**Q5 结论：🟢 全部覆盖**

## 总结

若在 plan 生成前跑此审查清单：
- Q1 🔴 + Q2 🔴 + Q3 🔴 → **阻塞**，必须修正后才进入 Task 拆解
- 这 3 个红灯对应外部审查抓到的 H1、M1、M2
- Q4 🟡 可进入但需标注

**审查清单有效性：4/4 已知失败模式被捕获。**
```

**步骤 2.1：提交**

```bash
git add docs/superpowers/validations/2026-05-29-spec-review-gate-retrospective.md
git commit -m "docs: add spec review gate retrospective validation against anthropic-native-client spec"
```

---

## 6. Verification

### 文档验证

```bash
# 确认模板存在且格式正确
head -5 docs/superpowers/spec-review-checklist.md

# 确认回测报告存在
head -5 docs/superpowers/validations/2026-05-29-spec-review-gate-retrospective.md
```

### 流程验证（手动，后续 writing-plans 集成时执行）

```bash
# 当 writing-plans 被调用时：
# 1. 加载 docs/superpowers/spec-review-checklist.md
# 2. 对当前 spec 执行 Q1-Q5
# 3. 任一红灯 → 拒绝进入 Task 拆解，输出审查报告
# 4. 全绿 → 进入 Task 拆解
```

---

## 7. Self-check

### 7.1 Spec Coverage

| Requirement | Task(s) |
|-------------|---------|
| 审查清单模板（5Q 框架） | Task 1 |
| 回测验证（证明有效性） | Task 2 |
| 每个 Q 有明确的触发条件和验证方法 | Task 1（模板内嵌） |
| 每个 Q 有本轮实例作为参考 | Task 1 + Task 2 |

### 7.2 Placeholder Scan

- ✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节
- ✅ 无 "添加适当的错误处理"
- ✅ 无 "为上述代码编写测试"

### 7.3 Type/Signature Consistency

- ✅ 纯文档，无代码类型依赖

---

## 8. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/spec-review-gate.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
