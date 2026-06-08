# T2-02 P3 后续 · 交接计划(effort delta 安全上线 + PlanCache 闭环)

> 日期：2026-06-08
> 框架：T2-02 P3 — 在 `7bf86ca` 地基之上,把两个挂起的执行器真正接活
> 交接：领航星安排天枢执行;本计划已**预先消解设计分叉**(遵 [[feedback_delivery-summary-reports-convergence-points]])
> 前置已就绪：跨 session bandit 恢复(importState)、floor 安全闸(resolveEffortDelta + RED 测试)、诚实 docstring

## 当前真相(动手前已核)

- 升档闸:**零实现**,仅 `loop.ts:1092` docstring 提及。干净起点。
- `applyEffortDelta`:已实现 clamp+floor,**零活调用者**(本轮要接)。
- cold-start:`shouldSuggest` 在 `totalPulls < 10` 时**永远建议** → 升档闸必须挡住冷启动。
- shadow 遥测:已记录 `(context, arm, ruleBaseline, pendingRewardId)` → 一致性可从 shadow 数据测量。
- PlanCache:`lookupPlan` 有、**prompt 注入消费者无**;`tryJIT` 管线有、**活调用者无**;**未持久化**(bandit 已持久化,不对称)。

---

## Track A — effort delta 接活(执行器①,高风险,带双护栏)

### A1. 一致性升档闸(安全机制,先做)
新增判定:bandit 推荐**只有同时满足**才允许影响真实 effort:
- (a) `totalPulls >= MIN_PULLS`(过冷启动期);
- (b) 近 N 次 bandit 推荐方向与规则基线**一致率 ≥ 阈值**(用已有 shadow 遥测的 `(arm, ruleBaseline)` 计算)。

**【设计分叉·已定向】"一致"如何定义?**
- 方向:bandit 的 arm(delta:-1/0/+1)落到 effort 档位后,与规则基线 `ruleBaseline` 比较——**同向或相等记一致,反向记不一致**。在滚动窗口(N=最近 20 次 shadow 记录)上算一致率。
- 理由:§9.4 团队原意就是"与规则 N 次一致率",不是"avgReward 阈值"。一致率衡量的是"bandit 已学会不和成熟规则打架",这是上线前最该确认的安全信号;reward 阈值留作后续可选加强,不在本轮。
- 阈值起点:`MIN_PULLS=30`、`window=20`、`agreementRate>=0.8`。**这三个数是保守起点,可调,不是契约**——天枢若有更强依据可改,但要在交付总结里报告改了什么、为什么。

### A2. 接线 + feature flag(默认关)
- `applyEffortDelta` 在真实 effort 选择点被调用,但**外层包升档闸 + feature flag**:flag 关 → 直接返回 baseEffort(行为零变更);flag 开但闸未达 → 返回 baseEffort;flag 开且闸达 → 应用 delta(floor 仍不可击穿,复用 resolveEffortDelta)。
- **【设计分叉·已定向】接在哪个点?** 接在 `tool-execution.ts` 规则调整之后(即 shadow 遥测 `shadowRecommendEffort` 的同一位置之后),与 docstring 原述一致。理由:shadow 已在该点采样,接活点与观测点对齐,A/B 语义最干净。
- **【设计分叉·已定向】flag 放哪?** 放 config(如 `config.p3.effortDeltaEnabled`),默认 `false`。理由:与现有 `reasoningFloor` 等 config 项同层,领航星可一键开关、无需改码。

### A3. RED→GREEN 证明(交付硬门)
必须用变异源码证明三态测试有牙:
1. flag 关 = 真实 effort 与接线前逐 case 相等(行为零变更);
2. flag 开 + 闸未达(冷启动/一致率低)= 不动;
3. flag 开 + 闸达 = delta 应用,且 floor 仍不被击穿。

---

## Track B — PlanCache 闭环(执行器②,中风险,与 Track A 独立可并行)

### B1. PlanCache 持久化(补对称性)
- 给 `PlanCache` 加 `serialize()/deserialize()`(仿 `LinUCBBandit`),经 MeridianDb 在 `plancache:*` 键存取,`warmupMemories` 里**就地恢复**(复用本轮 importState 模式)。
- **【设计分叉·已定向】复用还是新机制?** 复用 7bf86ca 刚建的 in-place import 模式,不发明新东西。理由:bandit 已验证这条路;对称即可维护。

### B2. PlanCache 消费者 = prompt 注入(v1,仅建议)
- `lookupPlan` 命中时,把模板作为**tool-result nudge / 短建议**注入上下文,**不短路执行**。
- **【设计分叉·已定向】prompt 注入 vs tryJIT 激活?** 本轮只做 prompt 注入(advisory)。`tryJIT`(compile→短路执行,绕过模型决策)**继续挂起**,留作后续单独 gated 步骤。理由:计划 v1 明述"只作为 nudge/短建议";tryJIT 绕过模型是更大的行为变更,风险层级不同,不和注入混在一轮。tryJIT 的拒写门(已测)继续守着那个未激活的功能,无需动。

---

## 不做(本轮边界,防 scope 蔓延)
- 不激活 tryJIT 短路执行(B2 只注入)。
- 不加 reward 阈值闸(A1 只一致率)。
- 不碰 startup-RSS 内存预算。
- flag 默认关 → 合并后线上行为零变更,直到领航星手动开。

## 交付总结必须报告(遵新规)
- 三个阈值(MIN_PULLS/window/agreementRate)用了什么、是否调过、依据。
- 任何在岔路口的临时收敛:哪项、为何、卡在什么选择。
- 每个执行器的 RED→GREEN 证据 + flag 关态行为零变更证明。

## 代码锚点
- 升档闸 + 接线:`src/agent/loop.ts`(applyEffortDelta 周边)、`src/agent/tool-execution.ts`(接活点)
- shadow 数据源:`shadowRecommendEffort` 记录的 `(arm, ruleBaseline)`
- flag:`config`(p3.effortDeltaEnabled)
- PlanCache:`src/agent/plan-cache.ts`、`src/agent/p3-integration.ts`(lookupPlan/recordPlan)
- 持久化模式参照:`LinUCBBandit.importState` + `P3Integration.importEffortBanditState`(7bf86ca)
