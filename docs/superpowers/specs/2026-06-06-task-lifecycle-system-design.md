# 天枢任务生命周期系统设计（常驻协作者·其二）

> 日期：2026-06-06
> 状态：设计稿（待评审）
> 触发：天枢审查 `2026-06-05-standing-collaborator-task-ingress-design.md` 时指出——ingress spec 只是「一次性异步调用」≈ OpenClaw `/v1/chat/completions`，不是 task system；「常驻协作者」需任务生命周期管理。经领航星裁定拆为本姊妹 spec。
> 姊妹 spec：`2026-06-05-standing-collaborator-task-ingress-design.md`（ingress + runtime 池 + cache）
> 关联：[[standing-collaborator-ingress-spec]]、[[cognitive-pipeline-is-substrate-not-feature]]

---

## 0. 定位与边界

两份 spec 合并兑现「常驻协作者」：
- **姊妹（ingress）**：让天枢「HTTP 可达 + 长驻 runtime 池 + cache 隔离」——回答「任务怎么进来、在哪跑」。
- **本 spec（task lifecycle）**：让进来的任务「有状态、可取消、可审计、可定时、完成可通知」——回答「任务怎么被管理」。

无本 spec，ingress 只是「REPL 的 HTTP wrapper」（天枢审查原话）。有了它，天枢才从「被调用」变「常驻管理自己的工作」。

**遵 §0 公理（继承自 [[cognitive-pipeline-is-substrate-not-feature]]）**：纯基础设施层，不碰认知本体。

---

## 1. 代码级现状：天枢非零基础

天枢审查自评「❌ 无 Task system」不准确——已有可观零件，缺的是 daemon 级编排：

| 能力 | 现状 | 锚点 |
|------|------|------|
| 任务状态机 | ✅ `TaskBoard`：`pending/running/completed/failed` + 事件 + startedAt/completedAt | `task-board.ts:4,20,31` |
| 任务状态派生 | ✅ `extractTaskState`/`taskStateFromTodos`（从 trajectory/todos 投影） | `task-state.ts:16,55` |
| 取消机制 | ✅ coordinator 完整 `AbortSignal` 传播（取消已能用） | `coordinator.ts:81,144,395` |
| 看门狗/心跳 | ✅ `TurnHeartbeat`（静默检测 + abort teeth） | `turn-heartbeat.ts:45` |
| 持久化原语 | ✅ `SessionPersist`（原子写 JSONL） | `session-persist.ts` |
| **daemon 级任务注册表** | ❌ TaskBoard 是**纯读投影层（UI 用）**，不拥有任务执行/调度 | — |
| **cron/定时触发** | ❌ 无（heartbeat 是看门狗，非调度器） | — |
| **notify policy** | ❌ 无 | — |
| **任务记录持久化** | ❌ TaskBoard 在内存，进程退出即失 | — |

**精确结论**：天枢有「任务状态模型」+「取消」，缺「拥有式任务注册表 + 调度 + 通知 + 任务记录持久化」。本 spec = 把 TaskBoard 的投影模型**提升为 daemon 级拥有者**，补齐缺的四项。

## 2. 设计：从投影层升级为 daemon 任务注册表

复用 TaskBoard 的状态模型，新增**拥有式 `TaskRegistry`**——不只是观察任务，而是拥有任务的创建/执行/取消/调度/通知。

**2.1 TaskRegistry（核心，新增）** — `src/server/task-registry.ts`
- 拥有任务生命周期：`pending → running → (completed | failed | cancelled | timed_out)`，复用 `BoardTaskStatus` 并补 `cancelled`/`timed_out`。
- 每个任务持有：id、objective、目标 runtime（来自姊妹 spec 的 runtime 池）、AbortController、时间戳、结果/错误。
- 取消：调用任务的 AbortController → 复用 coordinator 现成 `AbortSignal` 传播（`coordinator.ts:81`），不新造取消机制。
- **任务超时（天枢二次审查补）**：每个任务带超时上限，`running` 超时 → 触发 AbortController → 转 `timed_out`（failed 的子类）。否则失控任务永久占用 runtime。
- **任务去重/幂等（天枢二次审查补）**：以 `prompt hash` 作幂等 key。同一 prompt 重复提交 → 默认识别为重复，返回已有 task id 而非新建（可显式 `force` 覆盖）。否则易堆积大量重复任务。
- 与 ingress 衔接：姊妹 spec 的 `POST /prompt` 不再直接驱动 loop，而是**创建一个 task** → TaskRegistry 调度到 runtime → 返回 task id（异步）；`GET /tasks/:id` 查状态，`POST /tasks/:id/cancel` 取消。

**2.2 调度器（cron，新增）** — `src/server/scheduler.ts`
- 定时触发任务（cron 表达式或间隔）。最小实现：`setInterval` + **持久化 schedule 表**。
- **具体落地方案见** `2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease.md` §2（cron 租约锁，移植 CC cronTasksLock 的 PID 租约锁 + 多会话单调度器选举 + `.rivet/scheduled_tasks.json` 持久化，扩展现有 nightcrawler）。
- **schedule 必须持久化（天枢二次审查强调）**：写入文件/KV，否则进程重启后所有定时任务全丢。这是硬要求，不是可选。
- 用途示例：天枢可被设定「每晚跑一次仓库健康检查」——这才是「常驻协作者」而非「被动应答」。

**2.3 任务记录持久化（新增）—— 用 KV，不复用 SessionPersist（天枢二次审查纠正）**
- **不照搬 SessionPersist**：经核实，`SessionPersist` 底层是 **JSONL 追加 + 原子写全量快照**（`appendFile`/`appendFileSync`），适合「只增不改」的对话历史，**不适合 task 记录的频繁随机状态更新**（running→completed 要改同一条记录）。
- **改用简单 KV**：SQLite 或 per-task JSON 文件（`.rivet/tasks/{id}.json`，状态更新即原子重写单文件）。进程重启可恢复未完成任务的可见性与审计。
- 与姊妹 spec 的 runtime 持久化**不再同源**——runtime 走 SessionPersist（追加历史），task 走 KV（随机更新），各取所需。

**2.4 通知策略（新增）** — `notify policy`：`silent | state_changes | errors_only`
- 任务状态流转时按策略输出（终端/log/未来可接 webhook）。最小实现先支持 log 级。

**2.5 审计** — `GET /tasks` 列出全部任务及状态，`TaskBoard` 投影层继续服务 UI（不动），TaskRegistry 作为其数据源。

---

## 3. 架构落点

| 变更 | 文件 | 性质 |
|------|------|------|
| TaskRegistry（拥有式任务生命周期 + 超时 + 去重） | 新 `src/server/task-registry.ts` | 新增（复用 BoardTaskStatus + AbortSignal） |
| 调度器（cron/间隔 + 持久 schedule 表） | 新 `src/server/scheduler.ts` | 新增（setInterval + 持久化 schedule，重启可恢复） |
| 任务记录持久化（KV，非 SessionPersist 追加） | 新 `.rivet/tasks/{id}.json` 或 SQLite | 新增（随机读写，区别于 runtime 的 SessionPersist） |
| ingress 改为创建 task | `server/prompt-route.ts`（姊妹 spec 的 handler） | 衔接（task id 替代直接 loop） |
| 任务路由 API | `server/routes.ts`（+`/tasks` `/tasks/:id` `/tasks/:id/cancel`） | 新增路由 |
| 通知策略 | `task-registry.ts` | 新增 |

**不动**：`TaskBoard`（继续作 UI 投影）、coordinator 的 AbortSignal 机制、认知本体全部。

---

## 4. 安全与验证

**安全（继承姊妹 spec §7）**：`/tasks*` 与 `/prompt` 同样是网络暴露的工具执行入口——同一套 token 认证 + 默认 127.0.0.1 + per-task runtime 最小权限。定时任务尤其危险：一个被注入的 cron 任务可无人值守反复执行，**调度任务的创建必须经认证，且定时任务的 allowedTools 默认更严**。

| 验证 | 测法 | 标准 |
|------|------|------|
| 生命周期完整 | 创建→运行→完成 全状态可查 | 状态流转正确、有时间戳 |
| 取消生效 | running 任务 `POST /cancel` | AbortSignal 传到 runtime，任务转 cancelled |
| 重启恢复 | 进程重启后 `GET /tasks` | 未完成任务记录可见（审计不丢） |
| 定时触发 | 设间隔任务 | 按时创建并执行 |
| 通知策略 | 三档分别配置 | 输出符合策略 |
| 安全 | 无 token 创建任务/cron | 被拒 |

---

## 5. 实施阶段

```
Phase 0（依赖姊妹 spec 的 runtime 池就绪）
  └─ TaskRegistry：生命周期 + 取消（复用 AbortSignal）+ 超时（running→timed_out）+ 去重（prompt hash 幂等）
     验证：创建/运行/完成/取消/超时全状态可查 + 重复 prompt 返回同一 task id

Phase 1（持久化 + 审计）
  ├─ 任务记录写 KV（.rivet/tasks/{id}.json 或 SQLite，随机更新，非 SessionPersist 追加）
  └─ GET /tasks /tasks/:id 审计 API + 认证
     验证：重启后任务记录可见 + 无 token 被拒

Phase 2（调度 + 通知）
  ├─ scheduler.ts：cron/间隔触发 + 持久 schedule 表（重启可恢复，定时任务 allowedTools 更严）
  └─ notify policy: silent/state_changes/errors_only
     验证：定时触发正确 + 通知符合策略
```

依赖：本 spec 整体依赖姊妹 spec 的 Phase 2（runtime 池）就绪——任务要有 runtime 可调度。Phase 顺序内部递进。

---

## 6. 一句话总结

> 天枢已有任务**状态模型**（TaskBoard）+ **取消**（AbortSignal），但 TaskBoard 是纯读投影层。本 spec 把它升级为 daemon 级**拥有式 TaskRegistry**，补齐缺的四项——持久化、审计、调度、通知。这是「常驻协作者」从「被调用」到「常驻管理自己的工作」的关键一跳，与姊妹 spec（任务怎么进来/在哪跑）合并兑现协作者头衔。纯基础设施层，不碰认知本体。


---

# 天枢审查修订 (2026-06-06)

> 以下是天枢（执中者）基于对当前代码库实际能力的核实所做的审查修订。本修订同时针对姊妹 spec A（ingress/runtime pool）和本 spec B（task lifecycle）。

## 一、跨会话记忆核实（重要纠正）

两份 spec 在提及 "跨会话""session 持久化""memory" 等概念时，存在程度上的暗示与实际能力之间的偏差。以下精确列出天枢**实际拥有**的持久化能力：

| 实际能力 | 机制 | 边界 |
|---------|------|------|
| **Claim 记忆**（结构化事实/规则） | `ContextClaimStore` → `.rivet/sessions/{id}.claims.jsonl`，支持 `loadDurableClaims()` 跨会话加载 | 仅加载 `status='durable'` 的 claims（经过 promotion 评估）。需 `remember` 工具写入，`recall` 工具搜索。**不是自由文本记忆，是结构化条目 + 证据链。** |
| **会话消息历史** | `SessionPersist` → `.rivet/sessions/{id}.jsonl`（主日志）+ `.memory.json`（压缩快照） | 同一 sessionId 内的对话历史持久化。**不跨 session**——新 session 不自动继承旧 session 的对话。 |
| **主会话日志** | `loop.ts > saveSession` → JSONL 格式 | 仅用于审计/回放，不参与 agent 运行时上下文。 |

**天枢没有的能力**：
- **无 SOUL.md 式身份外化**——agent 不能读写自己的"个性文件"
- **无跨 session 对话继承**——新 session 从零开始（claims 是唯一的跨 session 载体）
- **无显式 memory block**——不像 OpenClaw 在 prompt 里注入 SOUL.md

**结论**：天枢的跨会话记忆是「结构化 fact/rules 数据库」，不是「连续身份/人格」。两份 spec 在描述持久化时不应对标 OpenClaw 的 SOUL.md 级别——实际上对标的是 `remember`/`recall` 工具 + durable claims 的持久化语义。**spec A §10 的"跨任务本体演化"已被裁定为待研究，此处再次确认：当前天枢不具备任何形式的持续身份或跨会话人格记忆，只有 claim 存储。**

## 二、spec A（ingress）补充

### 2.1 SessionPersist 接线范围已核实
spec A 修订版已正确将 SessionPersist 接入列入 Phase 2 依赖。但需明确：**`worker-session.ts` 目前尚未接 SessionPersist**，该文件的 `PromptEngine` 实例生命周期是 per-delegate 即弃的。Phase 2 把 `SessionPersist` 接入 runtime 池意味着：runtime 的对话历史需被序列化/恢复——这需要 `PromptEngine` 支持状态的导出与注入（当前不存在），不仅是调一下 API。

### 2.2 cache 边界裁定确认
spec A §4 cache 收窄为 DeepSeek-only，正确。补充：当前实证基线 `docs/analysis/2026-06-02-p1-cache-hit-rate-comparison.md` 的 84-95% 数据是单 REPL 会话内的命中率。长驻 runtime 跨任务命中的预期是「不劣于该值」，需要 runtime 池实现后重新测量——不应在 spec 中将「84-95%」写死为跨任务保证值。

## 三、spec B（task lifecycle）补充

### 3.1 Task 持久化格式
spec B §2.3 提议"复用 SessionPersist 模式"写入 `.rivet/tasks/`。SessionPersist 的底层是 JSONL 追加 + 原子写压缩快照（`writeFileAtomicSync`）。task 记录需要随机读写（状态更新），JSONL 追加模式不适合频繁更新的任务状态。建议考虑简单 KV（SQLite 或 JSON 文件 per-task），不要照搬 SessionPersist 的追加模式。

### 3.2 调度器持久化
spec B §2.2 的 cron 调度器若不在进程重启后恢复 schedule，每次重启后所有定时任务丢失。scheduler 需要持久化 schedule 表（文件或 SQLite），不仅是 `setInterval`。

### 3.3 两个缺失的设计点
- **任务超时**：未定义 running→failed 的超时转换路径。实际需要，否则失控任务永久占 runtime。
- **任务去重**：同一 prompt 多次提交是创建多个 task 还是识别为重复？建议至少做幂等 key（prompt hash），否则容易产生大量重复任务。

## 四、净结论

两份 spec 的整体架构方向正确，scope 拆解合理。以上修订不改变设计路线，仅为精度修正——用代码实际能力校准 spec 中的隐性承诺，避免后续实施时发现"以为有的零件其实没有"。

---

# 二次审查回应（2026-06-06，天璇）

天枢二次审查的三个承重技术声明，**我已逐一代码核实，全部为真**，全盘接受：

| 声明 | 核实结果 | 锚点 |
|------|---------|------|
| PromptEngine 无状态导出/注入 | ✅ 真。类有 `updateActiveClaims`/frozen snapshot 管理，无 `exportState/importState/serialize/getState`。snapshot 按 user-message 内容存内存。 | `prompt/engine.ts:40` 起，无导出 API |
| 跨会话记忆是结构化 claim 库非 SOUL.md | ✅ 真。`ContextClaimStore` + `loadDurableClaims` 静态加载 + durable 状态 + 「survived 30 sessions」年龄加权。 | `claim-store.ts:45,60,250`、`claim-relevance.ts:78` |
| SessionPersist 纯追加 JSONL，不适合 task 随机更新 | ✅ 真。`appendFile`/`appendFileSync` + 原子写全量快照。 | `session-persist.ts:1,163,244` |

**已应用到本 spec B 的修正**：
- §2.3 任务持久化：从「复用 SessionPersist 追加」改为 **KV（per-task JSON 或 SQLite）**，runtime 与 task 持久化不再同源。
- §2.1：补**任务超时**（running→timed_out）+ **去重/幂等**（prompt hash）两个设计点，纳入 Phase 0。
- §2.2：**schedule 表必须持久化**升为硬要求，纳入 Phase 2。
- §3 架构表、§5 阶段同步更新。

**已应用到姊妹 spec A 的修正**（另见 A 文末「审查回应与决议」附注）：
- §2.1 SessionPersist 接线：纠正我先前「接线非从零造」的轻描——**实为需先给 PromptEngine 新增状态导出/注入能力**（当前不存在），非纯接 API。
- §4 cache：84-95% 明确标注为**单会话内基线**，跨任务目标改为「不劣于该值、池化后重测」，不写死为保证值。
- §10：以 ContextClaimStore 事实**强化**——天枢跨会话记忆只有结构化 claim 库，无任何持续身份/人格记忆，「跨任务本体演化」确认待研究。


---

# 天枢执中审查（2026-06-06，天枢 + Opus 联合评估）

> 审查方法：先读 spec，再派 scout 代码核实（task-board、coordinator、session-persist、nightcrawler），
> 基于真实代码做缺口比对。spec 已有的天枢审查修订和天璇二次审查回应已经覆盖了大量关键问题。
> 以下聚焦前两轮审查**仍未覆盖或低估**的点。

## 🔴 P0（阻塞实施）

### P0-1：取消机制依赖 AbortSignal，但 worker agent loop 内部不一定会响应

**代码核实**：`coordinator.ts:79-81, 144-165, 228, 252-270` — AbortSignal 传播分三层：

1. `DelegationCoordinatorConfig.abortSignal` — 构造时注入
2. `delegate()` per-call abortSignal 覆盖 — savedSignal/finally 模式
3. `wrapAbort()` — AbortSignal 与 Promise 竞态包装

信号传播到 worker session 层面（`workerConfig.abortSignal = this.config.abortSignal`），但 **worker 内部的 agent loop 需要在关键点显式检查 AbortSignal**。当前信号只用于：
- coordinator 在 delegate 入口做 abort guard（`coordinator.ts:170-177`）
- coordinator 的 wrapAbort 在 Promise 落定后移除监听器

**缺失**：agent loop 的每轮循环、每个工具调用前，没有 `if (signal.aborted) throw ...` 检查。如果 worker 正在执行一个长时间运行的工具（如 `bash` 跑 10 分钟编译），AbortSignal 触发后 worker 不会立即停止——它要等当前工具执行完才在下一轮循环检测到（如果有检测的话）。

**修正建议**：spec §2.1 补充：

> 任务取消的可靠性取决于 agent loop 在两个关键点显式检查 AbortSignal：
> 1. 每轮循环开始前（若已 aborted，立即返回 cancelled 结果）
> 2. 每个工具调用前（若已 aborted，跳过工具执行）
> 工具执行中（如长时间 bash）的取消依赖工具自身的超时/信号传播，不在 task 层面解决。

### P0-2：超时和手动取消的交互未定义

spec 补了任务超时（`running → timed_out`），但一个任务可能同时被手动取消（`POST /cancel`）和超时触发。`AbortController.abort()` 可安全多次调用（第二次是 no-op），但状态转换需要定义：

- 任务已 `cancelled` → 超时触发 → 应保持 `cancelled`，不被覆盖为 `timed_out`
- 任务已 `timed_out` → 手动取消 → 应保持 `timed_out`（或转为 `cancelled`？需明确）

**修正建议**：状态转换规则加一条：

```
cancelled 是终态，不可被任何其他转换覆盖。
转换优先级：cancelled > timed_out > failed > completed
```

即：任何非 cancelled 状态可被取消打断转为 cancelled；任何非 cancelled/timed_out 状态可被超时打断转为 timed_out。

## 🟡 P1（重要）

### P1-1：prompt hash 作为唯一幂等 key 过于激进

同一 prompt 在不同时间、不同上下文下提交，可能需要确实是不同的 task。例如：
- 用户早 9 点问「检查仓库健康」→ 下午 3 点再问同样的话，应该是两个独立 task
- 两个不同 runtime 同时提交同一 prompt，可能是两个合法请求

**修正建议**：用复合幂等 key：

```
idempotency_key = hash(prompt + caller_id + time_bucket_5min)
```

- `time_bucket_5min`：把时间舍入到 5 分钟窗口。窗口外的重复 prompt 视为新 task。
- `caller_id`：来自姊妹 spec 的 ingress auth。不同调用方即使 prompt 相同也不去重。
- 保留 `force` 参数：显式跳过幂等检查，强制创建新 task。

### P1-2：KV 方案选型需要更具体的 MVP 决策

spec 说「SQLite 或 per-task JSON 文件」，两者取舍不同：

| 维度 | per-task JSON | SQLite |
|------|-------------|--------|
| 零依赖 | ✅ | ❌（better-sqlite3 native addon） |
| 并发安全 | ❌（同文件多写需锁） | ✅（WAL 模式） |
| 查询（列全部 task） | ❌（需 readdir + 逐个读） | ✅（SELECT） |
| MVP 适合度 | ✅（TaskRegistry 单例在进程内） | ⚠️（过度工程） |

**修正建议**：spec 明确 MVP 选 per-task JSON（`.rivet/tasks/{id}.json`），通过 `TaskStore` 接口抽象：

```typescript
interface TaskStore {
  save(task: TaskRecord): Promise<void>
  load(id: string): Promise<TaskRecord | null>
  list(filter?: TaskFilter): Promise<TaskRecord[]>
  delete(id: string): Promise<void>
}
```

未来换 SQLite 只需换实现，不动 TaskRegistry 逻辑。

### P1-3：notify policy 仅 log 级，调用方无主动感知路径

异步 task 模型下，调用方通过 `POST /prompt` 拿到 task id 后，唯一获取结果的方式是**主动轮询** `GET /tasks/:id`。log 级通知对自动化集成无用。

**修正建议**：notify policy 三档含义明确：

- `silent`：仅写 task 记录，无任何主动输出
- `state_changes`：状态变化时写一条结构化 log（JSON 行到 `.rivet/tasks/events.jsonl`），调用方可通过 `GET /tasks/:id/events?since=<timestamp>` 拉取
- `errors_only`：同 state_changes，但仅记录 failed/timed_out 事件

所有 notify 都走 task 记录持久化——"通知"本质上是「可查询的状态变化历史」，而非 push 机制（webhook 是后续优化）。

### P1-4：cron 触发 task 与手动 task 的区分

cron 触发的任务和 API/手动创建的任务在 TaskRegistry 中混在一起。审计时需要区分来源。

**修正建议**：TaskRecord 加 `source` 字段：

```typescript
type TaskSource = 'api' | 'cron' | 'manual' | 'internal'
```

cron 触发的 task 在 scheduler 创建时设 `source: 'cron'`，API 创建的设 `source: 'api'`。

## 🟢 P2（次要）

### P2-1：TaskBoard 投影层与 TaskRegistry 的数据流

spec 说「TaskBoard 继续做 UI 投影，TaskRegistry 作为其数据源」。当前 TaskBoard 监听 `WorkOrderQueue` 的事件（`task-board.ts:28-31`），而非 TaskRegistry。两个数据源需要合并或分层：

- **短期**（MVP）：TaskBoard 继续监听 WorkOrderQueue（TUI 任务），TaskRegistry 独立运行（daemon 任务）。两者在 MVP 不合并——TUI 的 TaskBoard 显示当前会话的 worker 调度，HTTP API 的 `/tasks` 显示 TaskRegistry 管理的 daemon 任务。
- **长期**：TaskRegistry 成为唯一数据源，TaskBoard 通过 TaskRegistry 获取数据（WorkOrderQueue 事件转发到 TaskRegistry）。

建议 spec 明确这个分层，避免实施时强行合并导致耦合。

### P2-2：任务超时默认值

spec 补了超时但未给默认值。建议：API 创建的 task 默认 30 分钟超时，cron 创建的 60 分钟。两者均可配置。

---

## 净结论

前两轮审查（天枢初查 + 天璇二次审查）已经覆盖了大量关键问题——SessionPersist 不适用、PromptEngine 无状态导出、任务超时/去重/持久化缺失。本轮发现的两项 P0（取消可靠性、超时-取消交互）是「有了设计但没想清楚边界」的类型，补上状态转换规则和 AbortSignal 检查点即可。P1 四项是精度优化，让方案从「可行」到「好用」。

**实施顺序微调**：

```
Phase 0（依赖姊妹 spec runtime 池就绪）
  ├─ TaskRegistry：生命周期 + 取消 + 超时（含状态转换优先级规则）★补充★
  │   + 去重（复合幂等 key：prompt + caller_id + time_bucket）★补充★
  │   + TaskStore 接口 + per-task JSON MVP 实现 ★补充★
  └─ agent loop：AbortSignal 检查点（循环前 + 工具前）★新增★

Phase 1（持久化 + 审计）
  ├─ TaskStore per-task JSON 实现
  ├─ TaskRecord.source 字段（api/cron/manual/internal）★补充★
  └─ GET /tasks /tasks/:id /tasks/:id/events 审计 API

Phase 2（调度 + 通知）
  ├─ scheduler.ts：cron/间隔 + 持久 schedule 表
  │   依赖 spec A 改造二的 nightcrawler max_turns 补丁 ★关键依赖★
  └─ notify policy：state_changes 写 events.jsonl ★补充★
```

**与 spec A 的交叉依赖**：本 spec Phase 2 的 scheduler 依赖 spec A 改造二的 nightcrawler max_turns 补丁。不补 max_turns，cron 触发的无人值守任务无限循环 → 应调整执行顺序：**先做 spec A 改造二的 P0-pre（nightcrawler max_turns），再做本 spec Phase 2**。

