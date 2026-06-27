# 开发前边界扫描——提示词注入

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现。

**目标：** 将「运行时代码状态机边界扫描」通用方法注入共享提示词，让所有星域在写多字段组合计算代码前自动触发时序/值语义/参数边界检查。

**架构：** 只改一个文件 `src/prompt/static.ts` 的 `<rules>` 区，加一条规则。不改任何星域单独后缀。这条规则是所有星域的共享基底——天枢执行时自然触发，天权规划时自然触发，无需各自注入。

**技术栈：** TypeScript 字符串拼接，`buildSystemPrompt` 函数返回 `BASE_PROMPT`。

---

## 背景

f13b0b82 引入 `contextCalibrationRatio` 校准机制，五个表面 bug 的根因是同一个认知盲区：**把运行时代码当纯函数推理，忽略了状态机的时序和初始化语义。** 具体表现为：

- 首轮 `addUsage` 在 `prefixOverhead` 赋值前被调用 → ratio 毒化 10000x
- `ratio === 1` 被复用为「未校准」哨兵，但 ratio=1 也是合法最佳结果
- EMA α=0.7 声称「平滑」但 10000x 毒化需 19 轮恢复
- 测试 setUp 预设了 prefixOverhead 已就绪，生产首轮调用窗口从未被覆盖

已有关联产出：`.rivet/knowledge/pre-coding-checklist.md` 记录了四道扫描的详细说明。但文档是知识，提示词是行为——当前文档不会自动触发 agent 行为改变。

## 方案

在 `src/prompt/static.ts` 的 `<rules>` 区末尾（`</rules>` 前）插入一条 `<rule name="state-machine-boundary-scan">`。

这条规则编码的是**通用方法**，不是四道扫描的罗列。方法的本质是：

> 写多字段组合计算代码前，沿时间轴和值语义扫描输入空间——字段何时就绪、值何时重合、参数在极端处如何表现。

### 为什么只加一条规则而不是四道扫描

四道扫描是从一个具体缺陷族蒸馏出来的检查清单。但提示词不需要清单，需要一个**认知转向**：从「这个公式对不对」转向「这个状态机在不同时间切面上的行为是什么」。一条规则给出这个转向 + 具体操作入口（grep 字段赋值点、手推极端值、对比生产序列），agent 的行为就会改变。

### 为什么放进 static.ts 而不是星域后缀

`static.ts` 的 `BASE_PROMPT` 是**所有 agent（主 agent + worker）共享的基底提示词**。星域后缀（`systemPromptSuffix`）是叠加层，只在特定域激活时注入。边界扫描是通用编码纪律——写代码的 agent 不管在哪个域都应该触发。放进 static 而非天枢/天权后缀，语义更干净，也不会重复注入。

### 插入点

`src/prompt/static.ts` 的 `<rule name="context-update-protocol">` 之后、`</rules>` 之前。这是现有规则的最后一个 `<rule>`，新规则作为新的独立 `<rule>` 追加。

## 改动

### 文件：`src/prompt/static.ts`

**操作：** 在 `</rules>` 前插入一条 `<rule>`。

**插入位置**（锚点）：`</rules>` 之前。

**插入内容**：

```xml
  <rule name="state-machine-boundary-scan">
  运行时状态机的边界不是测试测出来的——是写代码前沿时间轴和值语义扫出来的。
  当你要写一个函数，它消费多个字段的组合、引入有状态参数（α/阈值/窗口）、或用常量值判断「是否首次」时：
  1. 画字段赋值时间线——函数调用时所有字段都就绪了吗？有字段在调用窗口可能未初始化→加 defer 守卫。
  2. grep `=== 常量` 条件分支——常量是否也是业务域合法输出？若是→用独立 boolean/nullable 标记状态。
  3. 用最坏输入手推算法一轮——与注释声称的「平滑/鲁棒」矛盾→重新选参或加 clamp。
  4. 对比生产调用的最早时序与测试 setUp 顺序——有测试未覆盖的「字段未就绪」窗口→补测试。
  这不是四道独立检查——是同一个原则的四个切面：不要假设所有字段在同一切面就绪。状态机有它自己的时间轴。
  </rule>
```

**预期认知影响**：agent 在写 `addUsage`、`updateRatio`、`computeEstimate` 这类多字段组合函数时，会先 pause 做 30 秒时序/哨兵/参数/序列扫描，而不是直接写 `ratio = apiTokens / localEstimate` 然后等测试发现。

**字符增量**：约 700 字符，约 200 tokens。对静态提示词占比 <5%，可接受。

## 验证

1. `npx tsc --noEmit` — 确保 TypeScript 编译通过（`buildSystemPrompt` 返回的字符串合法）
2. `npm exec -- tsx --test src/prompt/__tests__/static.test.ts` — 运行 static prompt 测试
3. 手工确认：检查 `BASE_PROMPT` 的 `<rules>` 区包含新规则

## 执行次序

| Step | 操作 | 验证 |
|------|------|------|
| 1 | 在 `src/prompt/static.ts` 中 `</rules>` 前插入新 `<rule>` | typecheck + static.test.ts |
| 2 | commit | N/A |

---

计划已完成并保存到 `docs/superpowers/plans/2026-06-21-pre-coding-boundary-scan-prompt-injection.md`。两种执行方式：
1. 子代理驱动（推荐）
2. 内联执行（使用 executing-plans）
选哪种方式？
