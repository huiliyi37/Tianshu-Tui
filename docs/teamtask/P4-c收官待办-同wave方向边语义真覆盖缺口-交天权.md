# P4-c 收官待办 · 交天权 — 同 wave 方向边语义的真覆盖缺口

**出具**:瑶光(复现纪律门神,Opus 4.8)
**日期**:2026-06-08
**性质**:P4-c 审查 5 条发现的**收束确认** + **唯一悬置真缺口**移交
**前置**:本待办基于对 `cb3cf28`(第一版)/ `1cf1d6c`(逐条修)/ `c2e165c`(HEAD,补事实派生)的 RED→GREEN 复现验证。

---

## 一、先确认收束:5 条审查发现的复现验证结论

把源码还原到第一版缺陷态 `cb3cf28`、**保留当前测试**跑,精确打红 5 个测试,证明缺陷真实、测试有效;还原到 HEAD 后 17/17 全绿,证明真修复。逐条:

| # | 审查发现 | 严重度 | 复现结论 | 修复落点 |
|---|---|---|---|---|
| 1 | `apply=false` 仍可写 Physarum | HIGH | ✅ 真缺陷·已闭环 | `applyTeamPhysarumSupervision` 加 `if (!event.applied ...) return`(supervision.ts:396) |
| 2 | `explicit_dependency` 没实现 | HIGH | ✅ 真缺陷·已闭环 | `1cf1d6c` 实现边构造 + `c2e165c` 补 telemetry 派生事实链 |
| 3 | reported fallback 无降级 reason | MEDIUM | ✅ 真缺陷·已闭环 | `checkSafety` 记 `reported_files_fallback` |
| 4 | reported+非 healthy/low 未 shadow-only | MEDIUM | ✅ 真缺陷·已闭环 | `checkSafety` 加 §4.1 分支(reported-only + 非 healthy/low → shadowOnly) |
| 5 | 同 wave 并行测试伪覆盖 | MEDIUM | ⚠️ **未闭环·仅改措辞** | 见下,本待办主体 |

falsy-zero(`!depWaveId` 把 wave 0 判缺失)同批已修为 `depWaveId === undefined`(supervision.ts:252),归 structure-as-value 缺陷族,不单列。

**归因校准(防误读)**:这 5 条全是第一版实现漏项,族 = "checklist 压扁约束网络 + structure-as-value"。**无任何执行者被降级**;天权原稿里 `TeamEpisode`→`TeamWaveTelemetry` 的"降级"指的是数据结构名不副实的纠偏,非人员评级。审出一堆错 = 审查门起作用,是正面信号。

---

## 二、唯一悬置真缺口:同 wave 方向边语义没有真覆盖

### 现象(已坐实)
当前测试实体:`src/agent/__tests__/team-physarum-supervision.test.ts:384`
测试名自报路径:`rejects same-wave parallel tasks (duplicate wave → incomplete → no direction)`

它走的是 **duplicate-wave guard → episode incomplete → 提前阻断** 路径。`1cf1d6c` commit message 声称 "correctly verifies same-wave no directional edge",但它 verify 的是 **duplicate-wave guard**,**不是** spec §4.4 要求的语义。

### spec 真正要求覆盖的语义路径(当前无测试触达)
> 两个 task 同 wave、**episode otherwise valid**(complete + 非 failed/blocked + scope 健康)、**二者都有 actual files** ⇒ **不生成 A→B 方向边**。

### 为什么没覆盖(根因 = 数据模型债,非测试懒惰)
当前 `TeamEpisode` 模型**不支持**"同一 wave 内 task 级 actual files + 同 wave co-occurrence 语义"——所以测试只能退化成"让 episode 失败"来让边不产生。这与**天权原稿 #4** 标红的是**同一处债**:telemetry/episode 缺 task 级事实承载(per-task actual files + 同 wave 共现)。

### 为什么这是 false-green 而不只是缺测试
绿测试给出"同 wave 不产方向边 ✅"的验收信号,但走的不是 spec 语义路径,是另一条恰好也绿的退化路径(incomplete guard)。属 false-green 新亚种:**测试主动配合缺陷数据模型,绕过 spec 语义**。判别律:若实现者偷懒只做 incomplete guard,这条测试照样绿 → 它没在验证 §4.4。

---

## 三、收口方向(供天权出计划,不替天权决断)

闭环此缺口需先补数据模型,再补真测试,顺序不可逆:

1. **数据模型**:`TeamWaveTelemetry` / `TeamEpisode` 承载 per-task `actualFiles` + 同 wave task 共现关系(与天权原稿 #4 的 `per-task dependsOn / changedFiles / completion` 合并设计,勿各修各的)。
2. **语义实现**:`buildCrossWaveEdges` / 同 wave 分支显式判定"同 wave co-occurrence ⇒ 不产方向边",区别于 incomplete guard。
3. **反证测试**:构造"同 wave、episode otherwise valid、二者都有 actual files"用例,断言无 A→B 边;且该测试在 incomplete guard 失效时仍能独立打红(证明它测的是 §4.4 不是 guard)。

**承重墙提醒**:此项与天权原稿 #3(coordinator per-worker model)/#4(wave→episode 事实链)共享上游数据面。建议作为收官期"TeamEpisode 事实链补强"子任务统一立,而非在 supervision 函数内再硬凑。

---

## 四、移交边界

- 已闭环 4 条(HIGH×2 + MEDIUM×2)+ falsy-zero:**不需要天权再动**,RED→GREEN 已钉死。
- 悬置 1 条(同 wave 伪覆盖):**需要计划层立项**,因其根在数据模型债,跨 telemetry/episode/supervision 三处,非单函数可解。
- 本待办**不含代码改动**,纯审查移交。当前工作区对 HEAD 零 diff。
