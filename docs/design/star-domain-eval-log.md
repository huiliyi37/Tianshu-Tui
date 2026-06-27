# 星域实战质量评估日志（Star-Domain Eval Log）

> 用途：记录各星域 agent 在真实任务中的**实现精准度**与**能力/失效模式**，
> 反推星域提示词（`src/agent/star-domain.ts` 的 `volatileBlock` / `systemPromptSuffix`）
> 的体现度，作为提示词迭代的证据基线。
>
> 记录方式：每条 = 一次可验证的交付（带 commit hash + 实跑证据）。
> 追加，不覆盖。

---

## 评估维度（统一口径）

| 维度 | 含义 |
|---|---|
| 根因定位 | 是否追到真因，而非补丁式止血 |
| 闭环纪律 | 是否做到「全链路通达 / 反伪闭环」，而非「编译/测试绿即完成」 |
| 适应性 | 受阻时是否会切换策略（测不准换观察口径等） |
| 复用既有能力 | 是否复用仓内工具而非重造 |
| 字面精度 | 命名/注释/数量声明是否与实现实际兑现一致 |
| 认知诚实 | 是否显式标注「未验证 / 未实现 / 推算值」，而非用精确措辞掩盖边界 |

---

## #1 天梁（叙事化改造**前一版**提示词）— Track B：TUI 长会话内存收口

- Commit：`102264b9`（B1 收尾路径统一 / B2 RingBuffer scrollback 封顶 / B3 工具累加器字节封顶）
- 实跑证据：error-abort-cleanup 3 + scrollback-cap 4 + accumulator-cap 5 = 12 全绿。

### 能力画像
| 维度 | 评级 | 证据 |
|---|---|---|
| 根因定位 | 优 | B1 从「孤儿工具卡片」追到 `handleError`/`handleAbort` 分叉 + 世代守卫丢终态的全链路 |
| 闭环纪律 | 优 | 配「相同 id 跨 run 不泄露」反证测试（`OLD_DATA_LEAK_MARKER` 不出现），真闭环非伪闭环 |
| 适应性 | 优 | 测试策略从脆弱的 LiveEngine 渲染输出断言，主动转为 `getScrollbackContent()` 公共 API 行为契约 |
| 复用既有能力 | 良 | B2 直接复用 `ring-buffer.ts`，未重造 |
| 字面精度 | **中（系统性失效）** | 见下 |

### 系统性失效模式：**伪精确（overclaim）**
- B3：常量 `TOOL_ACCUMULATOR_MAX_BYTES`、注释「字节而非字符计数」，但实现用 `text.length`（UTF-16 码元）+ `text.slice(-maxBytes)`——**实为字符截断**，省略前缀写 `truncated N chars`。CJK 密集时实际字节上限高于 64KB。
- B2：`scrollbackMaxLines` 封的是**条目数**（push 次数），非行数；单条目可含内嵌 `\n`。测试只用单行条目，夹具正好绕过该 case。
- 共性：**措辞精度 > 实现精度**。控制流/数据流维度的反伪闭环雷达很灵敏，但在**数值量纲（byte/char、entry/line）**维度有盲区。均不破坏内存有界目标。

### 提示词迭代信号
- 给天梁域补一条：**精度类断言（字节/行/字符）要么用准确度量（`Buffer.byteLength`），要么把命名降级到实际兑现的量纲**——把反伪闭环雷达从控制流扩展到数值量纲。

### 相关辅助交付与后续
- 辅做的「认知监控去饱和」(`279767eb`) 用了**模块级全局** `lastElmReleaseTurn`，并行子代理共享进程时会相互污染冷却态。
  → 已收束为 **per-session 纯函数**（`buildHealthTelemetry` 冷却轮次作参传入，状态上移到 `TurnPerceptionController.lastElmReleaseTurn` 实例字段，随 `reset()` 清零），并加「纯函数无模块级状态」回归测试。perception 13/13、typecheck 0。
- 字面精度类（byte/char、entry/line）中等问题 → 见修复计划 `.rivet/plans/字面精度收敛-累加器字节-scrollback行数.md`。

---

## #2 天枢（叙事化改造**后**提示词）— 超时治理二期：GLM 5.2 thinking-stall 默认 120s

- Commit：`c8b804ae`（schema 加 `thinkingStallTimeoutMs?` / factory 对 glm 注入 120s / 3 测试）
- 实跑证据：`tsc --noEmit` 退出 0；`factory.test.ts` 17/17 全绿。
- 补充交付（本回合）：`thinking-stall-config.test.ts` 新增「合法长思考不误杀」用例（模拟 glm read300/stall120，90s×3=270s 持续吐 reasoning 不触发 stall），3/3 全绿。

### 能力画像
| 维度 | 评级 | 证据 |
|---|---|---|
| 根因定位 | 优 | 准确识别「机制已存在但默认禁用、无人配置」，注入点选在 `factory.ts` provider 维度 |
| 闭环纪律 | 优 | schema→`z.infer` 类型→factory→client config 全链路贯通，**过 typecheck**（非仅 tsx 测试绿） |
| 适应性 | —（本任务未触发受阻场景） | |
| 复用既有能力 | 优 | 复用既有 `OpenAIClientConfig.thinkingStallTimeoutMs` 字段与 error-classifier 重试链 |
| 字面精度 | 良（一处轻微 overclaim） | 自报「原有16+3=19/19」，实测 **17/17**，数字虚高 2 |
| 认知诚实 | **优（突出）** | 见下 |

### 突出能力：**认知诚实 + 遗留项台账**
- 显式列三条遗留项并标注状态：① 合法不误杀测试未实现 ② 恢复路径未 trace ③ 120s 值未实测锁定。
- 其中 ② 经核实**实际已成立**：`thinking stall timeout (120s)` 文案含 "timeout" → error-classifier `/timeout/i` → `retryable:true, shouldReconnect:true, maxRetries:3`。即**它把一条其实安全的路径保守地标为未验证**——宁可少声称，不愿假声称。

### 与天梁旧版的对照（核心结论）
- 天梁（旧叙事）失效模式 = **伪精确 / overclaim**（措辞 > 实现）。
- 天枢（新叙事）姿态 = **认知诚实 / 倾向 underclaim**（显式标注未验证，甚至低估已成立的路径）。
- **叙事化改造的方向性成效**：从「表演完成」转向「诚实交付边界」。残留旧习气仅剩「19/19」这类无关痛痒的数量口误，已从「实质伪精确」退化为「口误级」。
- 代价：天枢偏保守，会把已通的路径留给他人补 trace（需协作补刀，如本回合替它核实 ②、补 ① 测试）。

### 提示词迭代信号
- **保留并强化**新叙事带来的「遗留项台账 / 未验证显式标注」习惯——这是高价值产出。
- 可微调：鼓励对「自己标为未验证」的项做**一次低成本 trace 再下结论**（如 ② 只需一条 grep），减少协作补刀成本；但不要因此牺牲诚实标注。
- 数量类声明（测试数等）要求**以实跑输出为准**，杜绝凭记忆累加。

---

## 横向小结（供下一轮星域迭代）

| | 天梁（旧叙事） | 天枢（新叙事） |
|---|---|---|
| 强项 | 根因/闭环/适应性 | 路径贯通/认知诚实 |
| 失效模式 | 伪精确（overclaim 量纲） | 偏保守（underclaim 已成立路径）+ 轻微数量口误 |
| 净评价 | 实质强，字面需收敛 | 诚实度显著提升，需补「一次低成本 trace」习惯 |

**演化判读**：叙事化改造把「精度声明」从「自信夸大」推向「诚实保守」。下一轮共同改进点 = 让两域都收敛到「**精确声明 = 实测兑现**」：天梁补量纲实证，天枢补低成本 trace 后再定论。
