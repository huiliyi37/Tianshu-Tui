# 审查报告：server 子系统（Spec A 改造二 + Spec B 全部）

> 日期：2026-06-06
> 审查范围：`src/server/` 下 10 个文件的全部新增代码
> 审查方法：主控 Opus 通读全量 + lifecycle agent / cron agent 并行专查
> 发现：22 个（2 CRITICAL + 6 HIGH + 6 MEDIUM + 4 LOW）→ 已在 3cfe855 + 51a26a3 修复

---

## CRITICAL（接线前必堵，当前因脚手架未活）

### C1 — HTTP server 默认 bind 0.0.0.0
- **锚点**：`src/server/index.ts:73`
- **问题**：`server.listen(port)` 无 host 参数 → Node 绑所有网卡。当前 server 暴露 `/status`（漏 sessionId）、`/abort`（任何人可掐本地会话）、`/tasks`（读全部任务 prompt）。
- **修复**：`server.listen(port, '127.0.0.1')`，非环回需显式 opt-in。

### C2 — 鉴权默认敞开 + 完全绕不过 GET
- **锚点**：`src/server/task-routes.ts:28-29`
- **问题**：`checkAuth: if (!expectedToken) return true` — fail-open。`extractToken` 只从 body 读 token，GET 请求无法鉴权。`req.headers` 全程没人读。
- **修复**：从 `Authorization: Bearer` header 读 token；无配置时拒绝启动；用 `crypto.timingSafeEqual`。

---

## HIGH

### H1 — allowedTools 持久化了但执行时被丢
- **锚点**：`src/server/task-registry.ts:35,298`
- **问题**：`RuntimeHandle.execute` 签名无 `allowedTools` 参数，调用处未传 → cron 任务声明的工具白名单永远到不了 AgentLoop。
- **修复**：`execute(prompt, signal, allowedTools?)`，透传 `record.allowedTools`。

### H2 — transition 非原子，丢更新 + 违反优先级裁定
- **锚点**：`src/server/task-registry.ts:154-182`
- **问题**：load→check→save 无 per-id 锁。timeout/cancel/catch 转换可交错，后写者赢。
- **修复**：per-id promise 链串行化 `transition()` 和 `createTask()`。

### H3 — dedup check-then-insert TOCTOU
- **锚点**：`src/server/task-registry.ts:113-134`
- **问题**：并发 `createTask` 同 key 都查不到活跃任务 → 都建。串行测试路径不暴露。
- **修复**：dedup 检查走 per-key 串行化。

### H4 — cron 解析器静默删除合法 schedule
- **锚点**：`src/server/cron-scheduler.ts:81-107`
- **问题**：`parseInt('*')=NaN → null` → tick 里当"永不触发"从表里删掉并持久化。
- **修复**：`add()` 时校验 cron 表达式，非法立即抛错。

### H5 — .rivet/ 不存在时所有 schedule 静默丢失
- **锚点**：`src/server/cron-scheduler.ts:60-64`
- **问题**：`atomicWriteSchedule` 写前无 `mkdirSync`，干净 checkout 上 `.rivet/` 不存在 → `writeFileSync` 抛 `ENOENT` → 空 catch 吞掉。
- **修复**：写前 `mkdirSync(dirname(path), { recursive: true })`。

### H6 — SSE 不检测客户端断连
- **锚点**：`src/server/prompt-route.ts:26-65`
- **问题**：`handlePromptSSE` 没监听 `res.on('close')`。客户端断开后 agent 跑到底。
- **状态**：当前未接线，降级延后。

---

## MEDIUM

### M1 — tick 可重入双触发
- **锚点**：`src/server/cron-scheduler.ts:203-209`
- **问题**：`setInterval` 不等上次 `async tick` 结束，无重入守卫。
- **修复**：加重入守卫 `this.ticking`。

### M2 — seq 单调性不持久
- **锚点**：`src/server/task-routes.ts:108-121`
- **问题**：`nextSeq` 读最后一行 +1；末行截断 → catch 返回 1 重置。
- **状态**：延后修复。

### M3 — 空 allowedTools 反转成"无限制"
- **锚点**：`src/server/cron-wiring.ts:60`
- **问题**：`length>0 ? : undefined`，显式 `[]`（锁死零工具）被转成 `undefined`=默认全量。
- **修复**：保留 `[]` 语义。

### M4 — JSON 损坏整表清空
- **锚点**：`src/server/cron-scheduler.ts:66-76`
- **问题**：单字节损坏 → `JSON.parse` 抛异常 → 全部 schedule 静默没。
- **状态**：延后修复。

### M5 — 全子系统系统性吞错
- **锚点**：几乎所有文件
- **问题**：几乎所有失败路径都是空 `catch{}` / `.catch(()=>{})`，无日志。
- **状态**：需引入 logger 后批量修复。

### M6 — /status、/abort 零鉴权
- **锚点**：`src/server/routes.ts:14-23`
- **问题**：即使 task 路由配了 token，这俩仍全开。
- **状态**：localhost 限定后降级为 MEDIUM，延后修复。

---

## LOW

### L1 — task id 无意图性校验
- **锚点**：`src/server/task-store.ts`
- **问题**：store 方法无路径校验，靠 router 的 `[^/]+` 挡住了 `../` 遍历，但缺显式 allowlist。
- **状态**：延后修复。

### L2 — 手搓 timingSafeEqual 泄漏长度
- **锚点**：`src/server/task-routes.ts:35`
- **问题**：`a.length!==b.length` 短路泄漏 token 长度。
- **修复**：已用 `crypto.timingSafeEqual` 替换。

### L3 — in-place 变异
- **锚点**：`src/server/cron-scheduler.ts:261-262`
- **问题**：`task.triggerCount++`、`task.lastTriggeredAt =` 违反不可变规范。
- **状态**：延后修复。

### L4 — 方括号绕私有写入
- **锚点**：`src/server/cron-wiring.ts`
- **问题**：`scheduler['onCreateTask']=` 方括号绕私有，失去 observer 语义。
- **状态**：代码已自注释为单回调设计的妥协。

---

## 修复记录

| 提交 | 覆盖 |
|------|------|
| `3cfe855` | C1, C2, L2 |
| `51a26a3` | H1, H2, H3, H4, H5, M1, M3 |
| 延后 | H6, M2, M4, M5, M6, L1, L3, L4 |
