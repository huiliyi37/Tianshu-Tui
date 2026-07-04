# 主控工作流提效与质量 — 三个未覆盖缺口

> **状态：已实施（2026-07-04，瑶光执行，含核查修正与第四缺口）。**
> 原三个提案 + 核查中补充的缺口 D（maxTurns 预算预警）全部落地。
> 实现细节并入 `2026-07-04-advisory-lifecycle-design.md` 的
> 「主控工作流四缺口」节。以下原调研内容保留存档；与实现的偏差见
> 文末「实施记录与核查修正」。

---

## 背景

三份已落地/落地中的计划覆盖了：
1. **星域提醒智能化** — advisory 的回读闭环、打断调度、异步副驾合成
2. **星域改道胶囊重设计** — CCR 触发面修复、胶囊召回复活、信道预算独立
3. **因果账本演进** — 反事实 lift 度量、跨会话效能信息素、破坏性命令 pre-exec gate

这三个计划的核心关注点是"agent 收到的提醒更聪明、更精准"。但主控工作流本身
（agent loop / tool pipeline / turn orchestration）仍有三个与提醒质量正交的效率
和质量缺口。以下逐一展开。

---

## 缺口 A — 死路快速检测（Dead End Fast Detection）

### 问题

convergence-detector 管"工具调用模式重复"（A→B→A→B 振荡、同工具连续调用），
但不区分"模式重复"和**同文件连败**——模型对文件 A 做编辑 → 验证红 → 再次编辑
同一文件 → 再红 → 第三次尝试。这不只是收敛问题：方向本身不可行，继续修补细节
只会浪费 turns。

### 信号

完全客观，无需 NLP 判断：
- 同一文件（argsHash 中的 file_path）在最近 4 个工具调用窗口内出现 ≥2 次失败编辑
  （`failureClass` 为 `type_error` 或 `assertion`）
- 中间无成功的验证结果（run_tests 或 tsc --noEmit 均 exit≠0）
- 触发时不依赖 phase——在 execute 和 verify 阶段都可能发生

### 干预

postTool hook：命中后通过 AdvisoryBus 提交一条 `operational` tier 条目，内容指向
方向级判断而非代码级修改——"该文件连续编辑均未通过验证，当前实现路径可能不可行。
考虑：(1) 回退改动，换方案；(2) 拆分为更小的独立步骤逐个验证。"

### 与现有系统的边界

- **不是 convergence**：不管多轮模式，只管单文件短窗口内的失败密度
- **不是 exploration-stall**：不关心只读循环
- **不是 D-gate**：D-gate 在工具执行**前**拦截破坏性命令；这个在工具执行**后**
  检测编辑质量模式。两者互补：D-gate 管"不该做的事"，这个管"做了但无效的事"

### 实现要点

- 纯函数 `detectDeadEnd(history, evidence)` → `{ deadEnd: boolean, filePath: string, failCount: number }`
- 放在 `src/agent/hooks/dead-end-detector.ts`，可被 hook 和 convergence 双消费
- 误报控制：排除环境类失败（timeout / api_error 不算死路）、排除当轮刚成功的文件

---

## 缺口 B — 工具输出噪声裁剪（Tool Output Sanitization）

### 问题

工具输出直接进入会话历史，大量内容是上下文噪声：npm install 的 spinner、
test runner 的 ANSI 转义码、tsc 的 "Found N errors" 统计行和后续空行。
这些字节计入 input tokens 但在模型 attention 中信息量接近零。

### 已有基础设施

`turn-stream.ts` 的 `streamRules` / `DEFAULT_STREAM_RULES` 已对 API 流做实时规则
过滤。同样的"规则 → 匹配 → 裁剪"模式可应用到工具结果。

### 方案

`tool-pipeline.ts` 的 `executeBatch` 返回结果后、`addToolResults` 存入 session
历史之前，过一个 `sanitizeToolOutput(toolName, content)` 函数。

**白名单规则**（按 toolName + content 特征匹配，非正则扫描原始内容）：
- `bash` 含 `npm install`：去掉前 3 行（npm 版本/进度/计时 header），保留安装
  摘要和结果
- `bash` 含 `tsc --noEmit`：只保留含 `error TS` 的行和最后一行 "Found N errors"
- `bash` 含 `node --test`：只保留 FAIL 行和最终统计行（"ℹ tests N / pass / fail"）
- `run_tests`：去掉 ANSI 转义码序列（复用已有的 stripAnsi 逻辑）
- 以上所有：当裁剪后内容为空时，保留最小摘要行（如 "All tests passed" 或
  "N errors found"）

### 预期效果

中等规模的工具调用（npm install + tsc + node --test）可节省 20-40% 的上下文碎片。
不是节省 API 费用——节省的是模型 attention 的信息密度：每条消息里的有效信息占比
更高。

### 实现要点

- 放在 `src/tools/output-sanitizer.ts`，纯函数，可注入（测试确定性）
- 默认开启，`RIVET_OUTPUT_SANITIZE=0` 关闭
- 裁剪后附加一行 `[output trimmed: N bytes of noise removed]` 方便排查

---

## 缺口 C — 长会话意图锚点（Intent Anchor Checkpoint）

### 问题

30+ 轮会话中，初始用户消息已被压缩推到上下文远端。模型的工作记忆完全由后续
turns 重建，一个自然的失效模式：第 25 轮做的事情在技术上合理，但方向已经偏离
用户原始意图——因为原始意图在压缩中被简化成了一句脱离原始语境的摘要。

### 信号

纯结构信号，不作 NLP 判断：
- 会话轮次 > `INTENT_ANCHOR_THRESHOLD`（默认 20）
- 用户最近一次发言距今 > `INTENT_ANCHOR_STALE` 轮（默认 10）
- 两条同时满足 → 触发

### 干预

preTurn hook：从 `this.initialUserMessage`（AgentLoop 已有字段，会话常量）
抽取核心任务描述和关键约束（截断到 ~500 字符），作为一条 `informational` tier
advisory 注入下一轮上下文。不判断"是否偏离"——只是提醒模型"这是你最初被要求
做的事"，让模型自己判断。

内容格式：
```
【天枢】意图锚点 — 你最初被要求做的是：
{截断的 initialUserMessage}
会话已进行 {turnCount} 轮。确认当前方向仍与原始意图一致。
```

### 不依赖 NLP

不判断"是否偏离"，不分析"当前在做什么"。就是一个结构化的"还记得最初的目标吗"
——零误报，零概念歧义。

### 实现要点

- 放在 `src/agent/hooks/intent-anchor-hook.ts`，preTurn phase
- 阈值通过 env var 配置：`RIVET_INTENT_ANCHOR_TURNS`（默认 20）、
  `RIVET_INTENT_ANCHOR_STALE`（默认 10）
- COOLDOWN：触发后至少间隔 `INTENT_ANCHOR_THRESHOLD / 2` 轮不再触发
- initialUserMessage 来源：`AgentLoop.initialUserMessage`（loop.ts:410，已在
  会话创建时记录）

---

## 三者关系

```
                 ┌─────────────────────────┐
                 │   turn orchestration    │
                 └───────────┬─────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   ┌─────────┐        ┌──────────┐        ┌──────────────┐
   │ 缺口 A  │        │  缺口 B  │        │   缺口 C     │
   │ 死路检测 │        │ 噪声裁剪 │        │  意图锚点    │
   └────┬────┘        └────┬─────┘        └──────┬───────┘
        │                  │                     │
   postTool           tool-pipeline          preTurn
   (编辑后)           (结果存入前)           (每轮开始)
        │                  │                     │
        ▼                  ▼                     ▼
   少做无效改动       同等信息用更          长会话不偏离
                     少 tokens 传递        原始意图
```

三个不重叠：A 管编辑质量、B 管 token 效率、C 管长会话可靠性。都是单次注入
（不创建持续状态）、可独立开关、与 advisory 三计划无耦合。

---

## 与已落地计划的差异

| 维度 | 已落地三计划 | 本提案 |
|------|------------|--------|
| 关注层 | 提醒质量（内容/时机/度量） | 工作流质量（执行/效率/方向） |
| 主要机制 | AdvisoryBus + hook | 工具管线 + hook |
| 是否依赖 NLP | 部分依赖（副驾合成） | 完全不依赖 |
| 评估方式 | 采纳率 lift | 死路次数 / token 密度 / 偏离频率 |

---

## 实施记录与核查修正（2026-07-04）

四个缺口全部落地。实施前的代码核查发现原提案三处与真实管线不符，
均已按修正版实现：

### 修正 1 — 缺口 A 信号 bug

原提案信号是"同一文件 ≥2 次**失败编辑**（failureClass 为 type_error/assertion）"。
核查发现编辑工具本身几乎不失败——写盘成功但语义错误的失败挂在**验证**路径
（`classifyFailure` 在 tool-pipeline 的验证失败分支）。信号改为：
**同一文件 edit→verify-fail 循环 ≥2 次且中间无一次 verify pass**。
这才是"盲改"的客观签名。实现 `src/agent/hooks/dead-end-detector.ts`：
editPending 消费制（一次验证失败对同文件只记一次循环）、verify pass 全清、
timeout/env_missing 排除（与 2026-07-02 stigmergy dead-end 收紧同判据）、
触发一次性。触发时同步沉积文件级 dead-end 信息素（跨会话经 signal-consumer
复用）。**advisory 出生即带 `tool_appears`（诊断类工具, 2 轮）expect 谓词**
——采纳 = 停止盲改转向诊断，自动进 holdout lift 与跨会话效能信息素。

### 修正 2 — 缺口 B 顺序约束

原提案说"executeBatch 返回结果后过 sanitize"——遗漏关键约束：裁剪必须在
失败分类器（`classifyFailure`/`classifyTestRun`）、修复提示、artifact 拦截、
lossy guard **之后**，否则分类器会在裁剪版上失效。统一接线点是
`tool-execution.ts` 的 `addToolResults` 边界（session 只存裁剪版，UI 回调
在此之前已收到全文）。实现 `src/tools/output-sanitizer.ts` 纯函数：
tsc（留 error TS + Found N errors）、node/tsx --test（裁逐条 ✔ 通过行，
失败诊断全保留）、npm install（去 timing/http/spinner 噪声）、run_tests
（剥 ANSI）；裁空保底一行摘要，收益 < 200 bytes 不替换，尾附
`[output trimmed: N bytes]`。遥测 `output-sanitize` kind 每批计 bytes。
已核实无谓词消费方受影响（readback pattern_absent 读文件、dedup-guard
用流式文本）。

### 修正 3 — 缺口 C 前提修正

原提案说 initialUserMessage 是"会话常量"。核查发现它**每次 run 重置**
（turn-step-producer 的 initializeRun），锚点语义修正为"**本次 run** 的
启动意图"；意图源复合 `taskContract?.objective ?? initialUserMessage`
（照 loop-factory getObjective 先例），截 500 字。信号也改为 run 内轮数
（新增 `AgentLoop.runLoopTurn`，orchestrator 循环顶部更新）+ 距上次用户
输入轮数（`lastUserInputRunTurn`，steer 注入时更新）。无行为签名 → 无
expect，只计送达；informational tier 受阶段抑制可推迟，可接受。

### 补充 — 缺口 D：maxTurns 预算预警

核查中发现的第四缺口：maxTurns 耗尽是 GUARD-forced stop（turn-orchestrator
硬切），模型自身看不到预算。实现 `src/agent/hooks/turn-budget-hook.ts`
（preTurn）：剩余轮数 ≤ max(3, ceil(maxTurns×10%)) 时预警一次/run，内容
引导收敛（验证交付已完成部分/落 checkpoint）。**expect =
`verify_attempted`（2 轮）**——采纳 = 预警后先验证手头工作。

### 统一原则

接因果账本一轮的经验：**新 advisory 出生即可测**。A/D 带 expect 谓词，
自动进 holdout 反事实抽样与跨会话效能信息素；C 无行为签名，诚实地只计
送达，不发明伪谓词。

### 开关与注册

| 缺口 | 开关（默认全开） | 注册点 |
|------|----------------|--------|
| A | `RIVET_DEAD_END_DETECTOR=0` 关 | create-runtime-hooks（postTool） |
| B | `RIVET_OUTPUT_SANITIZE=0` 关 | tool-execution addToolResults 边界 |
| C | `RIVET_INTENT_ANCHOR=0` 关；`RIVET_INTENT_ANCHOR_TURNS`/`_STALE` 调阈值 | create-runtime-hooks（preTurn） |
| D | `RIVET_TURN_BUDGET_WARN=0` 关 | create-runtime-hooks（preTurn） |

### 验证

38 项新单测全绿（sanitizer 9 / dead-end 10 / intent-anchor 8 / turn-budget 6
/ 回归其余）；advisory 全家桶 + tool-pipeline 回归通过；typecheck 除
delivery-gate 预存基线外干净。loop-factory / tool-execution-abort 的既有
失败经 stash 基线比对确认为并发会话预存问题（缺 mock），与本次无关。
