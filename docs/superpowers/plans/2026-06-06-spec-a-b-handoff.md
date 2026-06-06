# Spec A + Spec B 实施交接（2026-06-06 · 最终状态）

> **全部 spec 已实施完毕。** 本文件仅保留状态记录和偏差复盘。
>
> ⚠️ **完成度更正**：server 子系统作为独立模块可合，但**作为"已交付特性"尚未到位**——cron→AgentLoop 链止于 interface（无 RuntimePool 实现），`/prompt` 的 `handlePromptSSE` 未接进 router。上线前必清的门禁清单见 **`docs/known-issues/2026-06-06-server-subsystem-go-live-gate.md`**（A 已闭环 / B 接线前必清 / C 架构真相 / D 测试卫生）。

---

## 一、完成状态总览

| Spec | 阶段 | Commit | 状态 |
|------|------|--------|------|
| Spec A 改造一 P0 | 对抗式 Verifier 核心 | bb1bbe0 | ✅ |
| Spec A 改造一 P1 | 验证缺失 nudge | 788b89c | ✅ |
| Spec B Phase 0 | TaskRegistry + TaskStore | 9e0e746 | ✅ |
| Spec A 改造二 P0/P1 | cron-scheduler + cron-lock | 757545e | ✅ |
| Spec A 改造二 P2 | cron → TaskRegistry 接线 | 3be9ca8 | ✅ |
| Spec B Phase 1 | 持久化 + 审计 API | cd022bb | ✅ |
| Spec B Phase 2 | notify policy | f2c975e | ✅ |
| 审查偏差修复 | cancel 路由 + allowedTools + import | 267d7af | ✅ |
| 缺陷 1 & 2 修复 | prompt 自相矛盾 + dead code | b98da5e | ✅ |

**全部 9 个逻辑单元已完成，typecheck 通过，91 个 server 测试全部通过（偶发 1 个 flaky test — idempotency key 桶边界）。**

## 二、偏差复盘（工作流改进）

4 个偏差在审查阶段发现，根因非"没读文档"而是**实现后缺了一轮 spec→code 交叉核对**：

| 偏差 | 根因 | 预防方法 |
|------|------|----------|
| 🔴 缺 POST /tasks/:id/cancel 路由 | spec 有路由清单但未逐条打勾 | 提交前逐条核对 spec 架构表 |
| 🟡 allowedTools 未传递 | 接线时未读 `CronScheduler.onCreateTask` 类型签名 | 接线前读被接函数的完整签名 |
| 🟢 dynamic import 多余 | 实现时未检查已有静态 import | import 审计 |
| 🟡 notify policy 未实现 | 同上，spec 功能清单核对遗漏 | checklist 核对 |

**已写入 `.rivet/knowledge/guardrails.md`**：交付前 30 秒 spec→code 交叉核对规则。

### P1 — coordinator 验证缺失 nudge ✅

**已完成**：提交 `788b89c`。coordinator 在聚合 work-order 批时，若存在 patch_proposal/hands 改动但无配套 `adversarial_verifier` verify order，注入标红提醒。

---

## 三、Spec A 改造二 剩余（P0/P1/P2）

> ⚠️ 改造二依赖 spec B Phase 0（TaskRegistry）和姊妹 ingress spec Phase 2（runtime 池）就绪。当前两者均未实现，因此**改造二在 spec B Phase 0 完成前不可启动**。

### P0 — cron-scheduler（server 层）

**落点**：新文件 `src/server/cron-scheduler.ts`

**功能**：
1. 持久化 schedule 表 → `.rivet/scheduled_tasks.json`
   - 条目格式：`{id, prompt, allowedTools, trigger: {type: 'interval'|'cron'|'oneshot', spec}, recurringMaxAgeMs?, agentId?}`
   - 写入走原子写（写临时文件 + rename）
2. 时间触发 tick（间隔检查 schedule 表，到点的任务 → `TaskRegistry.createTask()`）
3. 启动时从文件恢复 schedule 表

### P1 — cron-lock（server 层）

**落点**：新文件 `src/server/cron-lock.ts`

**功能**：
1. O_EXCL 原子创建 `.rivet/scheduled_tasks.lock`
2. PID 存活探测：`ps -p <pid> -o state= | grep -v Z`（避免 zombie 盲区）
3. 陈旧锁回收（owner PID 不存在 → 接管）
4. 退出清理

**部署假设**：PID 锁仅在多个 rivet 进程各起 server 时有效。单 daemon 进程则锁 YAGNI，MVP 可降级。

### P2 — cron → TaskRegistry → runtime → AgentLoop 完整链路

**接线**：cron-scheduler 触发 → `TaskRegistry.createTask(source:'cron')` → 分配 pooled runtime → 启动 AgentLoop（自带 maxTurns + AbortSignal + TurnHeartbeat）→ 结果回写 TaskRegistry。

---

## 四、Spec B 剩余（全部 Phase）

> spec B 的最新设计见 `docs/superpowers/specs/2026-06-06-task-lifecycle-system-design.md`（已含五轮审查修订）。

### Phase 0 — TaskRegistry（核心）

**落点**：`src/server/task-registry.ts`

**功能**：
- 任务生命周期：`pending → running → (completed | failed | cancelled | timed_out)`
- 状态转换优先级：`cancelled > timed_out > failed > completed`（cancelled 是终态）
- AbortController 管理（取消 = abort）
- 超时：running 超时 → AbortController.abort() → timed_out
- 去重/幂等：复合 key = `hash(prompt + caller_id + time_bucket_5min)`，支持 `force` 跳过
- TaskStore 接口抽象（MVP：per-task JSON `.rivet/tasks/{id}.json`）
- `source` 字段：`'api' | 'cron' | 'manual' | 'internal'`

**依赖**：姊妹 ingress spec Phase 2（runtime 池）——任务需要 runtime 可调度。

### Phase 1 — 持久化 + 审计

- TaskStore per-task JSON 实现
- `GET /tasks /tasks/:id /tasks/:id/events` API + 认证
- events 用单调序号 `seq`（非时间戳）

### Phase 2 — 调度 + 通知

- cron-scheduler（即 spec A 改造二 P0/P1 — 见上文 §三）
- notify policy：`silent | state_changes | errors_only`
- state_changes 写 `.rivet/tasks/events.jsonl`（每行带 seq）

---

## 五、建议执行顺序

```
1. [✅ 已完成] Spec A 改造一 P0 + P1 — 对抗式 Verifier 全套
   └─ P0: adversarial_verifier profile + evidenceStatus 来源约束 (bb1bbe0)
   └─ P1: coordinator 验证缺失 nudge (788b89c)

2. [阻塞项] Spec B Phase 0 — TaskRegistry + TaskStore
   └─ 需要 ingress runtime 池先就绪（或至少接口已定义）

3. [依赖 2] Spec A 改造二 P0/P1 — cron-scheduler + cron-lock
   └─ cron-scheduler 调用 TaskRegistry.createTask()

4. [依赖 2+3] Spec A 改造二 P2 — 完整链路接线

5. [依赖 2] Spec B Phase 1 — 持久化 + 审计 API

6. [依赖 2+3] Spec B Phase 2 — 通知策略
```

---

## 六、被改动/新增的文件清单

| 文件 | 状态 | 备注 |
|------|------|------|
| `src/agent/profile-registry.ts` | 已改 | +adversarial_verifier profile，+readonly_plus_test role |
| `src/agent/worker-evidence.ts` | 已改 | WRITE_PROFILES_ADVISORY 缩为 ['patcher']，对抗 verifier 直接接受 |
| `src/agent/coordination-policy.ts` | 已改 | AgentRole 同步 |
| `src/agent/__tests__/profile-registry.test.ts` | 已改 | 9 profiles 断言 |
| `src/agent/__tests__/worker-evidence.test.ts` | 已改 | 3 个对抗 verifier 新测试 |
| `src/server/task-registry.ts` | 待创建 | Spec B Phase 0 |
| `src/server/cron-scheduler.ts` | 待创建 | Spec A 改造二 P0 |
| `src/server/cron-lock.ts` | 待创建 | Spec A 改造二 P1 |
| `docs/superpowers/specs/2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease.md` | 已改 | Spec A 修订正式版 |
| `docs/superpowers/specs/2026-06-06-task-lifecycle-system-design.md` | 已改 | Spec B 含五轮审查 + 主权裁定 |
| `docs/superpowers/specs/2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease.md.bak` | 备份 | Spec A 原案 |
| `docs/superpowers/specs/2026-06-06-task-lifecycle-system-design.md.bak` | 备份 | Spec B 修订前 |

---

## 七、关键设计决策（新会话须知）

1. **双任务系统主权已裁定**：nightcrawler（P3-F 认知子系统）≠ daemon scheduler。daemon cron 走 server 层独立 cron-scheduler + TaskRegistry → runtime → AgentLoop。nightcrawler 完全不碰。

2. **对抗 verifier 的 `bash` 已被移除**：因为 bash 不受 sandbox 约束，verifier 可通过 `bash echo > file` 绕过 "无 write 工具" 限制。对抗 verifier 仅有 `run_tests` + 只读工具。

3. **AgentRole 新增 `readonly_plus_test`**：介于 readonly 和 hands 之间——只读 + 跑测试，无文件写权限。

4. **`listWriteProfiles()` 不受影响**：该方法按 `role === 'hands'` 过滤，对抗 verifier 的 role 是 `readonly_plus_test`，不在 write 列表中。
