# 天枢 vs awesome-harness-engineering 对比 — Deep Brainstorm 设计文档

> **日期**：2026-05-31
> **方法**：Deep Brainstorm（4 scout + 定向反证 + 3 轮演化）
> **对比对象**：[walkinglabs/awesome-harness-engineering](https://github.com/walkinglabs/awesome-harness-engineering)（2848 stars，2026-05-30 更新）
> **碎片池**：`.superpowers/brainstorm/2026-05-31-harness-engineering-comparison-fragments.json`

---

## 背景

用户原始意图：「对比 awesome-harness-engineering 这个项目，看天枢现有的 harness 有没有可以优化的。多 scout（sonnet/haiku）调研。」

天枢（Rivet）现状：为 DeepSeek V4 prefix-cache 优化的终端编码 agent，已有 18 个 runtime hook（`src/agent/hooks/`，文档写 9 个但实际 17 文件 / 18 实例）、claim-store、compaction、recovery ladder、coordinator 多 agent 委派。

清单定位：harness engineering 精选资源——context engineering / evaluation / observability / orchestration / safe autonomy。与天枢的 StarFlow v2「harness-level self-regulation」定位高度对口。

## Scout 调研汇总

### Scout A（sonnet）— Context/Memory + Constraints
- **success-swallows-failure**（HumanLayer）：命令成功只打 ✓(~10 token)，失败才 dump，mktemp 捕获输出。确定性裁剪，不依赖模型判断。
- **cache-aware compaction**（OpenHands）：size-gated 非 turn-gated，频率匹配 cache TTL，避免每轮压缩抵消缓存收益。
- **结构化摘要四字段**（Anthropic+OpenHands）：goals/progress/active-files/failing-tests，可被 claim-store 查询。
- **KV-cache locality**（Manus）：append-only 历史 + 确定性序列化 + 手动 breakpoint。天枢已遵守。

### Scout B（sonnet）— Foundations + Runtimes 架构范式
- 四种 harness 组织模型：Initializer/Worker 流水线、Planner/Generator/Evaluator(GAN)、Middleware 栈、Fowler 的 Feedforward/Feedback 双轴 + Entropy GC。
- 共同指向：harness 必须把「做」与「验证做对了」在**结构上**分开，而不只是时间上错开。
- 初判：天枢缺「控制类型维度」（generator vs evaluator 同路径）、持续漂移检测、独立 evaluator。

### Scout C（haiku）— Rivet 代码事实验证（验证 Scout B 的判断）
- 判断1（缺 pre-commitment gate）：**部分成立**。`task-contract.ts` 单向提取，`delivery-gate-v2.ts` 是事后检查非 turn 前锁定，successCriteria 无量化阈值。
- 判断2（缺持续漂移检测）：**成立**。meridian-hook 只做 code graph indexing，无 fitness/dead-code/coverage 扫描；所有 hook 绑 turn 生命周期。
- 判断3（缺独立 evaluator）：**部分成立**。`reviewer` 是可选 worker profile，不会自动审查 patcher 输出；ctcl-sanitizer/consistency-check 是后处理修正非独立评估。

### Scout D（haiku）— 跨领域：生物稳态 + 飞控降级
- 飞控**降级滞后**：易降难升，恢复需多通道交叉验证 + 最小停留时间，防抖动。
- 生物 **allostatic load**：累积成本超恢复能力时强制冷却期。
- 提议天枢 recovery 加 hysteresis + 累积计量。

### Scout 4（sonnet）— 定向反证（最高价值）
找假设最依赖的、从未被质疑的隐含前提：
1. **「自动派 reviewer = 独立 evaluator」是假设**：同模型自审盲区重合，且烧双倍 token、破坏主 agent cache（worker 独立 session 不共享 cache）。只有跨模型才有真独立性。
2. **「降级抖动」是想象的问题**：`src/` 里 hysteresis/oscillat/flap **零出现**，`refreshReliabilityDecision` 每 turn 从零重算（loop.ts:805-843），Node heap GC 后单调下降不振荡。给不振荡的系统加防抖=过度工程。
3. **「持续漂移检测」职责错位**：dead code/coverage 是用户项目 linter/CI 的事，天枢已有 `inspect_project`+`bash` 按需覆盖；read-policy 把 `coverage/` 标记为 generated。
4. **「per-turn 反应式是缺陷」前提崩塌**：对 prefix-cache 架构，全 turn-bound 是**正确**选择——任何 turn 间注入都破坏 cache 前缀。

**最终判定**：(c) 漂移检测应砍掉；(b) hysteresis 降级为可选 5 行修复；(a) evaluator 仅跨模型配置下成立。

## 证据分层（反证结论）

| 假设组成 | 反证 | 分类 | 处理 |
|---|---|---|---|
| 自动派 reviewer agent | 同模型自审无独立性 | 假设 | 降级：仅跨模型成立 |
| hysteresis 防抖动 | 抖动从飞控想象，代码零证据 | 假设 | 降级为 5 行 previousMode |
| 持续漂移检测 | 职责错位 + 必破 cache | 惯例错位+事实 | **砍掉** |
| per-turn 反应式是缺陷 | cache 架构下是正确选择 | 事实 | 放弃此隐含假设 |

## 三轮演化

### 第一轮：变异（4 方案）

| 方案 | 生态位 | 核心选择 |
|------|--------|----------|
| V1 确定性输出裁剪 | 主流·零成本 | 工具/hook 成功输出折叠成一行 ✓，失败才 dump 全文。零 LLM 成本，不碰 cache 前缀。 |
| V2 跨模型独立审查 | 邻近·条件性 | 复用 coordinator model routing，write worker 后自动触发**异模型** reviewer + 硬阈值拦截。默认 off。 |
| V3 cache-aware compaction | 空位 | compaction 改严格 size-gated + 四字段结构化摘要，频率对齐 cache TTL，摘要可被 claim-store 查询。 |
| V4 recovery 状态记忆 | 突变 | modeForRecoveryTrigger 加 previousMode，易降难升。 |

适应度函数：
- 硬约束 = 不破坏 prefix cache 前缀 + 不做用户项目 linter 职责 + 不增加默认 LLM 成本
- 加分 = 确定性（可复现） + 复用已有基础设施 + 立即可落地
- 减分 = 新增 LLM 调用 / background 进程 / 解决不存在的问题

### 第二轮：选择

- **V4 灭绝**：反证证明抖动是从飞控想象的，heap GC 后单调下降不振荡，代码防抖词零出现。解决不存在的问题。降级为可选 5 行修复，不进主方案。
- **V1 存活（最强）**：唯一同时满足全部硬约束、因果链最硬、落地最快。
- **V2 存活（条件）**：补上「独立 evaluator」维度，但必须强调仅跨模型有价值。
- **V3 存活（需审计）**：直接服务 cache 铁律，但需先确认当前 compaction 触发条件。

新发现：V1 与 hearth-observe 的「观测不注入消息流」是同一哲学，可推广为所有 hook 输出的统一原则。

### 第三轮：适应

**收敛洞察**：V1 + V3 收敛到同一核心真相——**context 的敌人是低价值 token 占据 cache 有效区；天枢该做的是减噪声，不是加能力。** 与创始信念「prefix cache 是呼吸」同源。

扩展适应：
- BlockStreamWriter + 工具输出管道 → V1 裁剪层载体（无需新基础设施）
- hearth-observe「观测不注入」哲学 → 所有 hook 输出统一原则
- coordinator model routing（coordinator.ts:117-138）→ V2 跨模型审查载体（已存在，只需接线）
- 回收 discarded_trait「previousMode」→ V2 reviewer 触发的可选次要特征

## 最终方案

按 ROI 排序，统一哲学：**观测不污染、确定性优于模型判断、减噪声优于加能力。**

### Phase 1（高 ROI，立即做）— 确定性输出裁剪
- 动作：给 `run_tests` / `bash` 成功输出加 ✓ 折叠（保留关键计数如 `✓ 234 tests passed`）；给 18 个 hook 成功输出加统一 ✓ 格式。失败永远 dump 全文。
- 成功标准：通过的测试套件从数百 token → 一行；失败信息无损。
- 退出条件：若折叠后丢失定位失败的信息则回退（只折叠成功，风险低）。

### Phase 2（中 ROI，需先审计）— compaction 摘要结构化
- **审计已完成（核查修正）**：`src/compact/auto.ts` 不存在；实际为 `constants.ts` 等。当前**已是 size-gated + cache-aware**：`AUTO_COMPACT_THRESHOLD = 800_000`（token，非 turn），`cache-preserving` 策略经 `adaptiveCompactPolicyRatios` 按 cache hit rate 动态调阈值。
- 动作（范围缩小）：仅把压缩摘要结构化为 goals/progress/active-files/failing-tests 四字段，供 claim-store 查询。size-gated 已无需改。
- 成功标准：摘要四字段化，可被 claim-store 读取。
- 退出条件：若结构化收益不明显（claim-store 不消费），降级为不做。

### Phase 3（条件 ROI，可选）— 跨模型独立审查
- 动作：仅当用户配多模型，coordinator 加「write worker 后自动触发**异模型** reviewer + 硬阈值拦截」，默认 off。
- 成功标准：DeepSeek 生成 → 异模型审 → blocking issue 拦截交付。
- 退出条件：同模型时不启用（无独立性）。

## 被砍掉的（避免白做）
- ❌ **持续漂移检测（dead code/coverage）**：职责错位，是用户项目 linter/CI 的事。天枢已有 `inspect_project`+`bash` 覆盖。
- ⬇️ **recovery 防抖动 hysteresis**：降级为可选 5 行修复。问题未被观察到，是飞控类比想象。

## 风险与应对

| 风险 | 应对 |
|------|------|
| 确定性折叠藏起 agent 需要的成功细节 | 折叠摘要保留关键计数，失败永远全文 |
| V2 同模型自审无价值 | 强制仅跨模型启用，默认 off |
| V3 改动触碰 compaction 影响 cache | 先审计触发条件，size-gated 才是 cache 友好 |

## 下一步
Phase 1 第一个具体动作：审计 `src/tools/run-tests.ts` 和 `src/tools/bash.ts` 当前的成功输出格式，确认折叠点。确认后调用 `writing-plans`。

