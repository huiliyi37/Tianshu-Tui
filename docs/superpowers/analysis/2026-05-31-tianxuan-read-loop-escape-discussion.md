# 天璇视角下的 read-loop 防循环方案讨论

> 状态：讨论稿  
> 日期：2026-05-31  
> 背景：一次天枢会话在诊断 bug 时反复对 `src/agent/loop.ts` 调用 `read_file` 不同 offset，但持续收到 `[diet:redundant]` / `[diet:useless]`，没有识别为“策略无新信息”，继续换 offset 重试，造成 token 浪费和调试停滞。

---

## 1. 已确认事实

### 1.1 现象

- Agent 连续多次读取同一文件 `src/agent/loop.ts`。
- 每次换不同 offset，但结果被上下文压缩 / diet 层替换为：
  - `[diet:redundant] re-read later`
  - `[diet:useless] retried successfully`
- Agent 没有把这些结果识别为“当前策略失效”，而是继续重试同一路径。

### 1.2 已有相关机制

- `src/compact/agent-diet.ts` 会产生 `[diet:redundant]` / `[diet:useless]`。
- `docs/superpowers/plans/2026-05-29-compaction-diet-range-aware-dedup.md` 已经处理过“不同 offset 被错误去重”的底层范围感知问题。
- `.rivet/knowledge/guardrails.md` 已记录 read-loop detection 和 3-strike escape，但该文件目前更像“可发现知识”，不保证每次会话都自动进入 prompt。
- `src/prompt/static.ts` 已加入一条短规则：同一文件 `read_file` 连续 2 次返回 diet 占位符时，停止读该文件并切换策略。

---

## 2. 用天璇理念重新理解问题

天璇胶囊的核心方法不是“给答案”，而是“换视角”：

1. 在看似无关的领域寻找碎片。
2. 在碎片之间寻找收敛。
3. 每一轮创造性探索后，做定向反证。
4. 当别人画硬线时，去找层间温跃层。

这个 read-loop 问题正好发生在两条硬线之间：

| 硬线 | 原意 | 实际冲突 |
|------|------|----------|
| `read_file` 先读再改 | 防止凭空改代码 | 长会话中重复读同一文件可能被 diet 抑制 |
| `agent-diet` 去重 | 降低上下文压力 | 返回占位符后，Agent 可能以为只是 offset 不对 |

真正的问题不是“read_file 不好”，也不是“diet 不好”，而是二者之间缺少一个**温跃层协议**：当读取工具返回 diet 占位符时，Agent 应该把它解释为“这条获取信息路径没有新增信息”，而不是继续沿同一轴重试。

---

## 3. 设计目标

1. **低成本防循环**：不引入大型架构即可减少重复读文件。
2. **不破坏 verify-first**：仍然鼓励先读代码，只是在读不到新信息时换路。
3. **不把 prompt 变厚**：static prompt 只保留最小行为规则，详细机制放文档 / 运行时信号。
4. **把 diet 占位符升级为策略信号**：让工具结果本身携带“下一步应该怎么做”的方向。
5. **避免 P5 未接线**：任何新文档或加载器都必须确认是否进入实际运行路径。

---

## 4. 可行方案分层

### 方案 A：static prompt 最小护栏（已做，保留）

在 `src/prompt/static.ts` 的 `<tool-usage>` 中保留短规则：

```text
防循环：同一文件 read_file 连续 2 次返回 [diet:redundant]/[diet:useless]，停止 read_file；必须切换到 grep / ask_user_question，若专用工具不足且规则允许才用 bash sed 精确取片段。禁止第 4 次对同一路径直接 read_file。任何方法 3 次无新信息，先声明“策略 X 无效，切换到 Y”，再换工具。
```

**优点**：
- 每次会话都会加载。
- 立即生效。
- 不依赖额外接线。

**缺点**：
- 仍然依赖模型自觉遵守。
- 只能软约束，不能在工具层阻止第 4 次 read。
- prompt 继续增长会稀释 identity 信号。

**结论**：作为底线护栏保留，但不要继续往 static prompt 堆细节。

---

### 方案 B：tool-pipeline 注入“策略切换提示”（推荐 P1）

在工具执行结果进入上下文之前，检测结果是否包含：

- `[diet:redundant]`
- `[diet:useless]`

如果命中，并且近期同一路径已发生 2 次以上，就在该 tool result 附近追加一个短提示：

```text
[strategy-signal: read-loop]
This read_file result produced no new information. Do not retry read_file on the same path immediately. Switch to grep/repo_graph/ask_user_question, or state why another read is necessary.
```

中文版本：

```text
[策略信号：读取循环]
这次 read_file 没有提供新信息。不要继续立刻读取同一路径；请切换到 grep / repo_graph / ask_user_question，或明确说明为什么必须再次读取。
```

**优点**：
- 信号出现在失败现场，比 static prompt 更容易被模型注意到。
- 不需要强行阻断工具，先做温和 steer。
- 能保持天璇理念：不是禁止探索，而是在无信息增益时触发反证和换路。

**风险**：
- 如果追加内容太长，会增加上下文噪音。
- 如果所有 diet 占位符都追加，可能反而污染上下文。

**约束**：
- 只在连续 2 次同一路径命中时追加。
- 每个 path 每轮最多提示 1 次。
- 提示必须短，不超过 300 字符。

**需要调研的接入点**：
- `src/agent/tool-pipeline.ts` 中已有 `finalContent.includes('[pruned]') || finalContent.includes('[diet:redundant]')` 相关检测。
- 可从那里扩展 read-loop strategy signal，但实施前需要读完整上下文，确认不会影响 artifact / UI 展示。

---

### 方案 C：行为镜面 / doom-loop 检测加入 read-loop 指标（推荐 P2）

把重复无信息读文件纳入行为监控，而不是只靠 prompt。

可能的指标：

```ts
readLoopScore = countRecent(
  tool === 'read_file' &&
  sameTarget &&
  result includes '[diet:redundant]' | '[diet:useless]'
)
```

触发后：

- 在 cognitive mirror / task context 中显示：`read_loop: warn`。
- 对 Agent 注入短提醒：`你正在重复读取无新信息的文件，请切换策略。`
- 若连续达到阈值，可以提升 doom-loop level，但不应直接禁止读工具。

**优点**：
- 从“单次工具结果”提升到“轨迹模式识别”。
- 能覆盖 grep 重复、bash 重复、测试重复失败等更广义的策略固着。

**风险**：
- 需要准确归因 target；如果 target 提取不稳定，可能误报。
- 监控过多会造成“控制层噪音”。

**建议**：
- P2 先只观测，不阻断。
- 先输出 telemetry，再决定是否加入 gating。

---

### 方案 D：工具层硬门禁：禁止第 4 次同路径 read_file（谨慎）

当同一路径连续 3 次 `read_file` 都无新信息，第 4 次直接返回错误：

```text
[blocked:read-loop]
Direct read_file on this path is blocked because the last 3 attempts yielded no new information. Use grep/repo_graph/ask_user_question first.
```

**优点**：
- 最强防循环。
- 不依赖模型遵守 prompt。

**风险**：
- 可能误伤合法场景，例如文件被编辑后需要重读。
- “同路径”不等于“同内容”；offset / limit / 文件修改时间都需要考虑。
- 如果门禁状态不随 edit_file / write_file 清除，会阻塞正常调试。

**若要做，必须满足**：
- 只有 diet 占位符计入 strike，成功返回真实内容不计入。
- 对该 path 发生 edit_file / write_file 后清零。
- 换用 grep / repo_graph / related_tests / diff 后清零或降级。
- 明确提示替代路径。

**结论**：不作为第一步。先做方案 B / C，收集证据后再决定。

---

### 方案 E：seed capsule engine 接入天璇 L1 方法（长期）

已有设计：`docs/superpowers/specs/2026-05-28-seed-capsule-engine-design.md`。

它提出：

- L1：session 启动时注入天璇核心方法摘要到 heuristicRules。
- L2/L3：当检测到认知枯竭 / 策略固着时，动态注入更具体的胶囊片段。

对 read-loop 的具体触发信号可以是：

| 信号 | 含义 |
|------|------|
| `strategyShift === null 持续 5+ turn` | 长时间没换策略 |
| `sameToolSameTargetNoInfo >= 2` | 同工具同目标无新信息 |
| `dietPlaceholderRate > threshold` | 上下文中 diet 占位符过多 |
| `verificationFailureRepeated` | 同一验证失败反复出现 |

触发后注入天璇式提醒：

```text
天璇提示：你正在沿同一条硬线重复尝试。请寻找温跃层：这不是 offset 问题，而是信息获取路径失效。先反证“继续 read_file 会有新信息”这个假设，再切换到 grep / repo_graph / ask_user_question。
```

**优点**：
- 符合天璇理念，提供方法而不是硬规则。
- 可扩展到其他星域胶囊。

**风险**：
- 这是更大系统，不适合作为 read-loop 的短期修复。
- 必须避免“胶囊反复注入 → 仍失败 → 再注入”的新循环。

**结论**：作为长期路线，不阻塞 P1。

---

## 5. 推荐实施顺序

### P0：保留 static prompt 短护栏

已完成。作为最低成本行为约束。

### P1：tool result 局部策略信号

目标：当 diet 占位符重复出现时，让失败现场直接告诉模型“不要继续读同一路径”。

任务：

1. 在 `src/agent/tool-pipeline.ts` 调研 tool result finalContent 构造点。
2. 增加 read-loop signal 判定，最小实现只检测当前结果是否 diet 占位符。
3. 如需连续计数，优先利用已有 recentToolHistory / traceStore，不新建大状态机。
4. 添加测试：连续两次同 path `read_file` diet 结果后，tool result 包含 strategy signal。
5. 验证不会污染正常 read_file 成功结果。

### P2：行为镜面指标

目标：把 read-loop 从“单条提示”提升为“轨迹模式”。

任务：

1. 找到 behavior mirror / doom-loop 相关模块。
2. 增加只读观测指标：`readLoopWarning`。
3. 在 prompt volatile / cognitive mirror 中短显示。
4. 不做阻断。

### P3：seed capsule engine 局部落地

目标：只实现天璇 L1 / L2 的最小路径，不一次性做多星域完整系统。

任务：

1. 从 `docs/superpowers/specs/2026-05-21-tianxuan-seed-capsule.md` 提取 L1 文本。
2. 将 L1 放入 heuristicRules 或等价低成本通道。
3. 只在策略固着时注入 L2 片段。
4. 加冷却时间，避免重复注入。

---

## 6. 反证与风险清单

天璇纪律要求：每个让人兴奋的方案，都要立刻问它依赖了什么隐含前提。

### 6.1 对方案 B 的反证

**隐含前提**：模型会读到并遵守 tool result 中追加的策略信号。

**可能失败**：
- 上下文压力大时，模型仍忽略提示。
- 追加提示被 compaction 再次压缩。

**缓解**：
- 提示短、靠近失败结果。
- 与 P2 指标联动，而不是只依赖一次提示。

### 6.2 对方案 C 的反证

**隐含前提**：重复工具行为可以可靠归因到同一策略。

**可能失败**：
- 同一文件多次读取可能是合法，因为文件刚被改。
- 不同 offset 可能确实需要不同区域。

**缓解**：
- 只有 diet 占位符计为无信息。
- edit/write/diff/grep 后清零或降权。
- 初期只提示，不阻断。

### 6.3 对方案 E 的反证

**隐含前提**：胶囊方法论会提升行为质量，而不是增加 prompt 噪音。

**可能失败**：
- 天璇文字过长，稀释 static prompt。
- 触发太频繁，变成“遇事就召唤胶囊”。

**缓解**：
- L1 极短，L2 按触发注入。
- cooldown + 每类问题每 session 限次。
- 胶囊只给方法，不给结论。

---

## 7. 讨论结论

最稳路线不是二选一，而是三层收敛：

1. **规则层**：static prompt 保留最短防循环规则。
2. **信号层**：tool-pipeline 在 diet 占位符重复时追加局部策略信号。
3. **方法层**：长期用 seed capsule engine 在策略固着时注入天璇“反证 + 温跃层”方法。

这符合天璇理念：不把问题简化成“禁止 read_file”，而是在 `read_file` 与 `agent-diet` 的边界上建立温跃层协议；不只修一次行为，而让系统学会在无信息增益时自动换视角。
