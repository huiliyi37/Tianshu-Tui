# 压#4 设计:阈值门控尾部增量（Threshold-Gated Tail Increment）

记录: 2026-06-07 / 状态: **降级为补充材料**（核心设计已被既有文档覆盖）
来源: `docs/known-issues/audit-completion-status.md` 压#4 + session 95dcf44d 实测

---

## ⚠️ 0. 本文定位修正（2026-06-07，写完后发现）

**本文不是独立设计——压#4 的主设计是天璇已写的**
[`2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md`](../analysis/../specs/2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md)
（审计前一天）。该文已：命名同一根因（**静态注入点的前载衰减**）、区分 A/B 臂、
§5.2 给出正确解法（**tool-result 尾部挂 nudge**）、确立 §0 公理（认知管线是已验证清醒态前提）。

**本文 §3.1「独立尾部消息」是错的**——它重复了 prefix-cache 不变量登记表的
**killer #6**（`2e37179`：cachedFreshBlock 作为独立 user message → 位置滑动 → 从该点起 prefix 全失效）。
trailer-mode 当初放弃独立消息正因此。**正确载体是融合设计 §5.2 的 tool-result content 尾部**
（挂在已存在消息上、创建时写入一次后冻结、消息数不增），不犯 killer #6 也不犯规则 1。

**本文唯一净新增、可喂给主设计的部分**（其余作废）：
1. **阈值门控**（§3.2）——融合设计未明确；只在信号跨阈值时挂 nudge，短循环零注入。
2. **cache 损失定量**（§七）——用真实 cache-log 建模，<0.3%（验证主设计 §5.2「零额外前缀代价」的实测背书）。
3. **实测数据**（§一）——循环 median=3 / 19% 长循环 / confidence-stale-41-turn。

以下 §3.1 / §3.3 / §3.4 / §四 / §五保留作记录，但**以融合设计为准**。

---

## 一、问题陈述（实测，净新增数据）

**现象**：动态认知 appendix（taskProgress / cognitiveProjection / affordanceHint /
behaviorMirror / strategyShift / repairHint / cerebellarHint）在 tool-call 循环内**全程冻结**
在 call 1 的快照，直到下一条用户消息才重建。

**代码证据**（`src/prompt/engine.ts`）：
- `cachedAppendix` 唯一消费点在 `:247`——merge 进最后一条用户消息。
- 行 50-52 注释承诺的 "standalone message at end of result" 通道**在代码里不存在**（stale 注释）。
- appendix 只在 `:183` guard（`userContent !== cachedFreshForUser`）为真时重建 = 仅新用户消息。
- `buildDynamicAppendix`（`volatile.ts`）是这些信号**唯一渲染出口**，无 tool-result 就近通道。

**实测代价**（session 95dcf44d，478 认知快照 / 47 循环）：
- 循环长度 median=3，mean=10.2，max=50；≥20 turn 长循环占 **9/47 ≈ 19%**。
- 最长 50-turn 循环内信号形态（**缓漂移 + 阶跃**，非高频噪声）：
  - `confidence`：turn 9 从 1.0 阶跃降到 0，之后 **41 turn 维持 0** → 模型全程以为高置信。
  - `pressure`：0 → 0.43 单调缓爬 → 模型对压力增长无感知。
  - `phase`：50 turn 内切换 **28 次** → 模型锁在 turn 0 的 tianxuan-locating。

**定性修正**：审计原标 "P2-perf-waste" 是**误标**。浪费的不是算力，是**长循环内认知新鲜度**。

---

## 二、为什么不能"无脑每 turn 注入"

1. **不真 cache-safe**：若 appendix 仍 merge 进用户消息（现状位置），每 turn 改动它 →
   从该消息起整个后缀 cache 失效（DeepSeek exact-prefix）。
2. **median=3 短循环（占 81%）零收益**：turn 0 vs turn 3 漂移极小，注入纯浪费 + 砸 cache。

数据指向：**只在信号真正漂移时、用 cache-safe 的尾部位置注入**。

## 三、设计:阈值门控尾部增量

### 3.1 位置——独立尾部消息，不动用户消息

把 fresh appendix 作为**独立 user 消息追加在 message 序列末尾**（最后一条 tool result 之后），
而非 merge 进开头的用户消息。

```
[system][tools][frozen user+volatile][tool result]...[tool result]  ← 前缀，字节不变 → 命中
                                                      [fresh appendix]  ← 尾部追加，前缀外
```

**cache 不变量**：追加尾部消息**不触碰前缀**，已 cached 的 [system...last tool result] 继续命中。
新增成本仅 = appendix 本身 token（cacheCreate）。

### 3.2 门控——只在漂移跨阈值时触发

每 turn 计算 drift，未跨阈值则**不注入**：

| 信号 | 触发条件 | 依据 |
|------|---------|------|
| confidence | 跨 0.4 边界或 \|Δ\|≥0.3 | turn 9 阶跃必须立刻可见 |
| phase | 切换 | 28 次/50turn，认知阶段是核心信号 |
| pressure | 越过 0.3 且 \|Δ\|≥0.1 | 缓爬到危险区才提示 |
| taskProgress | todo 状态变化 | 离散事件 |

短循环（median=3）信号通常不跨阈值 → **永不触发 → cache 全程命中**（与现状等价）。

### 3.3 冻结 + 淘汰——防中段改动 + 防膨胀

触发注入后，该尾部 appendix 这一 turn 是"最新"，**下一 turn 变成中段历史**。
为保 cache，必须像 `frozenUserMerged` 一样**冻结**它（字节不变），只让**最新一条** fresh。

- **冻结**：每条注入入 frozen 表，后续 turn 按序返回字节相同内容 → 中段不破 cache。
- **淘汰**：50-turn 若触发 5 次=多 5 条消息。设上限（每循环 ≤8 条），超限对**最老**注入做
  observation-mask 式压缩（`[cognitive snapshot masked]`），**非删除**（删除移位破 cache）。

### 3.4 1M 窗口策略

现有 pruning/masking 在 1M+ 窗口整段跳过（`:302`，因 mutate 破 cache）。
尾部增量是**追加**不是 mutate → **1M 窗口可照常启用**——这是它比 pruning 优越之处。

---

## 四、与现有机制的关系

- **不替换** frozen-merge：用户消息仍 merge frozenBase（保首轮前缀稳定）。
- appendix 从"merge 进用户消息"**迁出**到"独立尾部消息"——主要改动点。
- 复用 `frozenUserMerged` 的冻结/淘汰模式（已验证 cache-safe）。
- 门控逻辑挂在 RuntimeHookPipeline postTool 之后、buildOaiRequest 之前。

## 五、风险

| 风险 | 缓解 |
|------|------|
| 尾部消息每 turn 变 → 破 cache | 冻结表（3.3），只最新 fresh |
| message count 膨胀 | 每循环注入上限 + mask 压缩老条目 |
| 阈值调错 → 过度注入/漏报 | 阈值可配；先用实测兜底（conf 0.4 / pressure 0.3），telemetry 观测触发率 |
| 模型被尾部噪声干扰 | 只注入跨阈值信号，短循环不触发 |

---

## 六、待评审决策点

1. 阈值是否采纳实测兜底（conf 0.4 / pressure 0.3 / phase-any / todo-change）？
2. 每循环注入上限取多少（草案 8）？
3. 是否先做 **telemetry-only**（只记"本该注入几次"）跑一周，再开实际注入？← 推荐，零风险拿真实触发率。

---

## 七、cache 损失评估（实测建模，session 95dcf44d）

**基线**（cache-log，472 turn，公式修正后）：
- Σinput=44.5M，ΣcacheRead=40.8M → 真实命中率 **91.7%**（cacheRead 是 input 子集，非相加）。
- miss=8.3%=3.7M token 全价。

**损失模型**：尾部追加**不触碰前缀** → 既有 91.7% cacheRead 完全保留。唯一新增成本 =
注入的 appendix token，首现为 miss、后续 turn 冻结为命中。即损失 = 注入次数 × appendix token（一次性 miss）。

**阈值门控触发模拟**（CAP=8/loop，conf跨0.4 / phase切换 / pressure越0.3）：
- 47 循环 / 478 turn → **72 次注入**（15.1% 的 turn 追加尾部）。
- 短循环（≤3turn，24 段）总注入仅 8 → **多数短循环零注入，cache 完全不受影响**。
- 注入集中在长循环（50→8、50→8、34→8…）——正是 staleness 代价所在处。

**cache 损失定量**（appendix 三档体量，conservative：注入 token 全算 miss）：

| appendix 体量 | 新增 miss | 命中率下降 | 总成本增幅 |
|------|------|------|------|
| 500 token | 36K | **-0.07%** | +0.08% |
| 1000 token | 72K | **-0.15%** | +0.16% |
| 2000 token | 144K | **-0.30%** | +0.32% |

**结论**：即便 2000-token appendix，命中率下降 **<0.3%**，成本增幅 <0.35%。
新鲜度收益（修复长循环 confidence-stale-41-turn 等）几乎**零 cache 代价**。

**模型假设 / 未验证项（诚实标注）**：
1. 假设 3.3 的冻结正确实现——若注入的 appendix 未冻结，中段改动会从该点破 cache（模型失效）。
2. appendix token 体量（500–2000）是**估算**，未实测渲染大小；appendixMaxChars 上限 200K 字符(50K token)，
   但实际认知块远小于此。落地前应实测一次真实 appendix token。
3. 单 session 样本；循环长度分布可能不代表全部工作负载。
4. ΣcacheCreate=0（DeepSeek 不单列 cache 创建），故"注入=全价 miss"是 worst-case 假设，实际更优。
