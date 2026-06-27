# 经验蒸馏闭环 — 设计文档

> 核心：经验从机制捕获的修复中来，不从自我反思中来。

## 0. 诊断：为什么旧 playbook 系统是空的

旧系统设计了一条完整链路：会话结束 → retrospect 报告 → 提取教训 → 存 playbook.jsonl → 注入下个会话。

但 `.rivet/playbook.jsonl` 至今 0 行。原因：

1. **触发条件太窄**：`shouldReflect()` 要求 vigor.variability > 0.3 或 stability < 0.5——大多数顺利的会话不触发反思
2. **内容是噪音**：`retrospect.ts` 的模板化输出（"本次会话表现良好""策略稳定性下降"）被代码自己标记为 `TEMPLATE_NOISE_FRAGMENTS` 过滤掉。过滤完就什么都不剩了
3. **事后总结不如事中捕获**：会话结束时回顾整个会话，能提取的结构性洞察极少。真正有价值的经验发生在"错误被机制捕获 → agent 修复"的那一刻
4. **提示词层面的"写教训"指令产生锚定效应**：agent 变得保守，花精力避免犯错而不是大胆推进

## 1. 设计原则

### 1.1 诊断型知识，不是防御型知识

| 类型 | 示例 | 效果 |
|------|------|------|
| 防御型（旧） | "改 async 代码要小心 await" | 让 agent 变慢、变保守 |
| 诊断型（新） | "当测试报 'Cannot read property of undefined' 且你刚改过数组初始化，根因通常是 `noUncheckedIndexedAccess` 把可选元素推断为 undefined" | 让 agent 下次更快定位 |

防御型知识的本质是行为约束——"你要小心"。诊断型知识的本质是模式识别——"你看到 X，根因大概率是 Y"。前者锚定，后者加速。

### 1.2 从机制门捕获，不从自我反思捕获

经验最有价值的时刻是：**错误被外部机制捕获 → agent 被迫面对 → agent 分析根因 → agent 修复**。这个链条中的"分析根因"和"修复"才是真正的成长。不是事后"我觉得这次会话哪些地方可以改进"。

触发点：

```
review worker 抓到问题 ──┐
tsc 报类型错误 ──────────┤
test 失败且根因非显然 ───┼──→ 捕获时刻 → 蒸馏 → 门控 → 存储
delivery gate 驳回 ──────┤
agent 自行发现但需要返工 ─┘
```

### 1.3 高门控，低注入

- **高门控**：单次事件 importance = 0.3；同模式出现 2 次升到 0.6；3 次以上 0.8。只有 importance ≥ 0.6 的条目才注入到新会话
- **低注入**：不进系统提示（不锚定），走 `<historical-lessons>` volatile 通道（已有的注入路径），关键词匹配才出现，habituation 机制自动抑制高频但无效果的条目

## 2. 数据模型

```ts
interface ExperiencePattern {
  id: string
  /** 捕获来源 */
  source: 'review-gate' | 'test-failure' | 'typecheck' | 'delivery-gate' | 'self-correction'
  /** 诊断型模式描述：当看到 X，根因大概率是 Y */
  pattern: string
  /** 检索关键词 */
  keywords: string[]
  /** 证据链 */
  errorSignal: string       // 机制捕获到的信号（如 tsc 错误消息、review finding summary）
  rootCause: string         // agent 分析出的根因
  fixApproach: string       // 修复方式
  /** 元数据 */
  createdAt: number
  lastSeenAt: number
  occurrenceCount: number   // 同模式出现次数
  importance: number        // 0.3 起步，recurrence +0.15，decay -0.1/月
  /** 退化 */
  suppressed?: boolean      // 长时间未匹配 → 退化
}
```

与旧 `PlaybookBullet` 的关键区别：

| 字段 | PlaybookBullet | ExperiencePattern | 为什么改 |
|------|---------------|-------------------|---------|
| lesson / pattern | "改 async 要小心 await" | "当 Promise rejection 被吞且 tsc 无错，检查 `.then()` 链是否缺 return" | 防御型 → 诊断型 |
| context | 'root-cause' / 'recommendation' | source: 5 种机制来源 | 知道经验从哪来 |
| — | — | errorSignal + rootCause + fixApproach | 完整证据链，不是一句话 |

## 3. 捕获机制

### 3.1 捕获点 1：Review Gate Findings（最高价值）

当 review worker 返回的 finding 被 agent 接受并修复时，这是最高价值的经验——因为 agent 自己没发现这个问题。

**触发**：review-coordinator 返回 finding → agent 在后续 turn 中修复了对应问题

**捕获内容**：
- `errorSignal`：finding.summary（review worker 的描述）
- `rootCause`：从 agent 的修复 diff 中推断（改了什么 = 根因是什么）
- `fixApproach`：实际修复的 diff 摘要

**实现位置**：`review-coordinator-deps.ts` 的 finding 消费路径。当 agent 的下一个 action 修改了 finding 指出的文件/行，标记为"已修复 finding"，触发捕获。

### 3.2 捕获点 2：Test Failure with Non-Obvious Root Cause

不是所有 test failure 都值得捕获。"少了一个 await" 不值得（那是基础错误）。值得捕获的是：test 失败信号和根因之间的关系不直观的情况。

**触发**：run_tests 返回 failed > 0 → agent 修复 → 测试转绿

**过滤**：只有当 agent 经过了 ≥ 2 次尝试才修复的失败才捕获。1 次就修好的是简单错误，不值得存。

**捕获内容**：
- `errorSignal`：失败的 test name + assert 消息
- `rootCause`：从 agent 的调试过程和最终修复 diff 中提取
- `fixApproach`：修复方式

### 3.3 捕获点 3：Typecheck 结构性错误

**触发**：`tsc --noEmit` 报错 → agent 修复

**过滤**：只捕获 `ts(xxxx)` 错误码属于结构性问题的：
- TS2322（类型不匹配——可能揭示接口设计问题）
- TS2345（参数类型——可能揭示数据流问题）
- TS2304/TS2614（找不到/隐式 any——揭示导入或声明遗漏）
- 不捕获：TS6133（未使用变量）等琐碎错误

### 3.4 捕获点 4：Delivery Gate Rejection

**触发**：delivery-gate-v2 返回 RED 或 YELLOW（非 tool_invocation_failure）

**捕获内容**：gate 拒绝的原因 + agent 的修复方式。这是高价值经验——gate 拒绝意味着 agent 的自我验证不充分。

### 3.5 不捕获的场景

- agent 自行发现并立即修复的错误（正常的调试循环，不需要捕获）
- 简单的 1 次修复（价值低）
- 外部环境问题（网络超时、并发污染、路径不存在）
- 已有规则覆盖的错误（如路径逃逸被 validatePath 拦截——已有 prompt 规则）

## 4. 蒸馏过程

捕获到的原始数据（errorSignal + rootCause + fixApproach）需要被蒸馏成诊断型 pattern。

### 4.1 蒸馏时机

**不在捕获时蒸馏**（会打断 agent 的执行流）。在会话结束时，对当次会话的所有捕获做批量蒸馏。

### 4.2 蒸馏方法

利用已有的 retrospect 机制，但改变输入和输出格式：

**输入**（给 LLM 的蒸馏 prompt）：
```
以下是本次会话中被机制捕获并修复的错误。对每一条，提炼一条诊断型模式：
- 格式："当 [信号模式]，根因大概率是 [根因]。检查 [检查方向]。"
- 不要写"要小心""别忘了"等行为指令。
- 如果根因是一次性的（不会复现），标记为 skip。

错误 1:
  信号: {errorSignal}
  根因: {rootCause}
  修复: {fixApproach}

...
```

**输出**：每条一个 `ExperiencePattern` 或 skip。

### 4.3 蒸馏质量门

蒸馏后，对每条 pattern 检查：

1. **是诊断型还是防御型？** 包含"小心""注意""确保""别忘了" → 丢弃
2. **有具体的信号→根因映射吗？** 只有"改 async 要小心"没有信号 → 丢弃
3. **根因是结构性的吗？** "少了一个 await"是基础错误 → 丢弃。"noUncheckedIndexedAccess 把 `.find()` 结果推断为 `T | undefined`，传给期望 `T` 的参数会 TS2345" → 保留
4. **和现有规则重复吗？** 已在 prompt/rules/seed-capsule 中有的 → 丢弃

## 5. 存储与去重

复用 `playbook-store.ts` 的存储层，文件改为 `.rivet/experience.jsonl`。

### 5.1 去重逻辑

新 pattern 入库时，和已有 pattern 做关键词重叠检查（复用 `keywordOverlap()`）：
- 重叠 ≥ 0.5 → 合并：`occurrenceCount++`，`importance += 0.15`，更新 `lastSeenAt`，合并 keywords
- 重叠 < 0.5 → 新条目

### 5.2 重要性升级

```
单次出现:  importance = 0.3（不注入）
2 次出现:  importance = 0.6（开始注入）
3+ 次出现: importance = 0.8（高优先注入）
```

只有 importance ≥ 0.6 的 pattern 才会注入到新会话。这意味着：**一个经验必须被机制捕获至少 2 次才进入注入**。这本身就是质量门——一次性的错误不会污染上下文。

### 5.3 衰退与清理

- 每月 importance - 0.1（复用 `decayImportance()`）
- 降到 0.1 以下 → 从存储中移除
- 被注入但 habituation tracker 标记为无效（连续 5 次出现但没改变行为）→ importance 直接降到 0.2

### 5.4 容量

保持 50 条上限（现有设计）。优先保留高 importance + 高 occurrenceCount 的。

## 6. 注入机制

复用现有注入路径，改内容不改管道：

```
context-injection.ts:55  refreshPlaybookLessons()
  → ExperienceStore.query(keywords, topK=3)
  → 只返回 importance ≥ 0.6 的
  → engine.ts:572  updatePlaybookLessons()
  → volatile.ts:284  <historical-lessons> 标签
```

注入格式改为诊断型：

```xml
<historical-lessons>
- 当 tsc 报 TS2345 且参数类型包含 `T | undefined`，检查 noUncheckedIndexedAccess 下 `.find()` / `[index]` 的返回类型 (出现 3 次)
- 当 review worker 报"missing consumer"，检查新导出的函数/类型是否有调用方 (出现 2 次)
</historical-lessons>
```

**关键约束**：注入标签名不改（`historical-lessons`），保持前缀缓存兼容。引擎的 habituation 机制（`FieldHabituationTracker`）继续生效——如果某条 lesson 连续出现但不改变行为，会被自动抑制。

## 7. 提示词配合

### 7.1 删除的

旧 beliefs 第 6 条"探索中犯错是代价，同样的错误复现时先写教训再继续"已在 f5af43a9 删除。**不恢复**。提示词层面不再指示 agent 写教训。

### 7.2 不增加的

不增加任何"遇到错误时记录经验"的提示词指令。这会重新引入锚定效应。捕获完全由机制驱动，不需要 agent 主动参与。

### 7.3 可选增加的（低优先）

在 `CLAUDE.md` 或项目指令中，可以加一条给用户看的说明：

```
## 经验系统

系统会自动从 review gate / test / typecheck / delivery gate 捕获的错误中蒸馏诊断型经验。
agent 不需要主动写教训——错误被机制捕获并修复后，经验会自动沉淀。
查看已有经验: cat .rivet/experience.jsonl | jq .
```

## 8. 与现有系统的关系

```
                     ┌──────────────────┐
                     │  Agent 自由执行   │ ← 不锚定，不写教训
                     └────────┬─────────┘
                              │
                    ┌─────────┴──────────┐
                    │  机制门捕获错误     │
                    │  (review/test/tsc) │
                    └─────────┬──────────┘
                              │
                     ┌────────┴─────────┐
                     │  Agent 修复错误   │ ← 这里有真正的学习
                     └────────┬─────────┘
                              │
                     ┌────────┴─────────┐
                     │  会话结束蒸馏     │ ← postSession hook
                     │  (不是自我反思)   │
                     └────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
     importance < 0.6    importance ≥ 0.6   重复出现
     不注入             注入              升级 importance
```

### 8.1 复用清单

| 组件 | 复用方式 | 改动量 |
|------|---------|--------|
| `playbook-store.ts` | 改文件名为 `experience.jsonl`，PlaybookBullet → ExperiencePattern | 小（类型扩展） |
| `playbook.ts` 的 matchBullets/decayImportance/enforceCapacity | 直接复用 | 零 |
| `playbook.ts` 的 extractBullets | **替换**为蒸馏 prompt 驱动的 LLM 蒸馏 | 中 |
| `playbook.ts` 的 deduplicateBullets | 复用 keywordOverlap 逻辑 | 零 |
| `playbook-reflect-hook.ts` | **重写**：从 retrospect 驱动改为 capture-buffer 驱动 | 大 |
| `context-injection.ts:55` | 直接复用注入路径 | 零 |
| `engine.ts` habituation tracker | 直接复用 | 零 |
| `volatile.ts` `<historical-lessons>` 标签 | 直接复用渲染路径 | 零 |

### 8.2 新建清单

| 组件 | 职责 |
|------|------|
| `experience-capture.ts` | 在 review/test/tsc/delivery-gate 的消费路径上埋点，收集 errorSignal + rootCause + fixApproach 到 session buffer |
| `experience-distill.ts` | postSession 时，对 session buffer 做批量蒸馏（LLM 驱动或规则驱动） |

### 8.3 不碰清单

- `static.ts`（系统提示词）——不增加教训相关指令
- `retrospect.ts`——旧系统保留但不再是经验的主要来源
- `delivery-gate-v2.ts` / `review-coordinator-deps.ts`——不改门逻辑，只在消费侧加观察者

## 9. 实施次序

### Phase 1 — 捕获埋点（可独立交付）
在 review-coordinator 和 delivery-gate 的消费路径加观察者，收集"被捕获的错误 + 修复方式"到 session 内存 buffer。不影响任何现有行为。

**验证**：运行一个正常会话，检查 buffer 中是否收集到了 review finding 和 delivery rejection。

### Phase 2 — 蒸馏与存储（可独立交付）
postSession hook 读取 session buffer，用 LLM 蒸馏成 ExperiencePattern，写入 `.rivet/experience.jsonl`。

**验证**：人为触发 review finding（制造一个 agent 会犯的错误），检查 experience.jsonl 中是否有蒸馏后的诊断型 pattern。

### Phase 3 — 注入闭环（依赖 Phase 2）
新会话启动时，从 experience.jsonl 查询 importance ≥ 0.6 的 pattern，注入 `<historical-lessons>`。

**验证**：确认注入的 pattern 是诊断型格式，habituation tracker 正常工作。

### Phase 4 — 重要性升级（渐进优化）
实现 recurrenceCount 机制：同模式 2 次出现升到 0.6，3 次升到 0.8。

**验证**：制造同类错误 3 次，确认第 3 次后 importance 达到 0.8 并被高优先注入。

## 10. 不做什么

- **不在提示词里指示 agent "写教训"** —— 锚定效应
- **不捕获 agent 自行修复的简单错误** —— 噪音
- **不注入 importance < 0.6 的 pattern** —— 一次性错误不该污染上下文
- **不改变 review gate / delivery gate 的行为** —— 只在消费侧观察，不改门逻辑
- **不把这个系统用作 agent 自我评价的输入** —— experience 是给未来会话用的，不是给当前会话反省用的
- **不强制每条经验都是 LLM 蒸馏的** —— 简单模式可以规则驱动（如 "TS2345 + T | undefined → noUncheckedIndexedAccess" 可以是硬编码映射）

## 11. 开放问题

1. **蒸馏用哪个模型？** 主会话模型（DeepSeek V4）还是单独调用一个 cheap 模型？建议用 cheap 模型——蒸馏是结构化任务，不需要主模型的深度。

2. **session buffer 在哪里存？** 内存（会话结束就丢，postSession hook 直接处理）还是临时文件？建议内存——如果 postSession hook 没跑（进程崩溃），经验丢了就丢了，不重要。

3. **跨项目共享？** `.rivet/experience.jsonl` 是项目级的。是否需要一个全局的 `~/.rivet/experience.jsonl` 存跨项目通用经验？建议暂不做——先让项目级跑起来，验证有效再考虑全局。

4. **用户可编辑？** 用户能否手动往 experience.jsonl 里加经验？建议可以——文件是 JSONL 格式，用户可以手动编辑。但手动添加的条目 importance 从 0.6 起（直接可注入）。
