# 天枢桌面版 — Antigravity 2.0 范式基座

Agent-first 桌面外壳：**Tauri 2.x + React/Vite** 前端，复用现有 `rivet` Node runtime 作为
**localhost sidecar**。打开就是「和 agent 对话 + 看它产出的 artifacts + 在 artifacts 上给反馈」，
多会话可同步/异步管理。

> 本目录与 `src/`（runtime 内核）严格隔离：桌面依赖（Rust/Tauri/Vite）只在此处，后端只在
> `src/server/` 加 API 面，不动 `AgentLoop` / prompt cache 不变量。

## 架构

```
Tauri 外壳 (Rust)               rivet serve (Node sidecar)
  spawn + 注入随机 token   ──▶   127.0.0.1:<port> + Bearer token (fail-closed)
  健康检查 + runtime_info        ├─ POST /prompt            (M0 单条对话 SSE)
        │                        ├─ RuntimeSessionManager   (M0.5 多会话)
        ▼                        │   ├─ /sessions CRUD
React 前端 (Vite)                │   ├─ /sessions/:id/events?since=  (可重连补读)
  Agent Manager / Conversation   │   ├─ /sessions/:id/interventions/:rid/answer (M2 审批)
  Artifacts / Approval modal     │   └─ /sessions/:id/artifacts            (M3 信任层)
  fetch + Bearer + ?since= 轮询  └─ 每会话独立 AgentLoop + PromptEngine + ArtifactStore
```

EventSource 不能带 Authorization header，故前端用 `fetch + ?since=` 轮询补读（断线不丢、
viewer 断开 ≠ abort 会话）。token 由 Rust 每次启动随机生成，绝不落盘。

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
```

打包：`npm run tauri:build`（先 `tauri icon <png>` 生成 `src-tauri/icons/`）。

## 里程碑

| 阶段 | 内容 | 状态 |
|------|------|------|
| M0   | sidecar 骨架 + 单条对话 SSE | 后端就绪 / 前端就绪 |
| M0.5 | RuntimeSessionManager + /sessions 可重连 | 后端就绪 |
| M1   | Agent Manager 多会话 dashboard + Project 抽象 | 前端就绪 |
| M2   | 审批介入双向协议 + 事件总线 | 后端+前端就绪 |
| M3   | Artifacts 信任层 + review flow | 后端+前端就绪 |

后续迭代路线（星域议事会 / Scheduled Tasks / subagents UI / hooks / Browser / 语音 / 打包）
见 [`ROADMAP.md`](./ROADMAP.md)。

## 验证边界（诚实声明）

本环境无 Rust/Tauri 工具链与显示设备，故 **Rust 外壳与 React 打包未在此处实跑**；它们是按
Tauri 2.x / Vite 标准写的可构建脚手架，需在装好前置的机器上 `npm install` 后验证。后端
（`src/server/`）的 session-manager / 路由 / 审批 / artifacts 全部有 `node:test` 覆盖并通过。
