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
- 拥有任务生命周期：`pending → running → (completed | failed | cancelled)`，复用 `BoardTaskStatus` 并补 `cancelled`。
- 每个任务持有：id、objective、目标 runtime（来自姊妹 spec 的 runtime 池）、AbortController、时间戳、结果/错误。
- 取消：调用任务的 AbortController → 复用 coordinator 现成 `AbortSignal` 传播（`coordinator.ts:81`），不新造取消机制。
- 与 ingress 衔接：姊妹 spec 的 `POST /prompt` 不再直接驱动 loop，而是**创建一个 task** → TaskRegistry 调度到 runtime → 返回 task id（异步）；`GET /tasks/:id` 查状态，`POST /tasks/:id/cancel` 取消。

**2.2 调度器（cron，新增）** — `src/server/scheduler.ts`
- 定时触发任务（cron 表达式或间隔）。最小实现：`setInterval` + 持久化的 schedule 表，不引重依赖。
- 用途示例：天枢可被设定「每晚跑一次仓库健康检查」——这才是「常驻协作者」而非「被动应答」。

**2.3 任务记录持久化（新增）** — 复用 `SessionPersist` 模式
- 任务记录（含状态流转、结果）原子写入 `.rivet/tasks/`，进程重启可恢复未完成任务的可见性与审计。
- 与姊妹 spec 的 runtime SessionPersist 接线同源，不重造。

**2.4 通知策略（新增）** — `notify policy`：`silent | state_changes | errors_only`
- 任务状态流转时按策略输出（终端/log/未来可接 webhook）。最小实现先支持 log 级。

**2.5 审计** — `GET /tasks` 列出全部任务及状态，`TaskBoard` 投影层继续服务 UI（不动），TaskRegistry 作为其数据源。

---

## 3. 架构落点

| 变更 | 文件 | 性质 |
|------|------|------|
| TaskRegistry（拥有式任务生命周期） | 新 `src/server/task-registry.ts` | 新增（复用 BoardTaskStatus + AbortSignal） |
| 调度器（cron/间隔） | 新 `src/server/scheduler.ts` | 新增（最小 setInterval + 持久 schedule） |
| 任务记录持久化 | 复用 `session-persist.ts` 模式 → `.rivet/tasks/` | 接线 |
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
  └─ TaskRegistry：生命周期 + 取消（复用 AbortSignal）
     验证：创建/运行/完成/取消全状态可查

Phase 1（持久化 + 审计）
  ├─ 任务记录写 .rivet/tasks/（复用 SessionPersist 模式）
  └─ GET /tasks /tasks/:id 审计 API + 认证
     验证：重启后任务记录可见 + 无 token 被拒

Phase 2（调度 + 通知）
  ├─ scheduler.ts：cron/间隔触发（定时任务 allowedTools 更严）
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
