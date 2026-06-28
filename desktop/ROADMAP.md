# 天枢桌面版 — 迭代路线

本轮（M0 → M3）忠实照搬 Antigravity 2.0 范式主线：**独立桌面 App、无 IDE、agent-first**
——打开就是「和 agent 对话 + 看它产出的 artifacts + 在 artifacts 上给反馈」，多会话同步/异步管理。

> 缰绳：runtime 内核不重写，只在 `src/server/` 加 API 面；不破 prompt frozen/cache 不变量
> （每会话独立 PromptEngine）；sidecar 只绑 127.0.0.1 + token fail-closed；SSE 必带 seq、可重连、
> 可补读；复用 `ArtifactStore` / `TaskRegistry` / `SessionRegistry`，各归其位不揉成上帝对象。

## 本轮已交付（M0–M3）

| 阶段 | 内容 | 交付物 | 验证 |
|------|------|--------|------|
| M0   | sidecar 骨架 + 单条对话 | `rivet serve` 进发行入口 `src/main.ts`；`src/server/serve.ts`；Tauri 外壳 spawn + 注入随机 token + 健康检查 | `node dist/main.js serve` 实跑：缺 token → exit 1；401 fail-closed；仅绑 127.0.0.1 |
| M0.5 | 多会话后端 | `src/server/session-manager.ts`（seq 事件日志 / `?since=` 补读 / 断线不 abort / 每会话独立 AgentLoop+PromptEngine+ArtifactStore）+ `session-routes.ts` | 12 条反证测试绿（并行不串味、viewer 断开≠abort、since 补读、abort 只杀目标） |
| M1   | Agent Manager | 前端多会话 dashboard（状态/phase/进度/待审批卡片）+ 新会话入口；Project = cwd（多文件夹边界由 path-grants + self/world locus 在工具层兜底） | 前端 `npm run build` 通过（tsc + vite） |
| M2   | 审批介入 + 事件总线 | B2 requestId 化 approval/intent 双向协议 + `/interventions/:rid/answer`；B3 补 phase/checkpoint/thinking + seq + 可重连 SSE `/stream`；前端审批 modal | 路由层 + manager 测试绿（pending→answer→resolve、abort 不挂起 promise） |
| M3   | Artifacts 信任层 | B4 复用 `ArtifactStore` 升为 session API + taxonomy（plan/task-list/walkthrough/diff/screenshot/test-result）；前端 Artifacts 面板 + 查看 raw | `classifyArtifact` + 跨会话不串读测试绿；`readRaw()` 完整性沿用原 store |

**验证边界（诚实声明）**：后端全部 `node:test` 覆盖并通过、`tsc --noEmit` 与发行 `tsup` 构建均绿；
桌面前端 `tsc + vite build` 绿。Rust 外壳自 N 阶段起已在本机实跑（见下）。

## N 阶段已交付（N0–N5）—— Antigravity 2.0 平价能力与细节建设

在 M0–M3 基座上补齐 Antigravity 2.0 其余主线（暂不做星域/议事会个性化 I1），并把真实 Tauri
启动 + 单平台打包纳入交付门。

| 阶段 | 内容 | 交付物 | 验证 |
|------|------|--------|------|
| N0 | 前端架构重构 | TanStack Query 数据层 + UI store（Context+reducer）+ 类型化 `state/event-reducer.ts` + `runtime/sse.ts`（fetch ReadableStream 带 Authorization 消费 `/stream`，`?since=` 回灌）+ `surfaces/` 模块布局 | `event-reducer` 单测绿；前端 `tsc + vite build` 绿 |
| N1 | 后端持久化与韧性 | `FileSessionPersistence`（`index.json` + append-only `events.jsonl`）；`RuntimeSessionManager` 懒实例化 agent + 启动 rehydrate（running→aborted 终态标记）；`GET /health`；前端崩溃重连 banner | 持久化/rehydrate/health 反证测试绿（损坏尾行不致命、seq 不回退、重启可回放） |
| N2 | 信任层闭环 | `POST /sessions/:id/feedback` 把 artifact 评论回灌下一轮；审批 modal 渲染 diff 并支持 `editedInput`；`intent_required` → IntentModal（continue/veto/alternative）；`@tauri-apps/plugin-notification` 失焦时 OS 通知 | `n2-trust` 路由+manager 测试绿 |
| N3 | 异步与编排 | `SessionRuntimePool`（`RuntimePool`→manager 桥，定时任务出现为可见会话）+ `manager.runAndWait`；`CronScheduler/TaskRegistry/CronWiring` 接进 `serve`；`/schedule` 路由 + ScheduleSurface；`onToolUse/Result` 合成 `delegation` 事件 + 委派树 + Inbox | `n3-orchestration` 测试绿（spawn 可见会话、summary/changedFiles、schedule CRUD、委派合成） |
| N4 | 浏览器验证面 | `src/tools/browser.ts`：`BrowserDriver` 抽象 + Playwright 实现（动态加载）；**fail-closed 域白名单** + **强制 approval**；截图落 `browser_screenshot` → `screenshot` artifact，前端渲染为 `<img data:…>` | `browser` 工具层测试绿（空白名单全拒、越界拒、协议拒、driver 不预建、always-approval） |
| N5 | 分发门 | `bundle.resources` 把 `dist/` 装为 `rivet-runtime` 资源；`lib.rs` 在 `setup` 内 spawn，`sidecar_entry` 优先解析打包资源、`detect_node()` 兼容 Finder 最小 PATH；CSP 加 `img-src 'self' data:` 供截图 | **本机实跑**：`tauri:build` 出 `天枢.app`（含 `Resources/rivet-runtime/main.js`）；`tauri:dev` 起窗 → 子进程 sidecar 经资源路径拉起、监听 127.0.0.1、401 fail-closed |

**N5 分发决策（诚实声明）**：sidecar 采用 **ship `dist/` 资源 + 探测系统 node** 方案——`tsup` 把
运行时打成自包含 ESM chunk（`better-sqlite3` 运行时可选），随 Tauri `bundle.resources` 进
`Resources/rivet-runtime/`；node 走 `detect_node()`（Homebrew/usr 常见路径 + PATH 兜底）。**内置私有
node 二进制与 DMG/安装器封装暂缓**——`bundle.targets` 当前限定 `["app"]`（`.app` 为可直接运行交付物；
`bundle_dmg.sh` 需 Finder GUI 自动化，留待干净 release CI）。三平台矩阵仍留 I7。

## 后续迭代（本轮不做，按 Antigravity 2.0 其余能力 + 天枢个性化排序）

### I1 — 星域 agent 名册 + 议事会评审（天枢的反转支柱） ✅ 已交付
把 Antigravity 的**匿名 dynamic subagents** 升级为[北斗八星人格](../src/agent/star-domain.ts)：各带
decisionStyle / toolWhitelist / 方法论 suffix / glyph+accent。新会话/子代理自动匹配星域，Agent Manager
卡片显示星符；重大决策唤起「星图议事会」——多星**对抗性评审**（对标 2.0 review flow，但是有名有姓
互不服的评审团，而非黑箱 artifact）。复用 [`DelegationCoordinator`](../src/agent/coordinator.ts) +
[`ProfileRegistry`](../src/agent/profile-registry.ts)。
- 交付物：
  - 后端：`SessionRecord.domainGlyph/accent` + `DomainEntry.uiPersona`；`AgentLoop.isRunning()`；
    `ManagedAgent.conveneCouncil` + `POST /sessions/:id/council`；council 从 artifact raw 中解析
    `council-plan-json` 并产出 plan markdown artifact。
  - 前端：`ProjectSidebar`/`ThreadTabs`/`ThreadView` 星符徽章；`CouncilSurface` 表面；路由/ Rail /
    侧边栏 / 快捷键 / i18n 注册。
- 验证：`council-route.test.ts` 7 条绿；桌面 `tsc --noEmit` + `npm test` 绿。

### I2 — Scheduled Tasks（`/schedule`）✅ 已在 N3 交付
把已有 [`CronScheduler`](../src/server/cron-scheduler.ts) + [`TaskRegistry`](../src/server/task-registry.ts)
+ `CronWiring` 接进 daemon（含实现 `RuntimePool` 让定时任务复用 RuntimeSessionManager），GUI 管理
cron / 一次性定时任务。
- 验收：建一个每日 cron 任务，到点自动 spawn 一个会话跑通并在 dashboard 出现；可暂停/删除。

### I3 — Dynamic subagents UI + slash 对齐（委派树部分 ✅ 已在 N3 交付）
可视化委派树（谁派了谁、各自 phase/产出）；slash 对齐：`/goal`（TUI `/goal` 与 headless `--goal`
共用 [`src/agent/goal-tracker.ts`](../src/agent/goal-tracker.ts)）、`/grill-me`（≈ 现有 `/interview`）。
- 验收：一个会话委派 2 个子代理，UI 实时画出树与状态；`/goal` 从前端可发起。

### I4 — JSON hooks 面板 ✅ 已交付
`.rivet/hooks.json` 的编辑 / 巡检 / 启停（[`src/hooks/user-hooks-runner.ts`](../src/hooks/user-hooks-runner.ts)）。
- 交付物：
  - 后端：`GET /sessions/:id/hooks` + `PUT /sessions/:id/hooks`；`user-hooks-bridge.ts` 为 `preTurn/postTurn/postTool/postSession`
    发出 `hook_result` 事件；新增 `onError` 桥接，runtime hook 抛错时触发 `onError` hooks；
    `RuntimeSessionManager.emitHookResult` 追加事件并保留最新 50 条。
  - 前端：`HooksSurface` 编辑 hook 条目并展示最近 `hook_result`；`event-reducer.ts` 收集 `hook_result`；
    路由 / Rail / 侧边栏 / 快捷键 / i18n 注册。
- 验证：`hooks-route.test.ts` 7 条、`hook-result-events.test.ts` 3 条、`user-hooks-bridge.test.ts` 3 条、
  桌面 `event-reducer` + `client` 单测绿；`tsc --noEmit` 绿。

### I5 — Browser 验证面（`/browser`）✅ 已在 N4 交付
Playwright headless 工具 + 截图/录屏 Artifact + **强制 approval 白名单**（新攻击面，必须在 M2/M3
审批与 artifact 成熟后再引入）。
- 验收：agent 请求打开 URL 必走审批；截图落为 `screenshot` 类 artifact 并在面板可看。

### I6 — Live voice transcription
输入框实时语音转写。
- 验收：按住说话，文字实时进 composer，可编辑后发送。

### I7 — 双层飞轮 / Evolution Manager（self-only）+ 跨平台打包
先天 vs 适应性器官分层分发；macOS/Windows/Linux Tauri bundle（`tauri build` + sidecar 打包策略：
pkg 单文件 vs ship `dist/` + 探测 node）。
- 验收：三平台各出一个可双击运行的安装包，首启自动拉起 sidecar 无需手装 node（或带探测+引导）。

## 关键缺口对照（实证）

| 编号 | 缺口 | 本轮状态 |
|------|------|----------|
| B0 | `rivet serve` 未进发行入口 | ✅ 已移入 `src/main.ts` + `src/server/serve.ts` |
| B1 | 单活跃会话 → 多会话 API | ✅ `RuntimeSessionManager` + `/sessions` |
| B2 | approval 被硬拒 → 可恢复双向协议 | ✅ requestId 化 + `/interventions/:rid/answer` |
| B3 | 事件补全 + 可重连 | ✅ phase/checkpoint/thinking + seq + `?since=` + `/stream` |
| B4 | Artifacts 升为 session API | ✅ 复用 `ArtifactStore` + taxonomy + `/sessions/:id/artifacts` |
