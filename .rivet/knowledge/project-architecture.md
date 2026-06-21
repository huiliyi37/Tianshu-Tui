# 天枢 (Tiānshū) 项目架构

> 最后更新: 2026-06-22 · 编译自当前源码

## 项目身份

| 维度 | 值 |
|------|---|
| 根包名 | `rivet` v2.9.0 |
| 描述 | Terminal coding agent optimized for DeepSeek V4 prefix cache |
| CLI 入口 | `rivet` → `dist/main.js` (tsup 构建) |
| 运行时 | Node.js ≥22, TypeScript strict |
| 桌面版 | `tianshu-desktop` v0.0.1 (Tauri 2 + React 18) |

## 双端架构（关键：之前搞错的地方）

```
┌─────────────────────────────────────────────────────┐
│                    src/agent/                         │
│              核心智能体循环（共享）                      │
│         agent/  tools/  api/  prompt/                 │
│         compact/  cache/  repo/  config/              │
└────────────┬────────────────────┬────────────────────┘
             │                    │
    ┌────────▼────────┐  ┌───────▼──────────────────────┐
    │   src/tui/       │  │   desktop/                   │
    │   终端 TUI        │  │   Tauri 桌面应用               │
    ┌────────▼────────┐  ┌───────▼──────────────────────┐
    │   src/tui/       │  │   desktop/                   │
    │   终端 TUI        │  │   Tauri 桌面应用               │
    │   自研 ANSI 引擎   │  │   React 18 + Vite + Rust     │
    │   (terminal)     │  │   (独立窗口)                   │
    └─────────────────┘  └──────────────────────────────┘
```

- **`src/tui/`** — 终端内运行的自研 ANSI 渲染引擎。已从 Ink 6 React 迁移到自定义引擎（T9 重构），`src/tui/engine/` 含 19 个模块（CommitEngine / LiveEngine / OverlayEngine / InputHandler / StreamRenderer 等）。仅 `command-palette.tsx` 仍残留 Ink 导入。
- **`desktop/`** — 独立 Tauri 2 桌面应用。React 18 + Vite 前端，通过 localhost sidecar 连接 rivet 后端进程。有自己的 `package.json`、`tsconfig.json`、`vite.config.ts`，不与根项目共享构建配置。
- **`src/agent/` 及同级目录** — 两个前端共享的智能体核心（agent loop、工具系统、API 客户端、提示词工程、上下文压缩、缓存管理等）。

### 根项目 `src/`

| 目录 | 职责 |
|------|------|
| `src/agent/` | 核心智能体循环、工具流水线、多模型协调、压缩、子智能体、验证、交付门禁 |
| `src/tools/` | 工具实现（definition + execute）与注册 |
| `src/api/` | API 客户端层（OpenAI 兼容、Codex OAuth、流式处理） |
| `src/prompt/` | 系统提示词工程（static / volatile / engine） |
| `src/tui/` | **终端 UI**（Ink 6 / React）— 注意：这里不是桌面版 |
| `src/compact/` | 上下文压缩策略（修剪、微压缩、阈值） |
| `src/tui/engine/` | **自研 ANSI 渲染引擎**（19 个模块）：app.ts（主循环）、commit-engine、live-engine、overlay-engine、input-handler、stream-renderer 等 |
| `src/tui/format/` | ANSI 格式化函数：tool-card、glance-bar、markdown、thinking、diff、task-list 等 |
| `src/tui/command-palette.tsx` | 命令面板（**唯一残留 Ink 导入的组件**，其余已全量迁移到 ANSI 引擎） |

| 路径 | 职责 |
|------|------|
| `desktop/src/components/` | React UI 组件（Composer, ToolGroup, McpSettings, PlusMenu, Rail 等） |
| `desktop/src/runtime/` | SSE 客户端、REST API 客户端、类型定义 |
| `desktop/src/state/` | 事件 reducer、React Query hooks、全局通知 |
| `desktop/src/lib/` | 工具函数（命令、主题、持久化、图片压缩等） |
| `desktop/src/hooks/` | React hooks |
| `desktop/src-tauri/` | Rust 后端（Cargo.toml） |
| `desktop/src-tauri/Cargo.toml` | Tauri Rust 依赖 |

桌面端描述: "Antigravity 2.0 范式 agent-first 桌面外壳（Tauri + React），通过 localhost sidecar 接 rivet runtime。"

### 其他顶层目录

| 路径 | 职责 |
|------|------|
| `docs/` | 设计文档、研究、变更日志 |
| `scripts/` | 构建/测试/打包脚本 |
| `.rivet/` | 运行时数据（sessions、knowledge、plans、artifacts） |

## 构建与测试

```bash
# 根项目
npx tsc --noEmit                    # typecheck (仅 src/)
npm run build                       # tsup bundle → dist/
npm run test                        # 全量测试 (tsx)
npm run test:unit                   # 单元测试
npm run test:integration            # 集成测试
npm run test:fast                   # 不含 TUI 的快速测试

# 桌面端
cd desktop && npm run typecheck     # typecheck (独立 tsconfig)
cd desktop && npm test              # 桌面端测试
cd desktop && npm run tauri:dev     # Tauri 开发模式
```

## 提交约定

- `feat(tui):` — 终端 TUI 改动
- `feat(desktop):` — 桌面端改动
- `fix(mcp):` — MCP 协议相关
- `fix(desktop):` — 桌面端修复
- 其他: `refactor/` `docs/` `test/` `chore/` `perf/`
