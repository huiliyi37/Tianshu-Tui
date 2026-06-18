# 会话管理与 resume 重做

> 2026-06-18 · CLI/TUI 会话标识三位一体 + 显式 resume + 会话列表

## 背景

排查缓存卡死时发现"查日志困难":会话 id 虽然内部已绑死(`getOrCreateSessionId()`
产出的同一个 UUID 贯穿 `<id>.jsonl` / `<id>.meta.json` / `<id>/cache-log.jsonl`),
但用户层面缺三样东西:

1. **无法指定会话 resume** —— `--continue`/`--resume` 只能恢复 per-cwd 指针里的"最后一个",
   没有 `--resume <id>`。
2. **运行时 `/resume` 身份分裂** —— 旧实现用无序 `readdirSync` 序号,且只把历史读进内存、
   **不切换** `currentSessionId`/`persist`/pointer。之后新消息写回**原** id,造成
   "看着是旧会话、其实存进新文件"的分裂,日志彻底对不上。
3. **列表信息贫乏** —— `/sessions`、Chronicle 只显示 id 前 8 位、不读 meta;现成的
   `listSessionsWithMetadata()`(带 title/updatedAt/turnCount/model、已排序)没接进 TUI。

设计原则:**会话 id = 日志 id = resume id = pointer id = registry id** 名副其实。
短前缀匹配(内部仍 UUID,零迁移),仅覆盖 CLI/TUI(桌面端/server/headless/worker 不动)。
呼应"可跨会话缓存,但不跨会话吃上下文":resume 仍全量 replay(显式代价、会重建前缀缓存),
切换时如实提示载入条数。

## 实现

### 基础设施 — `src/agent/session-persist.ts`

三个静态方法,CLI 与 TUI 共用,均基于已按 `updatedAt` 降序的 `listSessionsWithMetadata`:

- `listMainSessions(cwd)` — 主会话列表,排除 `worker-*` 子会话与带点后缀的
  `<id>.claims`/`<id>.memory` 等非 transcript 产物。
- `resolveSessionId(cwd, ref)` — 把完整 id 或短前缀解析为唯一完整 id:
  精确 id 优先 → 唯一前缀 → 多匹配返回 `{ ambiguous: string[] }`(调用方列候选)→ 无匹配 `null`。
- `formatSessionList(cwd, currentId?)` — 统一渲染。每行
  `序号 短id(8位) 相对时间 turns model domain title`,序号与 resume 解析同源,
  消除 Chronicle/`/resume` 序号漂移。

### CLI 入口 — `src/main.ts` / `session-recovery.ts` / `bootstrap.ts`

| 命令 | 行为 |
|------|------|
| `rivet sessions` / `rivet --list` | 打印 `formatSessionList` 后退出 |
| `rivet --resume <id前缀>` | `resolveSessionId` 解析 → `RIVET_RESUME_ID=<完整id>`;歧义/无匹配打印候选并退出(在 TTY 检查前,管道里也清晰) |
| `rivet --resume` / `--continue`(无参) | `RIVET_RESUME=1`,恢复最近会话 |
| `rivet --new` | `RIVET_NEW_SESSION=1`,强制全新会话 |

`StartupDecisionInput.resumeSessionId` 在 `decideStartupSession` 中为**最高优先**分支
(校验 `load(id)` 存在 + 内容可 replay + cwd 守卫),优先于 `resume`/`lastSessionId`;
`forceNew` 仍压过它。`getOrCreateSessionId()` 读 `RIVET_RESUME_ID` 传入决策。
顺手修掉 bootstrap 多处"crash 自动续接"过时注释(实际早已 fresh-by-default)。

### TUI 运行时 — `src/tui/slash-commands.ts` / `slash-router.ts`

- `/sessions` 改用 `formatSessionList`,显示 title/时间/turns/model,标注当前。
- `/resume <id前缀 或 序号>` —— 序号兼容旧习惯,前缀用 `resolveSessionId`;歧义列候选;
  解析后调用真正的身份切换。
- Chronicle 读 meta 渲染(title + 时间 + turns + model),Enter 填入 `/resume <id前8位>`
  (用 id 前缀而非序号,避免排序漂移)。

### 运行时身份切换 — `switchAgentSession(ctx, targetId)`(`bootstrap.ts`,核心)

与既有 `switchAgentRuntime`(模型切换)同构:经 `createAgentRuntime` **整体重建 AgentLoop**——
构造函数内部按 `targetId` 重建所有 sessionId-bound 子系统(`persist` / `telemetryWriter` /
`stigmergyStore` / `artifactStore` / `sessionStateManager` 与持久化监听),无需手工逐个换。

切换步骤:

1. 跨 cwd 守卫(meta.cwd ≠ 当前 cwd 拒绝)+ `runResumePreflightOai` 预检目标历史。
2. flush 旧会话信息素;经 `createAgentRuntime` 重建(保留当前模型,仅换会话身份)。
3. **原地更新** `ctx.agent/persist/sessionId` + `ctx.refs.sessionId/promptEngine` ——
   持有 ctx 引用的闭包(onSubmit/onAbort、每条命令重建的 handlerCtx)即时一致。
4. `session.replaceMessages(preflight.messages)`,新监听把历史镜像回 targetPersist。
5. 更新 pointer 文件 + `_cachedSessionId` + registry(unregister 旧 / register 新)。

`SlashHandlerContext` 新增 `onSessionSwitch` 回调(slash-router 接 `switchAgentSession`),
切换前先 `agent.abort()` 避免旧 run 写脏屏。

## 设计偏差(相对原计划)

计划写 `AgentLoop.switchSession`,实际落在 bootstrap 层 `switchAgentSession(ctx)`。
原因:运行时每条命令都从 `ctx` 重建 `handlerCtx`,只改 AgentLoop 内部无法让
`currentSessionId/persist` 一致,**必须**更新 BootstrapContext;且复用 `createAgentRuntime`
的整体重建比手工逐个换 store 更稳、与现有 `switchAgentRuntime` 同构。`SlashHandlerContext`
因此用 `onSessionSwitch` 回调而非 getter 字段,达成同样的"切换后即时一致"。

## 测试

- `resolveSessionId` / `formatSessionList` / `listMainSessions`:精确/唯一前缀/歧义/无匹配/
  排除 worker/空目录/标注当前(`session-persist.test.ts`)。
- `decideStartupSession` 的 `resumeSessionId`:命中/优先于 resume/不可读/无内容/跨 cwd 拒绝/
  forceNew 压制(`session-recovery.test.ts`)。
- `switchAgentSession` 确定性分支:已在目标会话、跨 cwd 拒绝(`switch-agent-session.test.ts`)。
  成功重建路径(重型,与 switchAgentRuntime 同构)由真终端手验。
- 端到端冒烟:`--list` 真实列表、`--resume <无匹配>`、`--resume <歧义前缀>` 均验证。

## 边界 / 不做

- 桌面端 `~/.rivet/desktop/sessions/` 与 server `GET /sessions` 不动。
- 不改 id 格式、不迁移历史会话(短前缀方案零迁移;旧短码会话与 UUID 会话混排,前缀匹配对两者通用)。
- 不碰 headless(`-p`)与 worker 子会话身份。
