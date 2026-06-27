# Intent Preview（意图闸）误报优化 — dead-end 关联匹配 + momentum 口径

> 2026-06-27。用户报告：会话上下文实际占用仅 ~5%，却频繁强弹「意图预览 / high commit threshold / 历史 dead-end」。
> 经整条判定链路代码排查，定位为**两个误报源**，非真实风险。本文记录背景、根因、方案，供后续实现。

## 现象

桌面端 + TUI 都会强弹意图闸（INTENT PREVIEW / 意图预览），标题常带 100% 置信，
警告含 `high commit threshold` 与 `历史 dead-end: 处理 /Users/.../opencode-tui`。
触发时会话（mqwfrf6z，deepseek-v4-pro 1M 窗口）实测上下文仅约 3–5%，远未到压力告警线。

意图闸代码入口：`src/agent/intent-preview.ts`（判定 `shouldShowIntent`）+
`src/agent/turn-intent.ts`（控制器，决定是否阻塞等用户 y/n/a）。

## 判定链路（现状）

`shouldShowIntent`（intent-preview.ts:22-28）三个 **OR** 条件，任一命中即强弹并阻塞：

1. `strategy.commitThreshold > 0.8` —— 高提交阈值
2. `pheromones.some(p => p.signal === 'dead-end' && p.strength > 0)` —— **任意**一条 dead-end
3. `thrashingSuggestion === 'task_decomposition'` —— 抖动建议

`turn-intent.ts` 的放行条件（line 33-41）：未注册回调 / 本 turn 已弹 ≥3 次 / `vigor < 0.3`。
**没有"auto 模式自动放行"分支**——命中即强弹，与是否 auto 无关，这是设计预期。

## 根因 1：dead-end 匹配过宽（主误报源）

**数据流：**
```
turn-step-producer.ts:155  stigmergyStore.query()   ← 不带参数 → 返回【全量】信息素
  → loadedPheromones
  → turn-intent.ts:47     pheromones: loadedPheromones
  → intent-preview.ts:52  filter(signal==='dead-end' && strength>0)  ← 不查关联性
  → shouldShowIntent:25   任一存在即 true → 强弹
```

`stigmergyStore.query(path?)`（stigmergy.ts:258-261）：`path` 省略时返回**所有**条目。
intent-preview 把「库里存在任意一条 dead-end」当作触发条件，**与当前目标零关联性检查**。

**dead-end 的 path 字段语义错位**：`turn-intent.ts:60` 存的是 `preview.summary`
（= `处理 ${target}`，意图摘要字符串），不是文件路径。于是：
- 三个月前某个无关任务里 veto 过一次
- 该 dead-end 半衰期 7 天，只要没衰减到 0
- 今天开**任何**新任务都强弹

= 「5% 上下文、什么坏事都没发生、却弹 high commit threshold + 历史 dead-end」的直接原因。

## 根因 2：momentum 把探索性报错当停滞

`tool-pipeline.ts:1040`：`recordPrediction(!harnessResult.isError)` —— 工具执行报错 = 预测失败。
`computeMomentum = consecutiveCorrect / windowSize`（连续正确率），报一次错清零。

`sensorium.ts:376`：`momentum < 0.3` 时 `commitThreshold += 0.25` → 推过 0.8 → 触发弹窗。

正常调试/探索中工具报错是常态（grep 无匹配、测试 RED、文件不存在、bash 非零退出），
把它们计入「预测失败」会让 momentum 频繁归零 → 误判停滞 → commitThreshold 误升。
line 1038 仅豁免了 `run_tests` verify 阶段的 RED，**其余探索性报错仍被计入**。

## 次要问题

- **commitThreshold 三重计入**：intent-preview.ts:23 触发弹窗 + line 44 扣 confidence + line 53
  作为独立 warning 文本。同一信号被三处放大，显得比实际严重。
- **dead-end path 用意图摘要字符串**（turn-intent.ts:60）：既非文件路径也难复用，查询时
  无法做真正的关联匹配。应存结构化目标标识（taskContract id / 目标哈希）。
- **MAX_INTENT_PREVIEWS=3**（turn-intent.ts:25）：`shown` 在 `reset()` 清零，需确认 reset 时机
  ——若每 turn reset，单 turn 可弹 3 次，偏吵。

## 方案（按收益/风险排序）

### P0：dead-end 关联性匹配（改动聚焦，收益最大）

`shouldShowIntent` 的 dead-end 条件从「库里存在任意一条」改为「与当前目标有关联」。

#### 子串匹配的两个死区（需规避）

朴素的 `de.path.includes(t) || t.includes(de.path)` 正向可工作，但反向有两个死区：

1. **`summarizeTarget` 的 fallback**：`recentTargets` 为空或全以 `<` 开头时，
   `path = "继续执行当前计划"`。该字符串永不匹配任何 target → 成为**永久噪声**
   （只能靠 7 天半衰期清除）。**建议**：`recentTargets` 为空时跳过 dead-end 沉积——
   没有具体目标的 veto 不产生可复用的死路标记。

2. **多目标信息丢失**：`summarizeTarget` 只取 `recentTargets[0]`，但 agent 同轮可能
   操作多个文件，veto 原因可能与第二个目标相关。这是 P2（结构化存储）治本的范畴。

#### 开源通用性约束

`summarizeTarget`（intent-preview.ts:34-39）写死了中文字符串「处理 」「继续执行当前计划」。
P0 若依赖「处理 」前缀做路径提取，就把匹配逻辑与本地化文案耦合——任何文案改动
（本地化、改前缀）都会让匹配失效。对开源项目（可能有非中文用户）这是隐患。

#### 采纳方案：沉积原始 target + 匹配层兼容

治本做法：**沉积 dead-end 时，`path` 存「第一个有效 target」原始值**（而非 `preview.summary`），
匹配时直接用 target 比对，绕开「处理 」前缀提取。

- `turn-intent.ts:59-60` 沉积点改为存 `recentTargets` 第一个有效值；空则**不沉积**
  （规避死区 1）。
- `intent-preview.ts` 匹配层对**旧数据兼容**：旧 dead-end 的 path 仍是 `处理 xxx`
  格式，匹配前剥离 `处理 ` 前缀与尾部 `...`；新数据已是原始 target，直接比对。
- 匹配仍用子串（`extracted.includes(t) || t.includes(extracted)`），但仅对去前缀后的
  实际内容比对，跳过 fallback 摘要与 `<` 开头的伪 target。

  ```ts
  const relevantDeadEnds = deadEnds.filter(de => {
    // 跳过无法关联的 fallback 摘要（旧格式）与空目标（新格式不应再产生）
    if (!de.path || de.path === '继续执行当前计划') return false
    // 兼容旧数据：剥离 "处理 " 前缀和 "..." 截断尾
    const extracted = de.path.startsWith('处理 ') ? de.path.slice(3).replace(/\.\.\.$/, '') : de.path
    return input.recentTargets?.some(t => {
      if (!t || t.startsWith('<')) return false
      return extracted.includes(t) || t.includes(extracted)
    })
  })
  ```

- 风险：近期 dead-end 的 path 与当前目标碰巧子串重合仍会触发，但远好于「全量命中」。
  彻底精确匹配见 P2。

### P1：momentum 滑动窗口成功率（替代白名单，零维护）

`tool-pipeline.ts:1040` 的 `recordPrediction(!isError)` 把工具报错当预测失败。
当前 `computeMomentum = consecutiveCorrect / windowSize`（连续正确率），一次报错清零，
使 momentum 从 0.9 坠崖到 0 → 推高 commitThreshold → 触发弹窗。

#### 替代设计：滑动窗口成功率

不枚举「哪些错误类型豁免」（白名单易遗漏、每个新工具要维护），改用**统计信号处理**——
把 `consecutiveCorrect` 的语义从「连续正确」改为「窗口内正确计数」，一次探索性报错
只让 momentum 平滑下降（窗口 10、1 次报错 9 次正确 → 0.9→0.8），而非清零。

- **不改 `PredictionAccumulator` 数据结构**（`predictions: boolean[]` 已是滑动窗口，
  `slice(-windowSize)` 在 recordPrediction:25 维护）。只改 `computeMomentum` 的计算口径。
- `prediction-error.ts:107` 当前 `return clamp(acc.consecutiveCorrect / acc.windowSize)`，
  改为 `return clamp(wins / acc.predictions.length)`（窗口内有数据时）。
- 空窗口（`predictions.length === 0`）返回 0，与现一致。
- 效果：一次 grep 无匹配不坠崖；连续多次报错仍能正确反映停滞（窗口满了错误就低）。

与白名单的区别：白名单需维护「run_tests verify RED」「grep 无匹配」「文件不存在」等
枚举项；滑动窗口是统计平滑，零维护，对所有工具通用——符合开源项目的通用性要求。

### P2（可选）：dead-end 存结构化目标标识

`turn-intent.ts:60` 把 `preview.summary` 改为 taskContract id 或目标哈希，让查询时能
精确匹配「这个具体目标曾被 veto」，而非字符串子串匹配。需改 stigmergy 沉积路径 +
查询路径，改动面较大。P0 的「存原始 target」已大幅缓解，P2 可后续。

## 不做的事

- 不改意图闸的「强提醒」本质——它是对 agent 自主性的硬闸，命中条件阻塞是设计预期。
- 不动 `MAX_INTENT_PREVIEWS` 默认值（先解决误报根因，频率自然下降）。
- 不改 `summarizeTarget` 的中文文案（保持用户可见界面不变；P0 通过存原始 target 绕开耦合）。

## 涉及文件

- `src/agent/intent-preview.ts` —— shouldShowIntent + buildIntentPreview（P0 主改）
- `src/agent/turn-intent.ts` —— dead-end 沉积 path（P2）
- `src/agent/tool-pipeline.ts:1040` —— recordPrediction 判定（P1）
- `src/context/stigmergy.ts:258` —— query 全量返回（P0 的上下文，不改）
