# 天枢桌面版 — Antigravity 2.0 范式基座

Agent-first 桌面外壳：**Tauri 2.x + React/Vite** 前端，复用现有 `rivet` Node runtime 作为
**localhost sidecar**。打开就是「和 agent 对话 + 看它产出的 artifacts + 在 artifacts 上给反馈」，
多会话可同步/异步管理。

> 本目录与 `src/`（runtime 内核）严格隔离：桌面依赖（Rust/Tauri/Vite）只在此处，后端只在
> `src/server/` 加 API 面，不动 `AgentLoop` / prompt cache 不变量。

## 下载与安装（macOS）

从 GitHub Release 下载 `天枢_*_aarch64.dmg`，拖入「应用程序」。

> ⚠️ **首次打开若提示「天枢已损坏，移到废纸篓」**——包没坏。本应用是开源未做 Apple 付费公证，
> Apple Silicon 的 Gatekeeper 会拦截「未公证 + 下载隔离」的 app。在终端执行一次即可正常打开：
>
> ```bash
> xattr -cr /Applications/天枢.app
> ```
>
> （对「已损坏」提示，右键→打开通常无效，必须用 `xattr` 清掉隔离属性。之后双击照常使用。）

## 架构

```
Tauri 外壳 (Rust)               rivet serve (Node sidecar)
  setup 内 spawn + 随机 token ─▶  127.0.0.1:<port> + Bearer token (fail-closed)
  resource_dir/rivet-runtime     ├─ GET  /health                (N1 uptime/会话数)
  detect_node() + runtime_info   ├─ POST /prompt                (M0 单条对话 SSE)
        │                        ├─ RuntimeSessionManager + FileSessionPersistence (N1 重启可回放)
        ▼                        │   ├─ /sessions CRUD
React 前端 (Vite)                │   ├─ GET  /sessions/:id/stream  (N0 fetch ReadableStream + ?since=)
  TanStack Query + UI store      │   ├─ POST /sessions/:id/interventions/:rid/answer (M2/N2 审批+editedInput)
  event-reducer / surfaces       │   ├─ POST /sessions/:id/feedback         (N2 artifact 回灌)
  Workspace/Inbox/Schedule       │   ├─ GET  /sessions/:id/artifacts        (M3 信任层)
  Approval/Intent modal + 通知   │   └─ /schedule CRUD                      (N3 cron→可见会话)
                                 └─ 每会话独立 AgentLoop + PromptEngine + ArtifactStore
```

EventSource 不能带 Authorization header，故前端用 `fetch` ReadableStream 消费 `/stream`、`?since=`
回灌补读（断线不丢、viewer 断开 ≠ abort 会话），轮询降级保留。token 由 Rust 每次启动随机生成，绝不落盘。

## 开发

前置：仓库根已 `npm install && npm run build`（产出 `dist/main.js`，即 sidecar 入口），
本机装好 Rust + Tauri 2 CLI 前置（见 https://tauri.app/start/prerequisites/）。

```bash
cd desktop
npm install

# A. 纯前端联调（先手动起 sidecar）
RIVET_SERVER_TOKEN=devtoken node ../dist/main.js serve --port 3100
VITE_RIVET_PORT=3100 VITE_RIVET_TOKEN=devtoken npm run dev   # 浏览器开 5273

# B. 完整桌面（Tauri 自动 spawn sidecar + 注入随机 token）
npm run tauri:dev

# B'. 完整桌面，以 Pro 层级运行（开发便利，无需真实许可证）
npm run tauri:dev:bypass
```

> 双层模式说明：桌面端不再有启动激活闸门——Basic 免许可证即用（完整基础功能），
> Pro 许可证经 Rust Ed25519 验签后解锁高级功能（computer_use / team max / 多轮议事会）。
> `tauri:dev` 默认以 Basic 运行；`npm run tauri:dev:bypass` 等价于
> `RIVET_ACTIVATION_DEV_BYPASS=1 npm run tauri:dev`（仅 debug 构建生效），直接视为 Pro。

打包（N5）：`npm run tauri:build`。`bundle.resources` 会把仓库根 `dist/`（即 sidecar 运行时）装为
`Resources/rivet-runtime/`；运行时 `lib.rs` 的 `sidecar_entry()` 优先解析该资源路径，`detect_node()`
探测系统 node（兼容 Finder 启动的最小 PATH）。当前 `bundle.targets` 限定 `["app"]`（产出可直接运行的
`天枢.app`）；DMG/安装器与三平台矩阵留待 release CI（见 ROADMAP I7）。图标已在 `src-tauri/icons/`，
如需重生成用 `tauri icon <png>`。

环境变量旁路（调试/打包）：`RIVET_SIDECAR_ENTRY`（覆盖入口）、`RIVET_SIDECAR_CMD`（覆盖 node）、
`RIVET_BROWSER_ENABLED=1`（启用 N4 浏览器工具）、`RIVET_BROWSER_ALLOWLIST`（域白名单，fail-closed）。

## 里程碑

| 阶段 | 内容 | 状态 |
|------|------|------|
| M0   | sidecar 骨架 + 单条对话 SSE | 后端+前端就绪 |
| M0.5 | RuntimeSessionManager + /sessions 可重连 | 后端就绪 |
| M1   | Agent Manager 多会话 dashboard + Project 抽象 | 前端就绪 |
| M2   | 审批介入双向协议 + 事件总线 | 后端+前端就绪 |
| M3   | Artifacts 信任层 + review flow | 后端+前端就绪 |
| N0   | 前端架构重构（TanStack Query + UI store + event-reducer + /stream SSE + surfaces） | 前端就绪 |
| N1   | 后端持久化与韧性（FileSessionPersistence + rehydrate + /health + 重连 banner） | 后端+前端就绪 |
| N2   | 信任层闭环（feedback 回灌 + diff/editedInput 审批 + Intent modal + 桌面通知） | 后端+前端就绪 |
| N3   | 异步与编排（RuntimePool→manager + CronWiring + /schedule + 委派树 + Inbox） | 后端+前端就绪 |
| N4   | 浏览器验证面（Playwright 工具 + screenshot artifact + fail-closed 白名单 + 强制审批） | 后端+前端就绪 |
| N5   | 分发门（resources 装 dist + node 探测 + tauri:dev/build 实跑） | 已实跑 |

后续迭代路线（星域议事会 I1 / hooks 面板 I4 / 语音 I6 / 双层飞轮 + 三平台打包 I7）见
[`ROADMAP.md`](./ROADMAP.md)。

## 验证边界（诚实声明）

后端（`src/server/`、`src/tools/browser.ts`）的 session-manager / 持久化 / 路由 / 审批 / artifacts /
schedule / browser 全部有 `node:test` 覆盖并通过，`tsc --noEmit` 与发行 `tsup` 构建均绿；前端
`tsc + vite build` 绿。**N5 起 Rust 外壳已在本机实跑**：`tauri:build` 产出 `天枢.app`（内含
`Resources/rivet-runtime/main.js`）；`tauri:dev` 起窗后子进程 sidecar 经资源路径拉起、监听
`127.0.0.1`、无 token 401 fail-closed。DMG 封装与跨平台矩阵尚未实跑。
