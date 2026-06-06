# 天枢改造:对抗式 Verifier + Cron 租约锁(借鉴 Claude Code)

> 日期：2026-06-06
> 状态：设计稿（待评审）
> 触发：Claude Code 工作流对照调研,两条最高价值借鉴落地。
> 背景依据：`docs/research/2026-06-06-claude-code-workflow-comparison.md`（含全部 CC 代码锚点与对比表）
> 关联：[[standing-collaborator-ingress-spec]]、姊妹 task-lifecycle spec `2026-06-06-task-lifecycle-system-design.md`、[[cache-aware-fusion-spec]]

---

## 0. 定位与边界

两条改造**均为基础设施/编排层**,不碰认知本体（遵继承自 [[cognitive-pipeline-is-substrate-not-feature]] 的 §0 公理）。两者正交,可独立实施:

- **改造一(对抗式 Verifier)**：把天枢现有协作式 verifier 升级为独立对抗式验证者，根除"实现者自评"偏置。嫁接到现有 profile-registry + work-order + worker-evidence，**无新子系统**。
- **改造二(Cron 租约锁)**：给天枢现有 nightcrawler 加时间触发 + 多会话单调度器选举 + 持久化，填 task-lifecycle spec §2.2 的 scheduler 空白。

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
allowedTools: [...READ_ONLY_TOOLS, 'run_tests', 'bash']   // 给跑测试/命令，不给 edit_file/write_file
expertisePrompt: 对抗式（要点见 1.3）
defaultKind: 'verify'
```
关键：**不含 `edit_file`/`write_file`**——验证者不能改源码也不能改被验测试。需要新写测试时由实现者/patcher 在独立 work-order 里做，验证者只跑、只读、只裁决。（新增中间档 `role`，介于 readonly 与 hands：读 + 执行测试，无文件写。）

**(b) evidenceStatus='verified' 的来源约束** — `worker-evidence.ts`
- 新增不变量：**`evidenceStatus` 升到 `'verified'` 只接受来自 `verify` kind 且 profile 为对抗 verifier 的 work-order**。实现者（patcher/hands）的 work-order 即便自报成功，evidenceStatus 最多停在 `'unverified'`。
- 落点：`worker-evidence.ts:32,43` 消费 evidenceStatus 处加来源校验（worker 的 profile/kind 已在 work-order 里）。

**(c) 验证缺失 nudge（借 CC TaskUpdateTool:361-432）** — coordinator / delegate 聚合处
- 当一批 work-order 含 patch_proposal/hands 改动但**无配套 verify order**时，注入提醒："存在未验证的改动，应 delegate 一个对抗 verifier；你不能靠在汇总里列 caveat 自封通过。"
- 这是软推动（与 CC 一致），不硬阻断——是否 spawn 仍取决于主 agent，但缺验证会被显式标红。

### 1.3 对抗 verifier 的 expertisePrompt 要点（移植 CC 设计）

- 开宗明义："你的工作**不是确认实现可用，而是试图破坏它**。"
- 点名两种失败模式：verification avoidance（读代码就写 PASS）、被前 80% 诱惑（漂亮结果就放行，没查边界）。
- 证据强制：每个 PASS **必须附 "运行的命令 + 观察到的输出"**，否则视为未验证。
- 至少一个对抗探针：并发/边界值/幂等/错误路径。
- 独立性告诫："实现者也是模型，其测试可能堆满 mock——独立验证，别复用它的断言。"
- 裁决：以 `verified` / `failed` / `blocked` 收尾（直接对齐天枢现有 evidenceStatus enum，**比 CC 的 VERDICT 字符串更结构化，无需新解析**）。

## 2. 改造二：Cron 租约锁(给 nightcrawler 加时间触发 + 多会话调度)

### 2.1 缺口（代码级核实）

天枢 `nightcrawler.ts` 自称 "Lightweight scheduler ... Based on Nightcrawler pattern + Claude Code /loop"，已有 checkpoint/resume、timeout、8 终止条件、队列与并发。但：
- **进程内 EventEmitter**，无跨进程/跨会话协调
- **无时间触发**（只能立即/排队跑，不能"每晚 2 点"）
- **无持久化**：`BackgroundTask` 在内存，进程退出全丢
- **无锁**：多个天枢会话同时跑会重复执行同一定时任务

这正是 task-lifecycle spec §2.2 标记的 scheduler 空白。

### 2.2 设计（移植 CC cronTasksLock 模式）

参考 CC `utils/cronTasks.ts:1-70` + `utils/cronTasksLock.ts:1-9,111-173`：

**(a) 持久化 schedule 表** — `.rivet/scheduled_tasks.json`
- 条目：`{id, prompt, profile/allowedTools, trigger:{type:'interval'|'cron'|'oneshot', spec}, recurringMaxAgeMs?, agentId?}`
- one-shot 触发即删；recurring 重排，超 maxAge 过期清理。
- agentId 字段：teammate/特定 runtime 创建的定时任务路由回对应队列（对接 task-lifecycle 的 runtime 池）。

**(b) PID 租约锁** — `.rivet/scheduled_tasks.lock`（核心，移植 CC）
- **O_EXCL 原子创建**抢锁 → 写入 owner PID。
- **PID 存活探测**：非 owner 会话读锁，探测 owner PID 是否存活；存活则被动轮询，死亡则**回收陈旧锁**接管。
- **退出清理**：owner 正常退出删锁。
- 效果：多个天枢会话中**恰好一个**当 scheduler，owner 崩溃由旁路会话接管——无重复执行、无单点。

**(c) 时间触发循环**
- scheduler owner 起一个 tick（间隔检查，非每任务一个 timer），到点的任务 → 入 nightcrawler 现有队列（复用其 checkpoint/timeout/终止条件）。
- **不重造执行层**：触发后交给 nightcrawler 跑；本改造只加"何时触发 + 谁负责触发 + 持久化"。

**(d) 与 task-lifecycle spec 的衔接**
- 若 task-lifecycle 的 TaskRegistry 已落地，cron 触发产生的任务走 TaskRegistry（统一生命周期/审计/通知）；否则直接进 nightcrawler 队列。两条路径不冲突——cron 锁解决"触发"，TaskRegistry 解决"管理"。

### 2.3 落点

| 改动 | 文件 | 性质 |
|------|------|------|
| 持久化 schedule 表 | 新 `src/agent/cron-tasks.ts`（读写 `.rivet/scheduled_tasks.json`） | 新增 |
| PID 租约锁 | 新 `src/agent/cron-lock.ts`（O_EXCL + PID 探测 + 陈旧回收，移植 CC 模式） | 新增 |
| 时间触发 tick + 入队 | 扩展 `src/agent/nightcrawler.ts`（加 schedule 来源，不动执行层） | 接线 |

---

## 3. 安全

**改造一**：对抗 verifier **降权**（去掉 edit_file/write_file），是安全增益，无新暴露面。唯一风险：verifier 仍有 `bash`/`run_tests`——须确保其 bash 受现有 sandbox（`sandbox-exec`）约束，且不能借 bash 绕过文件写限制（如 `bash echo > file`）→ verifier 的 bash 应走只读/受限策略,或显式禁写文件系统的命令白名单。

**改造二**：cron 是**无人值守反复执行**的入口，风险最高：
- 定时任务的 `allowedTools` **默认更严**（最小权限），创建定时任务须经认证（若 task-lifecycle 的 ingress 已带 auth，复用之）。
- 锁文件 `.rivet/` 在项目内，注意不要把 PID/路径泄漏到日志。
- 防止被注入的 schedule 条目无限自我重排（recurringMaxAge 兜底 + 条目数上限）。

---

## 4. 验证

| 验证 | 测法 | 标准 |
|------|------|------|
| verifier 无法写源码 | 给对抗 verifier 一个改源码任务 | edit_file/write_file 不在其工具集,被拒 |
| evidenceStatus 来源约束 | 实现者 work-order 自报成功 | evidenceStatus 停在 unverified,非 verified |
| 对抗 verifier 真出裁决 | 跑一个含已知 bug 的改动 | verifier 以 failed 收尾 + 附命令/输出 |
| 验证缺失 nudge | 提交无配套 verify 的改动批 | 注入提醒,改动标未验证 |
| cron 锁单调度器 | 同时起 2 个天枢会话 + 一个 interval 任务 | 任务**只执行一次**(非两次) |
| 锁接管 | kill scheduler owner 进程 | 旁路会话回收陈旧锁、接管调度 |
| cron 持久化 | 设 recurring 任务后重启 | 重启后 schedule 表可恢复 |

---

## 5. 实施阶段

```
改造一（对抗式 Verifier · 独立，可先做）
  P0 ├─ 新增 adversarial_verifier profile（去写权限 + 对抗 prompt + 中间 role）
     └─ 验证：verifier 无 edit_file/write_file
  P1 ├─ worker-evidence: evidenceStatus='verified' 来源约束（须来自对抗 verifier）
     └─ 验证：实现者自报不能升到 verified
  P2 └─ coordinator: 验证缺失 nudge（软推动）

改造二（Cron 租约锁 · 独立，依赖 nightcrawler）
  P0 ├─ cron-tasks.ts: 持久化 schedule 表（.rivet/scheduled_tasks.json）
  P1 ├─ cron-lock.ts: PID 租约锁（O_EXCL + 探测 + 陈旧回收，移植 CC）
  P2 └─ nightcrawler 扩展: 时间触发 tick → 入队
     验证：多会话单调度 + 锁接管 + 重启恢复
```

依赖：两条改造**互相独立**。改造一只动 profile/work-order/coordinator，可立即做。改造二依赖 nightcrawler（已存在）。两者与 task-lifecycle spec 衔接但不阻塞——cron 锁产生的任务可走 TaskRegistry（若已落地）或直接进 nightcrawler 队列。

---

## 6. 一句话总结

> 从 Claude Code 取两条最高价值借鉴,全部嫁接天枢现有结构、不建新子系统:**对抗式 verifier** 把现有协作式 verifier 降权（去源码写权限）+ 加对抗 prompt + 用 evidenceStatus 来源约束根除"实现者自评"偏置（天枢的 enum 比 CC 的 VERDICT 字符串更结构化）；**cron 租约锁** 给现有 nightcrawler 加 PID 租约锁（移植 CC cronTasksLock）+ 持久化 schedule，填多会话定时调度空白。两条正交、纯基础设施层、不碰认知本体。背景依据见 `docs/research/2026-06-06-claude-code-workflow-comparison.md`。

---

# 天枢执中审查（2026-06-06，天枢 + Opus 联合评估）

> 审查方法：先读 spec，再派 3 路 scout 代码核实（profile-registry、worker-evidence、nightcrawler），
> 再基于真实代码做缺口比对。以下是发现的 spec 未覆盖或低估的问题，按严重度分级。

## 🔴 P0（阻塞实施 — 不补会导致方案失效或引入新雷）

### P0-1：nightcrawler 的 max_turns 终止条件完全未实现 — cron 无人值守任务将无限循环

**代码核实**：`nightcrawler.ts:160-186` 的 `startTask()` 中：
- `task.timeoutMs` 被检查（setTimeout）
- `task.status !== 'running'` 被检查（取消/超时保护）
- **没有任何代码比较 `turnsExecuted >= maxTurns`**

`BackgroundTask` 接口定义了 `maxTurns` 字段（`nightcrawler.ts:21`），`TerminationReason` 类型声明了 `'max_turns'`（`nightcrawler.ts:47`），但两者之间**无任何桥接代码**。`checkpoint()` 方法接收并存储 `turnsExecuted`，但从未被用于终止判断。

**影响**：spec A §2.1 声称 nightcrawler "已有 8 终止条件"，实际上仅 4 个有实现（completed/timeout/cancelled/error），max_turns/idle/budget_exhausted/conflict 仅为 TypeScript 类型占位。cron 产生的无人值守任务若 executor 不自行终止，会在 nightcrawler 中永久运行——直到 timeout 或手动取消，无 turn 上限保护。

**修正建议**：spec §2.2 实施表中，P0 新增前置步骤：

```
P0-pre └─ nightcrawler: 补 max_turns 终止条件
         └─ startTask 的 executor 包装中加 turnsExecuted >= maxTurns 检查
         └─ 验证：maxTurns=3 的任务在第 4 轮前被终止，status='max_turns'
```

最小实现（3 行）：在 `startTask` 的 executor resolve/reject 两个路径各加 `if (task.turnsExecuted >= task.maxTurns) { ... }` 守卫。

### P0-2：对抗 verifier 的 bash 工具不受 sandbox 约束 — 降权不彻底

**代码核实**：`sandbox-exec`（`src/tools/sandbox-exec.ts`）是一个独立工具，仅执行沙箱化的 JS 代码。对抗 verifier 的 `bash` 工具是普通 shell 执行（`src/tools/bash.ts`），**不受 `sandbox-exec` 的沙箱约束**。

spec A §3 承认风险但轻描："须确保其 bash 受现有 sandbox（`sandbox-exec`）约束"——但 `sandbox-exec` 和 `bash` 是**两个独立工具**，无约束关系。verifier 可以通过 `bash 'echo "malicious" > src/app.ts'` 绕过 "无 edit_file/write_file" 的限制。

**修正建议**：两个选项，建议选项 A（最小改动）：

- **选项 A（推荐）**：对抗 verifier 的 `allowedTools` 中去掉 `bash`，只保留 `run_tests` + 只读工具。`run_tests` 只能跑已有测试，不能执行任意 shell 命令。
- **选项 B**：实现 bash 的只读模式（文件系统只读挂载或命令白名单），然后允许 verifier 使用受限 bash。工作量大，不推荐 MVP 阶段。

若选 A，对抗 verifier 的工具集变为：`[...READ_ONLY_TOOLS, 'run_tests']`。

### P0-3：WRITE_PROFILES_ADVISORY 把 verifier 和 patcher 同级对待 — 实现者自评仍可 marked verified

**代码核实**：`worker-evidence.ts:10`：

```typescript
const WRITE_PROFILES_ADVISORY = ['patcher', 'verifier']
```

这意味着当前 verifier 与 patcher 享受相同的 advisory 宽松处理：即使 verifier 自报 `evidenceStatus='verified'`，也只产生 advisory risk，不 block。

spec A §1.2(b) 设计的「evidenceStatus 来源约束」需要与这个机制正确交互。当前：
- patcher 自报 verified → advisory（现有行为，保留）
- 对抗 verifier 裁决 verified → 应被**无条件接受**，不经过 WRITE_PROFILES_ADVISORY 的 advisory 路径

**修正建议**：`worker-evidence.ts` 中需要区分：
1. 来源是对抗 verifier（profile === 'adversarial_verifier'）→ 跳过 advisory，直接接受 evidenceStatus
2. 来源是普通 verifier/patcher → 保持现有 advisory 行为

这需要在 spec §1.2(b) 中明确：`WRITE_PROFILES_ADVISORY` 从 `['patcher', 'verifier']` 改为 `['patcher']`——对抗 verifier 不在此列表中。

## 🟡 P1（重要 — 不补会导致边界 case 翻车或运维困难）

### P1-1：对抗 verifier 的 expertisePrompt 缺乏具体对抗指导

spec §1.3 的 prompt 要点正确，但缺少可操作的对抗模板。对抗 verifier 是 AI，需要具体指令才能有效对抗。

**修正建议**：在 expertisePrompt 中追加具体对抗策略：

```
## 对抗策略（必执行，不可跳过）

对每个改动，至少执行以下 3 项：
1. **边界值探针**：空输入、0、负数、超长字符串、特殊字符
2. **竞态探针**：如果改动涉及异步/文件/状态，尝试并发场景
3. **类型边界探针**：如果改动涉及类型 assertion/narrowing，尝试构造类型不匹配的输入

## 裁决输出格式
每个改动以 JSON 收尾：
{"verdict": "verified|failed|blocked", "command": "实际运行的命令", "evidence": "观察到的输出（截取关键行）"}
若 failed/blocked，附 "counterexample": "触发失败的输入/场景"
```

### P1-2：cron 锁 PID 存活探测在 macOS 上有 zombie 进程盲区

`kill(pid, 0)` 在 macOS（以及 Linux）上对 zombie 进程返回成功——zombie 进程保留 PID 直到父进程 `wait()`。如果 scheduler owner 变成 zombie（父进程未 reap），旁路会话的 PID 探测会认为 owner 存活，陈旧锁永不回收。

**修正建议**：PID 探测从简单的 `kill(pid, 0)` 改为：

```
检查进程状态：ps -p <pid> -o state= | grep -v Z
```

如果输出为空（进程不存在或状态为 Z），判定为死亡 → 回收锁。

### P1-3：schedule 表并发写入未考虑

spec 假设只有 scheduler owner 写入 `.rivet/scheduled_tasks.json`，但如果未来要通过 API 创建/删除定时任务（姊妹 spec B 的 ingress），多个会话可能同时写入 schedule 表。

**修正建议**：schedule 表的写入始终走原子写（写临时文件 + rename），不直接覆写。或者用 per-task JSON 文件（`.rivet/scheduled/{id}.json`），添加/删除 = 创建/删除单文件，天然无并发冲突。

## 🟢 P2（次要 — 实现时注意即可）

### P2-1：evidenceStatus 的来源约束实现细节

spec §1.2(b) 说"在 worker-evidence.ts:32,43 加来源校验"。实际上 `verifyWorkerEvidence` 函数的签名是 `(result: WorkerResult, profile?: string)`——profile 已经作为参数传入。实现时只需在函数内部检查 profile 是否为 `'adversarial_verifier'`，若是则跳过 advisory 路径、直接接受其 evidenceStatus。

### P2-2：对抗 verifier 的 role 命名

spec 提议 `'readonly_plus_test'`。当前 `AgentRole` 类型为 `'brain' | 'hands' | 'readonly'`（`profile-registry.ts:11`）。命名上 `'readonly_plus_test'` 略显冗长，建议简化为 `'verifier'`（与现有 role 的语义一致：role 描述权限级别，而非具体工作）。但这也可能与 profile name 'verifier' 冲突——当前 profile name 和 role 是独立字段，不冲突。建议保持 `'readonly_plus_test'` 以明确区分于现有 `'readonly'`。

---

## 净结论

方案方向正确，设计嫁接合理。**P0-1（max_turns 缺失）是实施前必须修的前置条件**——不修它，cron + nightcrawler = 可能无限循环的无人值守任务。P0-2（bash 绕过）和 P0-3（WRITE_PROFILES_ADVISORY 冲突）是降权不彻底的两个具体表现，建议在 P0 阶段一并修。P1 三项是实现质量和运维可靠性的保障。

**实施顺序建议微调**：

```
改造一（对抗式 Verifier）
  P0 ├─ 新增 adversarial_verifier profile（去 write + bash + 对抗 prompt）
     ├─ 修复 WRITE_PROFILES_ADVISORY（verifier 移出 advisory 列表）
     └─ worker-evidence: 来源约束（对抗 verifier 的 verified 直接接受）
  P1 └─ coordinator: 验证缺失 nudge

改造二（Cron 租约锁）
  P0-pre └─ nightcrawler: 补 max_turns 终止条件 ★新增★
  P0 ├─ cron-tasks.ts: 持久化 schedule 表
  P1 ├─ cron-lock.ts: PID 租约锁（含 zombie 探测）
  P2 └─ nightcrawler 扩展: 时间触发 tick → 入队
```
