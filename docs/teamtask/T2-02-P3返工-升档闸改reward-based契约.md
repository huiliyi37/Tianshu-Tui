# T2-02 P3 返工契约 · 升档闸改 reward-based(废弃一致率)

> 日期：2026-06-08
> 框架：T2-02 P3 Track A1 返工 — 替换病态的一致率闸
> 交接：领航星安排天枢执行;瑶光(门神)出契约并负责验收
> 关联：a372cbc(被打回的一致率闸)、decd640(接线+flag,保留)、7bf86ca(地基,保留)

## 为什么打回(必读,否则会再撞同一堵墙)

a372cbc 把闸从"永远关"改成了"永远开"。根因是**一致率判据对 ±1 动作空间在数学上恒真**:

- bandit 的 arms 只有 `{delta:-1, 0, +1}`。
- `resolveArmToEffort(ruleBaseline, arm)` 落点 = `clamp(ruleIdx + delta)`,delta∈{-1,0,+1}。
- 所以 `Math.abs(ruleIdx - banditIdx)` **恒 ≤ 1**(delta:0→0,delta:±1→1,边界 clamp→0)。
- 判据 `<= 1` 是**恒真谓词** → 合法 ruleBaseline 下 agreement 永远 100% → 闸过了 pulls/window 就**永不关闭**。

我(瑶光)穷举证明过:5档×3arm 全组合下闸从不关闭,唯一关闭途径是 ≥20% 条目带"垃圾 baseline"。

**结论:"bandit 推荐与规则基线一致"对单步 delta bandit 是伪命题——任何单步必然相邻基线。一致率这条路彻底废弃,别再尝试任何"比较 arm-effort 与 ruleBaseline 距离"的变体。** 这是我原 A1 设计的错,不是实现细节问题。

## 新设计:reward-based 闸

闸该问的不是"bandit 同不同意规则",而是**"bandit 的偏离是否被实测奖励证明值得"**。

数据源现成:
- `accept=+0.75 / reject=-0.25`(linucb-bandit.ts),故 `avgReward = accept_rate − 0.25`,值域 [−0.25, +0.75]。
- `completeEffortShadow` 已按 `computeEffortReward` 的正负调用 accept/reject → 每个 arm 的 `getStats().avgReward` 是真实战绩。

### 闸判据(全部满足才开)
1. `totalPulls ≥ MIN_PULLS_FOR_GATE`(保留 30)——数据量足。
2. 最优偏离 arm = `max(avgReward)` over `{delta:+1, delta:-1}`,其 `pulls ≥ MIN_ARM_PULLS`(新增,起点 **5**)——不靠单样本侥幸。
3. 该最优偏离 arm 的 `avgReward ≥ (delta:0 arm 的 avgReward) + MARGIN`(MARGIN 起点 **0.05**)——**偏离的平均收益要真正胜过"不动"**。

这条**能真正区分**:bandit 的 ±1 偏离若总被 reject(avgReward 低/负)→ 闸**关闭**;若偏离的 accept 率高于 no-op → 闸**打开**。这正是一致率做不到的。

**【设计分叉·已定向】闸读谁?** 读 `effortBandit.getStats()` 的 arm 战绩,**不再用 `_agreementWindow`**。
**【设计分叉·已定向】`_agreementWindow` / `AgreementEntry` 怎么办?** **删除**它们(连同 shadowRecommendEffort 里的 push 逻辑、p3-reward.ts 里的 AgreementEntry/AGREEMENT_WINDOW/AGREEMENT_RATE_THRESHOLD)——它们只服务于已废弃的一致率路。保留 `rewardSign` 字段无意义,一并清。
**【设计分叉·已定向】`isBanditGateOpen` 新签名?** 改为 `isBanditGateOpen(armStats: Array<{id,pulls,avgReward}>): boolean`,纯函数,便于单测。`isEffortGateOpen()` 传 `this.effortBandit.getStats()`。

### 阈值(保守起点,可调,改了要在交付总结报告)
`MIN_PULLS_FOR_GATE=30 / MIN_ARM_PULLS=5 / MARGIN=0.05`

## 测试要求(anti-false-green,硬门)

a372cbc 的闸测试是 false-green(标题说 closed 却断言 true、3 个零断言、1 个 `assert.ok(true)` 把缺陷合理化)。**这次禁止重演**,逐条硬性:

1. **每个标题含 "closed/关闭" 的测试,必须 `assert ... === false`**;含 "open/打开" 的必须 `=== true`。标题与断言方向不符 = 不通过。
2. **禁止零断言测试**:每个闸测试必须至少有一个 `isBanditGateOpen(...)` 断言。
3. **必须用合法 arm 战绩造出"闸关闭"**:构造一个 bandit(或 armStats),delta:+1/-1 多数被 reject(avgReward < delta:0),`totalPulls≥30`、`pulls≥5`,断言闸 **false**。这是证明闸"能关"的关键——a372cbc 正是造不出这个 case 才露馅。
4. **必须造出"闸打开"**:偏离 arm avgReward 明显高于 no-op,断言 **true**。
5. **变异证明有牙**:把判据 3 的 `>=` 改成 `<=`(或去掉 MARGIN),至少一个"关闭"测试变绿失败、一个"打开"测试变红——贴红/绿两态证据。
6. 保留并复用 a372cbc 里**确实有效**的部分:`resolveArmToEffort` 的 7 个边界测试(若 resolveArmToEffort 仍被别处用则留,否则随一致率路一起删)、`resolveEffortDelta` 三态测试(**这部分守住生死线,必须留**)。

## 不做(边界)
- 不碰 flag 默认值(`effortBanditEnabled` 仍默认 false → 线上零变更)。
- 不激活 tryJIT、不注入 planCacheSuggest 到 prompt(仍挂起)。
- 不碰 startup-RSS。
- 不改 accept/reject 的 reward 值(+0.75/−0.25 是 bandit 既有契约)。

## 交付总结必须报告(遵 [[feedback_delivery-summary-reports-convergence-points]])
- 三个阈值用了什么、是否调过、依据。
- 第 5 条变异证明的红/绿证据。
- 任何新发现的设计分叉:**报告,不要自行合理化**(a372cbc 的教训:发现一致率恒真时应上报,而非写 `assert.ok(true)` 把它论证掉)。
- 删除 _agreementWindow 后确认无悬挂引用(tsc 干净 + grep)。

## 代码锚点
- 闸:`src/agent/p3-reward.ts`(isBanditGateOpen + 删 AgreementEntry/AGREEMENT_*)
- 调用:`src/agent/p3-integration.ts`(isEffortGateOpen 传 getStats;删 _agreementWindow push @244、completeEffortShadow 里的 rewardSign)
- reward 值域:`src/agent/linucb-bandit.ts`(accept/reject,只读不改)
- 测试:新建/重写 `src/agent/__tests__/effort-gate-regression.test.ts`
- 保留:`resolveEffortDelta` 三态(生死线)
