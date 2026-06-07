# 天枢改造：对抗式 Verifier + Cron 租约锁（借鉴 Claude Code）

> 日期：2026-06-06
> 状态：设计稿（已修订 — 2026-06-06 双任务系统主权裁定后修正）
> 触发：Claude Code 工作流对照调研，两条最高价值借鉴落地。
> 背景依据：`docs/research/2026-06-06-claude-code-workflow-comparison.md`（含全部 CC 代码锚点与对比表）
> 关联：[[standing-collaborator-ingress-spec]]、姊妹 task-lifecycle spec `2026-06-06-task-lifecycle-system-design.md`、[[cache-aware-fusion-spec]]
> **修订记录**：原案改造二落点为「扩展 nightcrawler」，经双任务系统主权裁定（见姊妹 spec B 文末）推翻——nightcrawler 是 per-AgentLoop 的 P3-F 认知子系统，受 §0 保护，不可承载 daemon 级 cron/租约锁。改造二已重写为 server 层独立 cron-scheduler + cron-lock，本节为最终正式版。

---

## 0. 定位与边界

两条改造**均为基础设施/编排层**，不碰认知本体（遵继承自 [[cognitive-pipeline-is-substrate-not-feature]] 的 §0 公理）。两者正交，可独立实施：

- **改造一（对抗式 Verifier）**：把天枢现有协作式 verifier 升级为独立对抗式验证者，根除"实现者自评"偏置。嫁接到现有 profile-registry + work-order + worker-evidence，**无新子系统**。
- **改造二（Cron 租约锁）**：在 **server 层**新建 cron-scheduler（持久化 schedule 表 + 时间触发 tick）+ cron-lock（PID 租约锁 + 多会话单调度器选举），触发后走 TaskRegistry → runtime 池 → AgentLoop 执行。**不碰 agent 层的 nightcrawler**。填 task-lifecycle spec §2.2 的 scheduler 空白。

**架构边界**（来自双任务系统主权裁定）：
- server 层（cron-scheduler / cron-lock / TaskRegistry）不 import agent 层内部模块
- agent 层（nightcrawler / P3Integration）不知道 server 层的存在
- cron 执行路径：cron-scheduler 触发 → TaskRegistry.createTask → 分配 pooled runtime → 启动 AgentLoop（自带 maxTurns + AbortSignal + TurnHeartbeat）。nightcrawler 不在路径上

**不照搬**：CC 的验证合同是 ant-only A/B 门控（背景文档 §0 caveat），我们取其**设计**而非其门控复杂度，做天枢最小可行版。

---

## 1. 改造一：对抗式 Verifier

### 1.1 缺口（代码级核实）

天枢现有 verifier profile 是**协作式**，不是对抗式：

```
profile-registry.ts:74-79
  name: 'verifier', role: 'hands', allowedTools: [...WRITE_TOOLS]
  // WRITE_TOOLS = READ_ONLY + edit_file/write_file/bash/run_tests
  expertisePrompt: "You are a verifier. ... You may write and edit test files."
```

问题三条（对照 CC `verificationAgent.ts:10-152`）：
1. **能写源码**：`role:'hands'` + 完整 WRITE_TOOLS（含 `edit_file`/`write_file`），验证者可改被验对象 → 自证循环。CC 明确剥夺 Edit/Write。
2. **协作式语气**："verify changes work correctly" 是确认导向；CC 是"你的任务是**试图破坏它**"。
3. **无证据强制 / 无独立性约束**：evidenceStatus='verified' 当前可由任何 hands worker（含实现者 patcher）的 worker-evidence 流程写入（`worker-evidence.ts:32,43` 只读字段不校验来源）。CC 要求 PASS 必附可重跑命令+输出，且验证者≠实现者。

### 1.2 设计（三个改动点，全部嫁接现有结构）

**(a) 新增对抗 verifier profile（或改造现有）** — `profile-registry.ts`
```
name: 'adversarial_verifier', role: 'readonly_plus_test'
allowedTools: [...READ_ONLY_TOOLS, 'run_tests']   // 不给 bash（P0-2：bash 不受 sandbox 约束，可绕过文件写限制）
expertisePrompt: 对抗式（要点见 1.3，含具体对抗策略模板）
defaultKind: 'verify'
```
关键：**不含 `edit_file`/`write_file`/`bash`**——验证者不能改源码、不能改被验测试、不能执行任意 shell。需要新写测试时由实现者/patcher 在独立 work-order 里做，验证者只跑、只读、只裁决。（`role` 新增 `'readonly_plus_test'`：介于 readonly 与 hands：读 + 执行测试，无文件写。）

**(b) evidenceStatus='verified' 的来源约束** — `worker-evidence.ts`
- 新增不变量：**`evidenceStatus` 升到 `'verified'` 只接受来自 `verify` kind 且 profile 为 `'adversarial_verifier'` 的 work-order**。实现者（patcher/hands）的 work-order 即便自报成功，evidenceStatus 最多停在 `'unverified'`。
- `WRITE_PROFILES_ADVISORY` 从 `['patcher', 'verifier']` 改为 `['patcher']`——对抗 verifier 不在此列表中（P0-3）。
- 落点：`worker-evidence.ts` 的 `verifyWorkerEvidence` 函数加 profile 判断。

**(c) 验证缺失 nudge（借 CC TaskUpdateTool:361-432）** — coordinator / delegate 聚合处
- 当一批 work-order 含 patch_proposal/hands 改动但**无配套 verify order**时，注入提醒："存在未验证的改动，应 delegate 一个对抗 verifier；你不能靠在汇总里列 caveat 自封通过。"
- 这是软推动（与 CC 一致），不硬阻断——是否 spawn 仍取决于主 agent，但缺验证会被显式标红。

### 1.3 对抗 verifier 的 expertisePrompt 要点（移植 CC 设计 + 补强）

- 开宗明义："你的工作**不是确认实现可用，而是试图破坏它**。"
- 点名两种失败模式：verification avoidance（读代码就写 PASS）、被前 80% 诱惑（漂亮结果就放行，没查边界）。
- 证据强制：每个 PASS **必须附 "运行的命令 + 观察到的输出"**，否则视为未验证。
- 独立性告诫："实现者也是模型，其测试可能堆满 mock——独立验证，别复用它的断言。"
- 裁决：以 `verified` / `failed` / `blocked` 收尾（直接对齐天枢现有 evidenceStatus enum，比 CC 的 VERDICT 字符串更结构化）。

**对抗策略（P1-1 补强 — 必执行，不可跳过）**：

```
对每个改动，至少执行以下 3 项：
1. **边界值探针**：空输入、0、负数、超长字符串、特殊字符
2. **竞态探针**：如果改动涉及异步/文件/状态，尝试并发场景
3. **类型边界探针**：如果改动涉及类型 assertion/narrowing，尝试构造类型不匹配的输入

## 裁决输出格式
每个改动以 JSON 收尾：
{"verdict": "verified|failed|blocked", "command": "实际运行的命令", "evidence": "观察到的输出（截取关键行）"}
若 failed/blocked，附 "counterexample": "触发失败的输入/场景"
```

---

## 2. 改造二：Cron 租约锁（server 层独立 cron-scheduler + cron-lock）

### 2.1 缺口（代码级核实）

天枢 `nightcrawler.ts` 自称 "Lightweight scheduler ... Based on Nightcrawler pattern + Claude Code /loop"，已有 checkpoint/resume、timeout、队列与并发。但：
- **进程内 EventEmitter**，无跨进程/跨会话协调
- **无时间触发**（只能立即/排队跑，不能"每晚 2 点"）
- **无持久化**：`BackgroundTask` 在内存，进程退出全丢
- **无锁**：多个天枢会话同时跑会重复执行同一定时任务
- **per-AgentLoop 生命周期**：每个 loop 创建自己的 nightcrawler 实例，不存在"全局 nightcrawler"可挂 daemon 逻辑

这正是 task-lifecycle spec §2.2 标记的 scheduler 空白。

**关键架构约束**（来自双任务系统主权裁定）：nightcrawler 是 P3-F 认知子系统（`nightcrawler.ts:2`），在 `p3-integration.ts` 中与 miner/bandit/jit 同捆，受 §0 公理保护。daemon 层的 cron/租约锁不可侵入 agent 层的认知代码。因此改造二的正确落点是 **server 层独立 cron-scheduler + cron-lock**，而非原案的「扩展 nightcrawler」。

### 2.2 设计（移植 CC cronTasksLock 模式，落 server 层）

参考 CC `utils/cronTasks.ts:1-70` + `utils/cronTasksLock.ts:1-9,111-173`：

**(a) 持久化 schedule 表** — `.rivet/scheduled_tasks.json`（server 层管理）
- 条目：`{id, prompt, profile/allowedTools, trigger:{type:'interval'|'cron'|'oneshot', spec}, recurringMaxAgeMs?, agentId?}`
- one-shot 触发即删；recurring 重排，超 maxAge 过期清理。
- agentId 字段：teammate/特定 runtime 创建的定时任务路由回对应队列（对接 task-lifecycle 的 runtime 池）。
- 写入始终走原子写（写临时文件 + rename），防止并发损坏。

**(b) PID 租约锁** — `.rivet/scheduled_tasks.lock`（核心，移植 CC，落 server 层）
- **O_EXCL 原子创建**抢锁 → 写入 owner PID。
- **PID 存活探测**：非 owner 会话读锁，探测 owner PID 是否存活。探测方法：`ps -p <pid> -o state= | grep -v Z`（避免 macOS/Linux zombie 进程盲区——`kill(pid,0)` 对 zombie 返回成功，P1-2）。存活则被动轮询，死亡则**回收陈旧锁**接管。
- **退出清理**：owner 正常退出删锁。
- **部署假设**（缺口 5）：PID 租约锁仅在「多个 rivet 进程各起 server」场景有效。若部署为单 daemon 进程则锁 YAGNI，但保留实现以支持多进程/多会话场景。
- 效果：多个天枢会话中**恰好一个**当 scheduler，owner 崩溃由旁路会话接管——无重复执行、无单点。

**(c) 时间触发循环 + 执行路径**
- scheduler owner 起一个 tick（间隔检查，非每任务一个 timer）。
- 到点的任务 → `TaskRegistry.createTask()` → 分配 pooled runtime → 在 runtime 上启动 AgentLoop（自带 maxTurns + AbortSignal + TurnHeartbeat）。
- **不重造执行层**：AgentLoop 是现成的执行单元；本改造只加"何时触发 + 谁负责触发 + 持久化"。
- **不经过 nightcrawler**：nightcrawler 的 queue/FIFO/maxConcurrent 为 P3 会话内 background task 设计，不适用于 daemon 级调度。

**(d) 与 task-lifecycle spec 的衔接**
- cron 触发 → TaskRegistry.createTask（source: 'cron'）→ 分配 runtime → AgentLoop 执行 → 结果回写 TaskRegistry。
- 单一路径，无分支。TaskRegistry 是唯一任务真相源。

### 2.3 落点

| 改动 | 文件 | 性质 |
|------|------|------|
| 持久化 schedule 表 + 时间触发 tick | 新 `src/server/cron-scheduler.ts`（读写 `.rivet/scheduled_tasks.json`） | 新增（server 层） |
| PID 租约锁 | 新 `src/server/cron-lock.ts`（O_EXCL + PID 探测 + 陈旧回收，移植 CC 模式） | 新增（server 层） |
| cron 触发 → TaskRegistry → runtime → AgentLoop | 接线 `cron-scheduler.ts` → `task-registry.ts` → runtime 池 | 接线（server 层内） |

**不动**：`src/agent/nightcrawler.ts`（保持为 P3-F 认知子系统）、agent 层的所有模块。

---

## 3. 安全

**改造一**：对抗 verifier **降权**（去掉 edit_file/write_file/bash），是安全增益，无新暴露面。verifier 只有 `run_tests` + 只读工具——`run_tests` 只能跑已有测试，不能执行任意 shell，不存在绕过写限制的路径。

**改造二**：cron 是**无人值守反复执行**的入口，风险最高：
- 定时任务的 `allowedTools` **默认更严**（最小权限），创建定时任务须经认证（若 task-lifecycle 的 ingress 已带 auth，复用之）。
- 锁文件 `.rivet/` 在项目内，注意不要把 PID/路径泄漏到日志。
- 防止被注入的 schedule 条目无限自我重排（recurringMaxAge 兜底 + 条目数上限）。
- 执行走 AgentLoop（自带 maxTurns + TurnHeartbeat），天然有 turn 上限和静默检测保护，不存在"cron 任务无限循环"的风险。

---

## 4. 验证

| 验证 | 测法 | 标准 |
|------|------|------|
| verifier 无法写源码 | 给对抗 verifier 一个改源码任务 | edit_file/write_file/bash 不在其工具集，被拒 |
| evidenceStatus 来源约束 | 实现者 work-order 自报成功 | evidenceStatus 停在 unverified，非 verified |
| 对抗 verifier 真出裁决 | 跑一个含已知 bug 的改动 | verifier 以 failed 收尾 + 附命令/输出 |
| 验证缺失 nudge | 提交无配套 verify 的改动批 | 注入提醒，改动标未验证 |
| cron 锁单调度器 | 同时起 2 个天枢会话 + 一个 interval 任务 | 任务**只执行一次**（非两次） |
| 锁接管 | kill scheduler owner 进程 | 旁路会话回收陈旧锁、接管调度 |
| cron 持久化 | 设 recurring 任务后重启 | 重启后 schedule 表可恢复 |
| cron → TaskRegistry → AgentLoop | 设一个 cron 任务，检查完整链路 | task 状态在 TaskRegistry 中完整流转，AgentLoop 正常执行并回写结果 |

---

## 5. 实施阶段

```
改造一（对抗式 Verifier · 独立，可先做）
  P0 ├─ 新增 adversarial_verifier profile（去 write + bash + 对抗 prompt + 中间 role）
     ├─ WRITE_PROFILES_ADVISORY: verifier 移出 advisory 列表
     └─ worker-evidence: 来源约束（对抗 verifier 的 verified 直接接受）
  P1 └─ coordinator: 验证缺失 nudge（软推动）

改造二（Cron 租约锁 · 依赖 runtime 池 + TaskRegistry）
  P0 ├─ 新 src/server/cron-scheduler.ts: 持久化 schedule 表 + 时间触发 tick
  P1 ├─ 新 src/server/cron-lock.ts: PID 租约锁（O_EXCL + zombie-safe 探测 + 陈旧回收）
  P2 └─ cron-scheduler 触发 → TaskRegistry.createTask → runtime 池分配 → 启动 AgentLoop
     验证：多会话单调度 + 锁接管 + 重启恢复 + 完整链路
```

依赖：两条改造**互相独立**。改造一只动 profile/work-order/coordinator。改造二依赖姊妹 spec B 的 Phase 0（TaskRegistry）和姊妹 ingress spec 的 Phase 2（runtime 池）就绪。**不依赖 nightcrawler**——nightcrawler 完全不在此路径上。

**P3 卫生（延后）**：nightcrawler 当前 executor 是 no-op。将来 P3 接真 executor 时，timeout/cancel 应能真正终止执行——给 nightcrawler 补 abort 句柄（让 cancel() 和 timeout 能停止正在跑的 executor）。这是 P3 认知子系统的内部卫生，不阻塞 daemon cron 路径。

---

## 6. 一句话总结

> 从 Claude Code 取两条最高价值借鉴，全部嫁接天枢现有结构、不建新子系统：**对抗式 verifier** 把现有协作式 verifier 降权（去源码写权限 + 去 bash）+ 加对抗 prompt + 用 evidenceStatus 来源约束根除"实现者自评"偏置（天枢的 enum 比 CC 的 VERDICT 字符串更结构化）；**cron 租约锁** 在 server 层新建 cron-scheduler（持久化 schedule 表 + 时间触发）+ cron-lock（PID 租约锁 + zombie-safe 探测 + 多会话单调度器选举），触发走 TaskRegistry → runtime → AgentLoop，不碰 agent 层 nightcrawler（P3-F 认知子系统，受 §0 保护）。两条正交、纯基础设施层、不碰认知本体。

---

## 附录：历史修订记录

原案改造二落点为「扩展 `src/agent/nightcrawler.ts`」，经 2026-06-06 双任务系统主权裁定推翻。原因：
1. nightcrawler 是 per-AgentLoop 的 P3-F 认知子系统（`nightcrawler.ts:2`），受 §0 保护
2. 每个 loop 一个 nightcrawler 实例，"哪个实例拥有 cron 表"无定义
3. nightcrawler 的 execute 是 no-op 回调，不存在"把执行委托给 nightcrawler"的接口
4. daemon 执行应直接走 AgentLoop（自带 maxTurns + AbortSignal + TurnHeartbeat），无需 nightcrawler 的 queue/FIFO/checkpoint

修正后的落点见 §2.3。原案保留于 `.bak` 备份文件。
