# 排查记录:turn 15 前缀缓存命中率从 98% 砸到 7.1%

> 会话 `mqhs5ckvp75gz7t7`(deepseek-v4-pro 桌面端,2026-06-17)。
> 起点是"看个会话缓存日志"的随口请求,终点是定位到 T7 全量坍缩阈值偏激进并修复(提交 `a80c250e`)。
> 价值不在结论本身,而在过程里**三次误判 → 自我推翻 → 再定因**的链路——记下来供下次同类排查复用。

## 一、现象

最新桌面端会话标题"深入了解整个项目的建设过程",token 用量异常:prompt 侧巨大、completion 极小,典型前缀缓存在起作用。逐 turn 看命中率时,turn 15 出现一次明显凹陷。

## 二、三次误判与推翻(核心)

### 误判 1:量纲错误——把累计计数器当单轮 prompt

第一版用 `events.jsonl` 的 `turn_complete.input_tokens` 算命中率,得到"命中率稳定在 49.6%"。**错。** 该字段是**累计计数器**(174K→24.7M 单调递增),不是单轮 prompt。我把 `cache_read` 在分母里重复计了一次。

- 纠正后:`input_tokens = cache_read + cache_creation`(末轮 24,144,000 + 566,878 = 24,710,878,严丝合缝),真实命中率 97.6%。
- 教训:**遥测字段先确认是"单次值"还是"累计值"再做除法。** 用一条已知恒等式(input = read + create)做自检,能立刻暴露量纲错误。

### 误判 2:"永久断裂"——又一次被累计值误导

第二版说"turn 15 后未缓存地板从 26.7万永久抬到 55万再没回落"。**也错**,同样源于累计值。

- ground truth 是会话自己写的 `.rivet/sessions/{sid}/cache-log.jsonl`(`loop-factory.ts:47 recordTurnCache` 每次 API 请求落一条)。它显示:turn 15 单请求 `input:270513 cacheRead:19200 cacheCreate:251313 hitRate:7.1%`,而 **turn 16/17/19 命中率回到 96%+、cacheCreate 回落到 ~11K**。是一次性凹陷,满血恢复。
- 教训:**有逐请求落盘的日志就别从聚合事件流反推。** cache-log.jsonl 才是 provider 实回 usage 的逐次记录。

### 误判 3:归因到错误机制——以为是 stale-round / heap 压缩

cache-log 里 turn 15 那条首次出现 `collapseWatermark:135`,且**无** `historyRewritten`/`volatileSwapped`/`frozenClamped` 标志。顺着 `collapse` 关键字查代码,先后怀疑了两条压缩路径:

1. `compact-boundary-coordinator.ts:107` stale-round 压缩 —— 条件 `tokenRatio>=0.5 && contextWindow < 1_000_000`。但本会话 contextWindow=1,000,000,**不满足 `< 1_000_000`,被豁免**,排除。
2. 同文件 138 行 heap-driven forced compaction —— 也调 `microCompactOai`,但那是堆内存触发,且 `collapseWatermark` 不由它产生。

最终顺着 `collapseWatermark` 的**赋值点**(grep set 处而非 read 处)找到真凶:`prompt/engine.ts:485-517` 的 **T7 request-time collapse**,与上述两条压缩路径完全独立。

- 教训:**追字段先查"谁写它"(赋值点)而非"谁读它"。** `collapseWatermark` 在 loop-factory 里只是被读出来记日志;真正 set 它的是 prompt engine。

## 三、根因

`prompt/engine.ts` 的 T7 机制(`contextWindow >= 200_000` 才启用):

```
estTokens = Σ(content + reasoning_content 字符) / 4     ← 含回传 reasoning,虚高
step      = floor(estTokens / 50_000)                   ← 每涨 5万估算token 跳一格
step 跳格 → watermark 前进 → 坍缩 collapseAge(默认8) turn 之前的旧 tool 结果
fillRatio = estTokens / contextWindow
fillRatio >= 0.5 → 全量语义坍缩(旧 tool 结果变摘要)     ← 破缓存的那一下
```

turn 15:会话开头读了十几个大文件 + 累积 reasoning_content,使 estTokens 跨过一个 50K 格且 fillRatio 过 0.5,触发全量坍缩 → 改写第 135 条之前的旧消息 → DeepSeek `exact-prefix` 整段前缀失效。

**量纲错配是病根**:T7 用 estTokens(含 reasoning、char/4 虚估)做触发,破的却是真实计费缓存。turn 15 真实计费 prompt 才 270K(占 1M 窗口 27%),离溢出极远,却付了破缓存的代价。

## 四、成本(V4-PRO 贵档:命中 0.025 / 未命中 3 / 输出 6 元每百万)

| 项 | 值 |
|---|---|
| turn 15 实际成本(坍缩) | 0.7544 元 |
| 反事实(不坍缩,全命中) | 0.0395 元 |
| **净增量** | **≈ 0.71 元** |
| 占全会话总成本(2.67 元) | **~27%** |
| 占全会话 cacheCreate 成本 | **44%** |

价差本质:命中 0.025 → 未命中 3,是 **120 倍**的悬崖。模型越贵,破前缀缓存越狠——这正是 `CLAUDE.md` 把前缀缓存列为核心优化的原因。

## 五、修复(提交 a80c250e,方案 A)

`src/prompt/engine.ts`:
- 新增命名常量 `FULL_COLLAPSE_FILL_RATIO = 0.85`(原裸值 `0.5`)+ rationale 注释。
- 调用点 `requestTimeCollapse(..., fillRatio < FULL_COLLAPSE_FILL_RATIO)`。轻量 pass(strip reasoning + 去重)仍全程跑;**只有破缓存的全量语义坍缩推迟到窗口真正逼近满(85%)**。
- 回归测试 `full-collapse-threshold.test.ts`:锁"60% 不全量坍缩(旧阈值下会,RED→GREEN)/ 90% 才坍缩"。

验证:新测试 2/2、既有 collapse/cache-stability/engine 78/78、typecheck 净。全量 6626 测试 6620 通过,5 失败经 stash 复跑确认为预存在(startup RSS / compaction prune@128K / undo / stall-sweep / active-claims 时序),均不在改动路径。

## 六、可复用排查清单

1. 算缓存命中率前,先确认遥测字段是单次还是累计;用 `input = cache_read + cache_create` 自检量纲。
2. 优先读逐请求落盘日志(`cache-log.jsonl`),别从累计事件流反推单轮值。
3. 看 breadcrumb 标志(`historyRewritten`/`volatileSwapped`/`frozenClamped`/`collapseWatermark`)缩小机制范围。
4. 追某字段成因,查它的赋值点而非读取点。
5. exact-prefix provider 上,任何"改写历史/坍缩旧消息"的机制都是潜在 cache-killer;触发判据若用估算量纲(尤其含 reasoning_content),要警惕与真实计费量纲错配。
