# Spec A + Spec B 实施交接（2026-06-06 · 会话 bb1bbe0）

> 本会话完成：spec A 改造一 P0（对抗式 Verifier 核心）。剩余工作及依赖关系如下。

---

## 一、已完成

### 本会话 bb1bbe0 — Spec A 改造一 P0（对抗式 Verifier 核心）✅

| 变更 | 文件 | 内容 |
|------|------|------|
| 新增 `readonly_plus_test` role | `src/agent/profile-registry.ts:11` | AgentRole 类型扩展 |
| 新增 `adversarial_verifier` profile | `src/agent/profile-registry.ts:82-133` | 去 write/bash/edit/write_file，只留 run_tests + 只读工具，含完整对抗策略 prompt |
| WRITE_PROFILES_ADVISORY 移出 verifier | `src/agent/worker-evidence.ts:10` | 从 `['patcher', 'verifier']` → `['patcher']` |
| evidenceStatus 来源约束 | `src/agent/worker-evidence.ts:32-36` | 对抗 verifier 的 `verified` 直接接受，跳过 advisory/block 路径 |
| 同步 AgentRole 类型 | `src/agent/coordination-policy.ts:6` | 补 `'readonly_plus_test'` |
| 测试更新 | `src/agent/__tests__/profile-registry.test.ts` | 9 profiles, adversarial_verifier 断言 |
| 测试更新 | `src/agent/__tests__/worker-evidence.test.ts` | 3 个新测试：旧 verifier 已 blocked、对抗 verifier verified 直接接受、对抗 verifier unverified blocked |

### 后续会话 788b89c — Spec A 改造一 P1（验证缺失 nudge）✅

coordinator 聚合处：patch_proposal/hands 改动无配套 `adversarial_verifier` verify order 时注入标红提醒。

**验证**：typecheck 通过，31 个相关测试全部通过。

---

## 二、Spec A 改造一 剩余 — 无（全部完成 ✅）

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
