# Goal 中断问题交接文档

> **状态**：已定位根因，待修复。下个会话处理。
> **发现日期**：2026-06-19
> **发现会话**：c3adbcb1（文曲域 goal 测试，审查门优化任务）

---

## 问题描述

使用 `/goal` 模式执行长线任务时，agent 会在运行中途被 `⏹ Interrupted` 中断，
用户没有按 Esc/Ctrl+C。中断后 agent 停止工作，需要手动发"继续"才能恢复。

## 已确认的两个独立问题

### 问题 1：Reliability Mode 误触发（P0，已定位）

**根因**：`src/agent/trace-store.ts` 的 `offendingFingerprints()` 函数，
window=8, freqThreshold=6, consecThreshold=3。

在 goal 长任务里，agent 自然会连续使用同类工具（如多次 `grep` 搜索不同 pattern、
多次 `read_file` 读取不同文件段）。doom loop 检测器的 `fingerprintToolClass`
把同类工具的不同参数归并为同一 classFp——当 8 个窗口内有 6 次同类调用时，
即使每次参数不同，也触发 `doomLevel = 'blocked'`。

**触发证据**：session JSONL `[166]`：
```
Tool execution blocked by reliability mode: degraded
Tool: bash
Reason: Same tool call is failing repeatedly — strategy may need to change
Evidence: Doom loop blocked: same tool/fingerprint repeated to threshold
```

**影响**：bash 工具被降级阻止，agent 被迫改用 read_file/grep 绕过。
虽然 agent 能恢复，但浪费了若干轮 token。

**建议修法**：
- 方案 A：在 `offendingFingerprints` 或 `getDoomLoopLevel` 的调用处传入 `goalActive` 标志，
  active 时放宽阈值（freqThreshold 6→12, consecThreshold 3→5）
- 方案 B：在 `fingerprintToolClass` 里，对 grep/read_file 这类探索性工具不做 class 归并
  （只归并 bash 的 sed/head 变体，不归并不同 pattern 的 grep）

**涉及文件**：
- `src/agent/trace-store.ts` — `offendingFingerprints()` 参数化
- `src/agent/tool-pipeline.ts:611` — `getDoomLoopLevel()` 调用处
- `src/agent/goal-tracker.ts` — 需要暴露 `isActive()` 给 tool-pipeline 读取

### 问题 2：心跳看门狗误 abort 健康忙碌的 turn（P1，✅ 已复现确认 2026-06-24，会话 d53172f8）

**结论**：交接时的"可能原因 1 + 2"合体被证实——心跳硬停看门狗（hardStall）是触发器，
而它之所以变成用户可见的 `⏹ Interrupted` 且不自动恢复，是因为看门狗 abort 与用户 Ctrl+C
**翻转同一个 `abortController`**，下游无法区分，UI 一律渲染成用户中断。

**取证现场**（会话 `d53172f8-915f-43f2-82b5-eb78519afd96`，model `glm-5.2`，域 tianliang，
任务"criteria 提取硬化"）：
- `.meta.json`：`cleanExit:false`、`status:active`、turnCount 2 但 toolCallCount **78**、
  会话时长 23.4min。
- transcript 最后一行是 assistant 发起 `bash npx tsc --noEmit`，**无对应 tool_result** → 断点在其后。
- `cache-log.jsonl` 最后一轮（内部轮 33）`cacheRead:0 / hitRate:0.0%` → 前缀缓存整个失效，
  即**刚发生一次历史重写（压缩 / appendix baseline reset）**。
- 所有被记录的 API 轮次间隔 4–54s（最大 54.4s），**无一轮触及 240s** → 240s 停顿不在 API 轮内，
  而在轮间那段**不上报的 turn-boundary 盲区**里（压缩/prewarm/perception + 冷缓存 GLM 重编码 TTFT）。

**机制链路**（已钉到代码）：
1. `src/agent/turn-step-producer.ts:101` 装的 `TurnHeartbeat` `hardStallMs: 240_000`，
   静默超 240s → `onHardStall` → `loop.abortStalledTurn()`。
2. `src/agent/loop.ts:640` `abortStalledTurn()` 仅 `abortController.abort()`——与用户 `abort()`
   翻转同一信号。它特意**不**自增 `_turnInterruptCount`，但该计数器只喂内部
   `classifyRecoveryTrigger`/可靠性判定，**对 UI 无影响**。
3. `src/agent/turn-orchestrator.ts` 多处 `if (signal?.aborted) callbacks.onAbort()` →
   TUI `onAbort: () => handleAbort()` → `src/tui/engine/app.ts:1796` 渲染 `⏹ Interrupted`。

**根因一句话**：看门狗只用"UI 事件静默时长"当唯一活性信号，整个 turn 里 `agentBusy=true`
但边界操作真在干活却不发 UI 事件；看门狗把"静默"误判为"楔死"，abort 掉一个健康忙碌的 agent，
且因复用用户 abort 信号而被误显示成用户中断、不自动续跑。

**修复方向**（推荐 1+3 组合）：
1. **边界操作显式 tick/豁免**：压缩、prewarm、perception、冷缓存重编码进入时
   `heartbeat.tick('compacting…')` 或临时 `pause()`，消除盲区静默（治本，副作用最小）。
2. **真实活性信号**：SSE 仍有字节、子进程存活、压缩 future 未 settle 时看门狗不开火
   ——把"无 UI 事件"换成"无任何底层进度"。
3. **抬阈值 + 区分渲染**：240s 对 GLM 大上下文偏紧；看门狗 abort 走独立 reason，
   UI 显示"⟳ 自动恢复中（边界停顿）"而非 `⏹ Interrupted`，goal/普通模式自动续跑而非等用户敲"继续"。

**✅ 修复实现进度（2026-06-24）**：
- `f64f47b6`：方向 1 的边界 tick（compaction/prewarm/perception/build-request 前各 tick）
  + 方向 3 全套（`_watchdogAborted` 标记 + `getAbortReason` 编码 `watchdog`/`watchdog:goal`
  + `onAbort(reason)` 透传 + UI 渲染"⟳ Auto-recovering (boundary stall)" + goal 模式自动续跑）
  + goal-aware reliability（goalActive 时 doom_loop 不降级）。`TurnHeartbeat` 增 `pause()/resume()`。
- `b7bf11ed`：补 reliability-mode goalActive + heartbeat pause/resume 单测。
- **stream 阶段 disarm（本次收束，supersedes 早先的 pause 思路）**：定位到边界 tick
  **不足以覆盖 d53172f8 的真正盲区**——>240s 静默不在边界 op（它们各有 ~30s 内部超时），
  而在**流式首 token 前的冷重编码 TTFT**。给 `TurnHeartbeat` 加 `disarmWatchdog()/rearmWatchdog()`：
  **只挂起 hardStall abort、保留信息性 beat**。`turn-orchestrator.ts` 在 `streamOnce` 外层
  `disarmWatchdog()` + `finally rearmWatchdog()`。disarm 标记不被 `tick()` 重置，所以 `onStreamStart`
  的 `onPhaseChange('working')` tick **不会重新武装** hardStall——早先 pause 方案被这个 tick 打脸、
  才需要在 onStreamStart 里二次 pause 的 hack，现已删除。冷 TTFT 期间 UI 仍逐 N 秒滚动
  "still working — waiting for first token"，但 hardStall 不会误触发；in-stream 真卡死由
  SSE/provider idle + thinking-stall 超时兜底。

**本次收束的残留修复**：
- ✅ **保留 beat**：disarm 取代 pause，冷 TTFT 期间不再丢"still working" beat（早先列为残留）。
- ✅ **reason 编码统一**：抽 `AgentLoop.abortReason()` 为唯一真源，`loop-factory.getAbortReason`
  与 `turn-step-producer.ts:314` 共用——后者过去只发 `'watchdog'`、永不 `'watchdog:goal'`，
  现已修正，该点捕获的 goal 模式 watchdog abort 也会自动续跑。
- ✅ **bridge 透传 reason**：`bridge.ts` 的 `onAbort` 旧实现签名是 `() =>`，把 reason 整个吞了——
  意味着 `watchdog:goal` 经 bridge 后退化成 `undefined`，**整条自动恢复链此前根本没生效**。
  改为 `(reason) => app.callbacks.onAbort(reason)` 后才真正打通。
- ✅ **自动续跑护栏**：`app.ts` 加 `_watchdogAutoContinues` 计数，连续 watchdog:goal abort 超
  `MAX_WATCHDOG_AUTO_CONTINUES=3`（无中间进度）就停手、显示"⏹ Stalled repeatedly — auto-recovery
  paused"。真完成一轮 turn 或用户提交即清零，恢复完整续跑预算。

**残留（未做 / 取舍）**：
- stream disarm 接线**无集成测试**（全 `processTurn` 循环需 mock 整条工具流水线，成本不成比例；
  `disarm/rearm` 原语 + 自动续跑 cap 已分别由 `turn-heartbeat.test.ts` / `abort-resubmit.test.ts` 单测覆盖）。
- ⚠️ **当前仓库 typecheck 基线被其它会话的提交污染**（meridian/review/star-domain：`953580b5`/
  `53e1e4a8`/`63a75717`/`b4dbf5de`/`ec30416f` 等引入 ~20 处 TS 错误，均不在本次改动文件内）。本次改动
  9 个文件 typecheck 干净，但 `npm run typecheck` 全量不再绿——需另开会话清理那批基线错误。

**涉及文件**：
- `src/agent/turn-heartbeat.ts` — `hardStallMs`/`onHardStall` 语义与阈值
- `src/agent/turn-step-producer.ts:101` — 看门狗装配处（盲区 tick/pause 的接入点）
- `src/agent/loop.ts:640` — `abortStalledTurn()`（与用户 abort 的信号区分）
- `src/agent/turn-orchestrator.ts` — `signal.aborted → onAbort` 分支
- `src/tui/engine/app.ts:1770` — `handleAbort()` / `⏹ Interrupted` 渲染（独立 reason 渲染）

## 时间线重建（c3adbcb1 session）

| JSONL entry | 事件 |
|-------------|------|
| [0] | `/goal` 激活，goal tracker active |
| [155-162] | agent 成功修改 deliver-task.ts, goal-tracker.ts, slash-commands.ts |
| [163] | agent 开始读 bootstrap.ts 找接线点 |
| [165] | agent 尝试 bash 命令 |
| [166] | **bash 被 reliability mode 阻止**（doom loop 误触发）|
| [167-174] | agent 改用 read_file/grep 绕过，继续搜索 bootstrap.ts |
| [175-198] | agent 成功用 hash_edit 修改 bootstrap.ts，继续推进 |
| (中断点) | `⏹ Interrupted` 出现，具体触发路径待确认 |

## 本次会话的产出汇总

### 已提交的 commits（本会话产出）

| Commit | 内容 |
|--------|------|
| `687fb7e2` | fix(prompt): cover all history-rewrite paths with resetAppendixBaseline |
| `eb56acae` | feat(prompt): add projection/appendix byte sizes to cache-log |
| `9074ca71` | fix(goal): add Chinese completion markers + contextWindow-scaled maxIterations |
| `1d55bd95` | fix(tools): default-on RIVET_READ_REF (opt-out with =0) |

### 文曲域会话产出的 commits（c3adbcb1）

| Commit | 内容 |
|--------|------|
| `178e3b46` | feat(agent): add GoalTracker for turn-loop goal continuation |
| `b61c98a1` | feat(agent): wire GoalTracker into TurnOrchestrator |
| `0c874828` | feat(agent): wire AgentLoop.setGoalTracker to TurnOrchestrator |
| `51b6c1c5` | feat(tui): add /goal and /cancel-goal commands |
| `4933ac92` | docs(plan): revise goal-auto-continue plan |
| `aedca12e` | feat(tools): add command-aware output filter for bash tool |
| `4f568f83` | feat(agent): add goal-aware review gating for deliver_task |

### 数据验证结果

| 指标 | delta OFF (fe39a8ee) | delta ON (0fefc90b) | read-ref ON (c3adbcb1) |
|------|---------------------|---------------------|------------------------|
| 轮数 | 27 | 94 | 39 |
| 每轮均 cacheCreate | 4,516 | 1,361 (-70%) | 1,055 (-77%) |
| 稳态中位数 | 1,215 | 165 (-86%) | 328 |
| Read-ref 命中 | 0 | 0 | 348 次 / 2.14M bytes |
| 最终 context | 22% of 1M | 22% of 1M | **5.8% of 1M** |
| 恒等式通过率 | 100% | 100% | 100% |
