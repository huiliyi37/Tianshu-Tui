# 主会话流程三缺陷 深度头脑风暴结果

> 日期：2026-05-29
> 方法：deep-brainstorm（变异 → 选择 → 适应）+ 5 scout 并行调研（4 本地三层 + 1 外部 + 1 定向反证）
> 关联：与"信心 0%"三张脸同构——`[[2026-05-29-expected-failure-confidence-zero]]`（信号源 ≠ 真实量）

## 背景

### 用户需求（原文）
查主会话流程里是否存在问题。两个具体症状：
1. 思考推理内容占一整屏然后渲染异常。
2. 引导对话发了之后卡住，按 ESC 撤销之后再发一条，后台还有之前发的对话。

派 5 个 scout 深入查。集成测试用户自行完成；本文档为诊断 + 验证路径，不含实现。

### 项目上下文
Ink 6 TUI + 流式 LLM agent / 单进程 / DeepSeek 优化（含中文宽字符）/ prefix-cache 神圣不可破（append-only，不改历史）。

### 核心诊断（一句话）
**用户描述的"这种主会话的问题"不是一类问题，是三个独立缺陷，恰好都被 ESC 取消路径串在一起，造成"同源"的错觉。** 定向反证 scout 用代码证据证伪了"单一根因"假设：修任一个对其他两个毫无作用，它们在不同抽象层（渲染 / 状态 / 传输）。

### 调研发现摘要（5 scout 交叉）
- **Scout1（渲染层）**：`ThinkingMessage`(static) 完全无字符级上限，且按 `\n` 逻辑行截断。`ThinkingCollapser`(live) 有 50k 字符 cap，static 路径没有。commit `abcaa9e` 只给 static 加了逻辑行 cap，没加字符 cap——这是"撕裂"。
- **Scout2（状态层）**：`steerBuffer.clear()` 在 abort/onAbort/onError/ESC/Ctrl-C 路径中**从不调用**。`abort()` 是 fire-and-forget；ESC 同步翻 `isStreaming=false`，与引擎 `onAbort` 回调竞态。
- **Scout3（传输层）**：三个 client 的 `fetch()` 都**没有 pre-first-byte 超时**——服务器接受连接但不回 header 时 fetch 永久挂起，`agent.run()` 永不返回。SSE 的 `if(done) break` 抢在 `if(streamTimedOut) throw` 前，超时 throw 是死代码。
- **Scout4（外部佐证）**：llxprt-code #968（取消不排空队列）= 缺陷②；gsd-2 #1414（abort 不发 agent_end，UI 永困 streaming）= 缺陷②③长期解；charmbracelet/lipgloss `height()` 只数 `\n` 是已知错误；CJK 若按 `.length` 测宽，物理行数差 ~2×（对中文 agent 最高危）。
- **Scout5（定向反证）**：证伪"单一根因"——见第二轮 P6。

## 三轮思考过程

### 第一轮：变异

```
[VARIATION]
生态位: Ink 6 TUI + 流式 LLM agent / 单进程 / DeepSeek 优化（含中文宽字符）/ prefix-cache 神圣不可破
选择压力: 用户能可靠中断、重发；流式内容不溢出屏幕；任何 turn 结束路径都有唯一信号
已占据: "abort + setIsStreaming(false)" 乐观 UI 翻转 / "useViewportLines 按逻辑行截断"
空位: 引擎确认的终止事件（UI await）/ 按物理行（cell-width）的高度测量

方案（竞争的根因模型 / 修复架构）:
  V1(主流): 单一原子 turn-end 权威——所有结束路径 funnel 进一个 handler，清 steerBuffer + 重置 controller + 发唯一 isStreaming 信号。把 A、B 当一个根因。
  V2(邻近): 分层独立修——承认 A(传输层缺 fetch 超时) 与 B(状态层 steerBuffer/session 不回滚) 正交，各自最小修。
  V3(空位): 物理行渲染契约——只修渲染：高度测量从 split('\n') 换成 string-width cell-width 物理行 + 动态区 overflow:hidden。
  V4(突变): 引擎确认的终止事件总线——抄 gsd-2 #1414：引擎每条终止路径无条件 emit turn-ended，UI 只在收到时离开 streaming，abort 返回可 await 的 promise。

创始假设: 用户假设"这种主会话的问题"是【一类】问题。counter-scout 证伪——撑屏(渲染)与卡住/幽灵(状态/传输)无共同机制。
适应度函数: 硬约束=不破 prefix cache（append-only）/ 加分=各修可独立验证、有测试 / 减分=大重构、跨层耦合、引入新竞态
```

### 第二轮：选择

**目标重注入**：用户要的是**诊断**（"是否存在问题"），不是立刻选修复方案。本轮淘汰**错误的根因模型**，留下**准确的问题划分**。

```
[SELECTION]
目标偏移: 无（都在回应"主会话有什么问题"）

因果测试:
  V1(单一原子权威): 断裂。counter-scout P6 代码证据证伪——"修 A(fetch 超时) 对 B 无作用；修 B(清 buffer/回滚 session) 对 A 无作用，两者触及不同模块、不同抽象层"。焊成一个根因 = 虚假因果（症状相邻 ≠ 同源）。
  V2(分层独立修): 通过且最硬。证据分层清晰（见下）。
  V3(物理行渲染): 通过但范围不全，只治撑屏，是 V2 的子集。
  V4(终止事件总线): 通过但成本失衡，能根治②但要重构状态机，与"不破 cache / 最小改动"摩擦大。

成本测试:
  V1: 中——根因模型错，会写出"统一 handler"却治不好 A，返工。负收益。
  V2: 低——三个独立最小修，各自可单测。
  V3: 低——只覆盖 1/3 症状。
  V4: 高——状态机重构，回归面大。

落地性测试（反高概念）:
  V1: 第一步="设计单一 turn-end 权威接口"，>3 前置且方向错。高概念寄生（"原子权威"听着深刻，实则逃避 A/B 不同层的事实）。
  V2: 第一步=给三个 client 的 fetch 加 AbortSignal.timeout → 立即可执行、可测。
  V3: 第一步=写 cell-width 物理行测量替换 split('\n') → 可执行。
  V4: 第一步="loop 每条终止路径 emit turn-ended" → 可执行但牵连 UI 状态机改造。

局部最优检测: V2 看似保守，但 counter-scout 证明它不是局部最优——是【正确的问题划分】。V1 的"统一"才是伪高峰（看着优雅，因果断裂）。

discarded_trait 回收:
  从 V1 回收: 「onAbort 是同时修 steerBuffer + session 回滚的天然单点」→ 嫁接 V2 状态层（不是"统一所有结束路径"，而是"onAbort/onError 这一条路径补齐清理"）。
  从 V4 回收: 「引擎确认的终止事件 / abort 返回可 await 的 promise」→ 标记 backlog，不进本次最小修；当前用已有的 onAbort 通路即可。

灭绝:
  V1 — 原因: 单一根因模型被代码证据证伪（P6=ASSUMPTION，最弱前提），强行统一会返工。
  V4 — 原因: 成本与"最小改动 / 不破 cache"失衡；核心洞察已被 V2 回收为 backlog。

存活:
  V2(强·正确的问题划分) / V3(中·被 V2 吸收为渲染层分支)

最强竞争者: V2 — 它不"修方案"，它【正确地把一类报告拆成三个独立 bug】，每个有 file:line 事实支撑、可独立验证。

新发现（第二轮才看到的深层问题）:
  1. 症状②"卡住"可能是【两个不同 bug 叠加】: (a) fetch 永久挂起(真·无限卡)，或 (b) 静默 continue-cascade / 45-120s SSE 超时延迟(看起来卡，实则会恢复)。感知一样，根因不同。
  2. 症状②"幽灵重发"真机制(P3): 不是两个并发 run（promptQueueRef + _running 双 guard 都生效=FACT），是【同一个旧 run() abort 没真停 + steerBuffer 残留被下一个 run drain 进去】。不是并发，是泄漏 + 脏 buffer。
  3. 中文宽字符是症状①最高危放大器: 高度测量按 .length 而非 cell-width，中文行物理行数差 ~2×。
```

#### 第二轮证据分层（counter-scout P1–P6）

| 前提 | 分类 | 证据（file:line） |
|------|------|------|
| P1 steerBuffer 永不清 | **FACT** | `steer-buffer.ts:39` clear() 定义；全库仅 `__tests__/steer-buffer.test.ts:43,59` 调用；`app.tsx` onAbort(1069-1103)/onError(1033-1068)/ESC(449-461)/Ctrl-C(420-425) 均不调 |
| P2 isStreaming 乐观翻转 | **FACT** | ESC `app.tsx:453` 同步 setIsStreaming(false)；引擎 onAbort `app.tsx:1090` 又设一次 → 竞态：UI 先翻 false，用户重发设 true，旧引擎 onAbort 再设 false 闪烁新 run |
| P3 无并发 run | **FACT**（反而强化②非并发） | UI guard `app.tsx:1137-1146` + 引擎 guard `loop.ts:955-968` 双层。幽灵 = 旧 run 泄漏，非新并发 |
| P4 steer 注入目标 | drain → `tool-execution.ts:231` / `app.tsx:991` | 注入当前 in-flight turn 的 tool 边界；abort 后残留被下一 run drain |
| P5 无 fetch pre-byte 超时 | **FACT** | openai/anthropic/codex client 的 fetch 均无 AbortSignal.timeout；idle timer 仅在 fetch resolve 后起 |
| P6 两 bug 同源 | **ASSUMPTION（证伪）** | 修 A(fetch 超时) 对 B 无作用，修 B(清 buffer/session 回滚) 对 A 无作用；不同模块不同层。最弱前提，若 P3 为假才会动摇——但 P3=FACT |

### 第三轮：适应

```
[ADAPTATION]
套路清除: 清除"主会话问题=一个系统性根因"的咨询报告式套路。真相是三个独立 bug 恰好共享 ESC 触发路径。

扩展适应（已有资源新用途 + discarded_trait 吸收）:
  - 已有 onAbort/onError 回调(app.tsx:1069-1103) 已在清 toolAccum/dirtyTools——把"清 steerBuffer + session 回滚"挂这条已存在通路，零新基础设施（吸收 V1 trait，不搞统一权威）。
  - 已有 abortController.signal 已传进 fetch——只需 fetch init 加 signal: AbortSignal.any([userSignal, AbortSignal.timeout(N)])，复用现有 signal 管道。
  - 已有 viewport.ts useViewportLines 框架——内部测量从 split('\n') 换 cell-width 物理行，调用点不变。

具体化（人-场-动-果）见下方"三缺陷详表"。

收敛验证: V2(分层) 与 V3(渲染) 收敛到同一洞察——【按逻辑行而非物理行处理是系统性错误】(缺陷① split('\n')) 与【按"症状相邻"而非"机制同源"归类是系统性错误】(缺陷②③不同层)。两收敛点都指向"信号源 ≠ 真实量"，与"信心 0%"三张脸同构。定为核心真相。

最强适应点: 三个修完全正交、各自可独立单测、都复用已有通路，不破 prefix cache。
脆弱点:
  - 缺陷①依赖 Ink <Static> 是否真受高度约束（Scout1: Static 无父级高度约束）。若 cap 在 Static 内无效 → 改成"完成块进 Static 前先 cell-width 硬截断"。Phase 1 退出条件已覆盖。
  - 缺陷③超时阈值 N 太短会误杀慢首字节的合法长请求（reasoning 模型首字节可能很慢）→ pre-byte 超时(45s) 与 idle 超时(120s) 分开，别用同一值。
```

## 最终方案：三个独立缺陷

主会话不存在"一个"问题。三个独立缺陷被同一 ESC 触发路径串成"同源"错觉。

### 三缺陷详表

| | 层 | 性质 | 机制（file:line） | 可衡量成功标准 |
|---|---|---|---|---|
| **① 思考块撑屏** | 渲染 | 现状·可改 | `thinking-message.tsx:24-35` 按 split('\n') 数逻辑行、**无字符 cap**。单条 8000 字无换行行=1 逻辑行通过 cap，软换行后 ~125 物理行撑屏；`ThinkingCollapser`(live) 有 50k cap，static 没有 | 任意 thinking 块渲染物理行 ≤ floor(rows×0.4)，中文按 2 cell 计 |
| **② 取消后幽灵重发** | 状态 | **FACT** | `steerBuffer.clear()`(steer-buffer.ts:39) 全库仅测试调；onAbort(app.tsx:1069) 清了一堆 tool 状态但漏 steerBuffer；下一 run 在 tool 边界 drain 出旧 steer。**非并发 run**（双 guard 生效），是泄漏+脏 buffer | ESC/Ctrl-C 后 steerBuffer.length===0；被弃 user message 回滚（当前 `SessionContext` 无 removeUserMessage，context.ts:85） |
| **③ turn 永久挂起** | 传输 | **FACT** | 三 client 的 fetch() **无 pre-first-byte 超时**（服务器不回 header 即永挂，agent.run 永不返回）；SSE `if(done)break` 抢在 `if(streamTimedOut)throw` 前，超时 throw 成死代码 | 任何请求 N 秒内必得 resolve/reject 之一；SSE 超时真 throw 而非静默空 turn |

### 一个反直觉点
症状②"卡住"本身可能是**两个不同 bug 叠加**：真·无限卡（缺陷③ fetch 挂起）+ "看起来卡其实 45-120s 后恢复"（SSE 静默超时 / continue-cascade）。用户感知一样，根因不同。

## 风险与应对

| 风险 | 应对 |
|------|------|
| 缺陷①：Ink `<Static>` 无父级高度约束，cap 可能无效 | Phase 1 退出条件：转"进 Static 前 cell-width 硬截断"（Scout4 模式） |
| 缺陷③：超时太短误杀慢首字节合法请求 | pre-byte(45s) 与 idle(120s) 分两个值 |
| 缺陷②：session 回滚需新增 removeUserMessage，可能破 append-only cache | 回滚仅作用于"从未发出/已 abort"的最后一条 user，不触碰已缓存前缀 |
| 缺陷①中文宽字符 | 测量必须 string-width（CJK=2 cell），禁用 `.length` |

## 下一步（验证路径，非实现 — 集成测试由用户完成）

- **Phase 1（缺陷①）**：thinking-message.tsx 加 cell-width 物理行测量。喂 8000 字无换行 thinking + 等长中文，断言物理行 ≤ cap。退出条件：Static cap 无效则转硬截断。
- **Phase 2（缺陷②）**：onAbort/onError 加 `steerBuffer.current.clear()`；加 `SessionContext.removeUserMessage` 并在 abort 回滚最后一条 user。成功：ESC 后 steerBuffer.length===0 且 session 不含被弃 msg。
- **Phase 3（缺陷③）**：三 client fetch 加 AbortSignal.timeout；修 SSE done/throw 顺序。成功：mock 不回 header 的 server，断言 N 秒内 reject。

三个 Phase 互不依赖，可任意顺序、独立验证。

## Scout 证据来源
- 本地：`src/tui/{thinking-message,thinking,stream,stream-window,viewport,steer-buffer,app,input,base-text-input}.tsx/.ts`、`src/agent/{loop,tool-execution,turn-*}.ts`、`src/api/{openai,anthropic,codex}-client.ts`
- 外部：llxprt-code #968（取消不排空队列）、gsd-2 #1414（abort 不发 agent_end）、charmbracelet/lipgloss `height()` 只数 `\n`、Ink Static/dynamic 区分、string-width CJK cell 宽度


