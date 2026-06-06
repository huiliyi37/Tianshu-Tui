# Server 子系统 Go-Live Gate — Spec A/B 收束门禁

> 日期：2026-06-06  
> 分支：`fix/stall-root-causes-abort-exit`  
> 结论：**A 类已闭环，可合入分支；B 类是上线门禁；C/D 是交付真相与测试卫生。**  
> 使用方式：读 `spec-a-b-handoff.md` 时必须同时读本文件；本文件优先修正交接文档里“已完整接线/已交付”的过度表述。

---

## 1. 关联表（必读入口）

| 文档 | 角色 | 用途 |
|---|---|---|
| `docs/superpowers/specs/2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease-修订正式版.md` | Spec A 正式版 | 对抗式 verifier、server 层 cron/lease、cron→TaskRegistry 接线边界 |
| `docs/superpowers/specs/2026-06-06-task-lifecycle-system-design-修订正式版.md` | Spec B 正式版 | TaskRegistry、TaskStore、审计 API、events 单调 seq、通知/SSE |
| `docs/superpowers/plans/2026-06-06-spec-a-b-handoff.md` | 实施交接 | 已完成提交、偏差复盘、历史执行顺序；其完成度声明需以本 gate 修正为准 |
| `docs/superpowers/specs/2026-06-06-review-squadron-design.md` | 审查方法论 | 并行 Inspector 方法、§5 修复提交审查规则、绿声明 fail-closed、删除行同等审视 |

**门禁映射规则：**B 类每条缺陷右列都标注对应 spec/方法章节。典型映射：H6 → Spec B 通知/SSE 章；M2 → Spec B “events 用单调 seq”；M4 → Spec A/B 持久化“原子写 tmp+rename / 坏文件隔离”。

---

## 2. A 已闭环（12 项）

| # | 项 | 提交 | 验证方式 | 实跑/证据 |
|---|---|---|---|---|
| A1 | C1：server 绑定 `127.0.0.1`，避免默认外网暴露 | `3cfe855` | 读码 | `startServer` bind 地址已收窄 |
| A2 | C2：认证 fail-closed + Bearer header + 常量时间 token 比较 | `3cfe855` | 读码 | `crypto.timingSafeEqual` 路径在无 token/错 token 时拒绝 |
| A3 | H1：`allowedTools` 透传到 `TaskRegistry.createTask/execute` | `51a26a3` | 读码 | cron wiring 不再丢工具权限 |
| A4 | H2：状态转换 per-id 串行化 | `51a26a3` | 单测 | server 生命周期测试覆盖 transition 竞态 |
| A5 | H3：dedup TOCTOU 真修（find + build + save 同锁） | `411a51f` | 并发测试 | 并发 create 同幂等 key 不再重复落盘 |
| A6 | H4：interval 校验 + recurring `null` 不静默删 | `51a26a3` + `411a51f` | 读码 + 单测 | invalid interval / recurring null 路径不吞 schedule |
| A7 | H4 回归修：恢复 `toFire.push` 触发路径 | `4dbaea0` | 触发测试 | tick 502ms / interval 403ms 场景恢复触发 |
| A8 | H5：写 schedule 前创建 `.rivet/` 目录 | `51a26a3` | 读码 | `mkdirSync(dirname, { recursive: true })` 先于原子写 |
| A9 | M1：cron tick 重入守卫 | `51a26a3` | 单测 | `this.ticking` 防并发 tick 交叠 |
| A10 | M3：空 `allowedTools: []` 保留“禁用工具”语义 | `51a26a3` | 读码 | 不再用 falsy fallback 覆盖成默认工具集 |
| A11 | idLocks 泄漏清理：只删除当前 settled promise | `411a51f` | 读码 | `get(key) === settled` 才删，避免误删新锁 |
| A12 | L2：token 比较侧信道修复（并入 C2） | `3cfe855` | 读码 | 常量时间比较路径已覆盖 |

**记录实跑结果（2026-06-06）：**
- `cron-scheduler` 套件：**27/27 绿**。
- 全 server 套件：**112/113**；唯一红为 §4.D 的 flaky 时间桶边界测试，重跑可绿，不代表 A 类修复失败。

---

## 3. B 上线门禁（8 项，接线前必清）

> 这些缺陷现在部分“不活”，是因为 §4.C 的 RuntimePool / `/prompt` SSE 两条接线尚未完成。**一旦接 RuntimePool 或接 `handlePromptSSE`，本节会立即变成可利用/可观测风险。上线前必须全部清掉。**

| # | 锚点 | 风险 | 修法 | 关联 spec / 方法章节 |
|---|---|---|---|---|
| **H6** | `src/server/prompt-route.ts:26-65` | SSE 不检测客户端断连，用户断开后 agent 继续跑到底 → token 成本泄漏 / 本地 DoS 放大 | `res.on('close', () => agent.abort())`；写 SSE 前检查 socket 状态；close 后停止后续 write | Spec B §2.4 通知策略 / SSE；Spec B §4 安全 |
| **M6** | `src/server/routes.ts:14-23` | `/status` `/abort` 零鉴权；任意本地进程可读 sessionId 或掐任务 | 在 `startServer` 请求入口设置统一鉴权门，覆盖 `/prompt`、`/tasks*`、`/status`、`/abort` | Spec B §2.5 审计 API；Spec B §4 认证安全 |
| **M2** | `src/server/task-routes.ts:108-121` | events `seq` 不持久：末行截断重置为 1；并发 append 可同 seq；每次 O(file) 扫描 | 内存权威 seq 计数器 + sidecar `.seq` 原子写；恢复时扫 max(seq)，解析失败不得重置为 1 | Spec B §2.4 “state_changes 写 events.jsonl”；天枢补强：events 用单调 seq |
| **M4** | `src/server/cron-scheduler.ts:66-76`；TaskStore JSON 读路径 | JSON 单字节损坏 → schedule / task 表整表清空或静默消失 | 逐条 Zod 校验；坏条目单独丢弃并记录；整文件 parse 失败 rename 为 `.corrupt-<ts>`；写入继续走 tmp+rename | Spec A §2.2(a) 持久化 schedule 表；Spec B §2.3 per-task JSON；持久化“原子写 tmp+rename”章 |
| **M5** | 几乎所有 `src/server/*` catch 边界 | 系统性空 `catch {}` / `.catch(() => {})` 吞错；daemon 失败无信号，线上不可诊断 | 接入最小 logger；所有吞错改为 `logger.warn/error`，确需忽略时写明原因和上下文 id | Review Squadron §5.3 绿声明 fail-closed / 静默吞错审查；coding-style“绝不静默吞错” |
| **L1** | TaskStore `save/load/delete` id 边界 | 当前主要靠 router 正则挡路径遍历；store 层被直接调用时仍脆弱 | store 边界加 `^[A-Za-z0-9_-]+$`；`resolve` 后断言落在 `.rivet/tasks` 目录内 | Spec B §4 安全；TaskStore 边界防御 |
| **L3** | `src/server/cron-scheduler.ts:235-236`、`src/server/routes.ts:21` | in-place 变异 + `list()` 同引用外泄；外部可绕过状态机修改内部记录 | 用 reducer/setter/事件替代直写；`list()` 返回深拷贝或冻结对象 | Spec B §2.1 TaskRegistry 单点状态机；Review Squadron §5.5 删除/变异审查 |
| **L4** | `src/server/cron-wiring.ts` 方括号私有写入 | `scheduler['onCreateTask'] = ...` 绕过私有/observer 语义；后续多订阅会互相覆盖 | 明确 emitter/subscribe API；多订阅用 `EventEmitter` 或回调数组，禁止私有字段方括号接线 | Spec A §2.2 时间触发循环；Review Squadron §5.5 修复提交高危接线审查 |

---

## 4. C 架构真相 + D 测试卫生

### C. 架构真相：可合 ≠ 已交付

1. **RuntimePool 仍无具体实现。**  
   当前 `TaskRegistry` 只有 runtime pool interface；`scheduleExecution` 需要 `if (this.runtimePool)` 才能真正执行。因此 `cron → TaskRegistry → AgentLoop` 链路目前止于 interface，Spec A 改造二 P2 的“完整链路接线”应更正为“接口级接线”。

2. **`handlePromptSSE` 写好但未接进 router。**  
   `/prompt` 当前仍走 `buildPromptHandler` 的校验/回显路径，没有 spawn agent，也没有把 SSE close 信号接到 agent abort。因此它不是已交付的 HTTP agent 入口。

3. **因此 B 类风险的性质是“接线即变活”。**  
   今天测试绿只证明 server 脚手架内部逻辑可工作，不证明常驻协作者特性已上线。真正 go-live（接 RuntimePool + 接 `handlePromptSSE`）前，§3 必须先清。

### D. 测试卫生：flaky 修法

- **flaky 用例：**`task-registry.test.ts` 的 `same prompt+caller+time bucket produces same key`。
- **根因：**测试用 `Date.now() + 60_000` 构造第二个时间点；若当前时间靠近 5 分钟 bucket 末尾，`+60_000` 会跨桶，导致“同 bucket”断言偶发失败。
- **修法：**把 base 钉在 bucket 中点或固定桶内偏移：

```ts
const bucketMs = 300_000
const base = Math.floor(Date.now() / bucketMs) * bucketMs + 60_000
```

然后用 `base` 与 `base + 1_000` 做同桶断言；跨桶测试显式用 `base + bucketMs`。

---

## Go-Live 判定

| 层级 | 判定 |
|---|---|
| Server 子系统作为独立模块 | **可合入分支**：A 类 12 项已闭环，cron-scheduler 27/27，全 server 112/113（唯一 flaky 已定位） |
| Server 子系统作为已交付特性 | **未到位**：RuntimePool 与 `/prompt` SSE 未接，当前是脚手架不是活系统 |
| 真正 go-live | **阻塞**：必须先完成 §3 八项门禁 + §4.D flaky 修复，再接 RuntimePool / `handlePromptSSE` |

> 审查方法底线：读≠验；删除行与新增行同等审视；改 X 必跑覆盖 X 的既有测试；任何“全绿/已修复”声明若无命令+输出证据，按未验证处理。来源：`docs/superpowers/specs/2026-06-06-review-squadron-design.md` §5。
