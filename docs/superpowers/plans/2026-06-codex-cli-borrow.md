# OpenAI Codex CLI 值得借鉴的特性

> 来源：https://github.com/openai/codex (v0.136, 2026-06)
> 88k stars, Rust (codex-rs) + Ratatui, Apache 2.0
> 分析者：天枢·天府域 · 2026-06-03

## 一、架构概览

Codex CLI 是一个 Rust monorepo（`codex-rs/`），核心架构与天枢/Gemini CLI 有本质不同：

| 维度 | Codex CLI | 天枢 |
|------|-----------|------|
| 语言 | Rust | TypeScript |
| TUI 框架 | Ratatui（非 React，纯 Rust 渲染） | Ink 6 (React) |
| 核心架构 | `ThreadManager` → `CodexThread` → `TurnContext` | `AgentLoop` → `tool-pipeline` |
| 沙箱 | 原生 OS 沙箱（macOS Seatbelt / Linux Landlock / Windows Token） | 无 |
| 模型层 | Responses API + Realtime API (WebSocket) | OpenAI 兼容 streaming |
| 工具系统 | `function_tool` + `shell-command` + `apply-patch` | 20+ 工具，definition + execute |
| 会话持久化 | Rollout 文件（JSONL）+ ThreadStore | SessionPersist |
| 进程架构 | App Server（独立守护进程）+ CLI 客户端 | 单进程 |

### 关键 crate 索引

| crate | 职责 |
|-------|------|
| `core/` | 业务逻辑：ThreadManager, CodexThread, TurnContext, 沙箱, MCP, 工具 |
| `tui/` | Ratatui 全屏 TUI，App struct + 事件驱动 |
| `exec/` | 无头 CLI（`codex exec`） |
| `cli/` | 子命令入口 |
| `sandboxing/` | OS 沙箱实现（Seatbelt, Landlock, Windows） |
| `protocol/` | Client-Server 协议定义 |
| `app-server-*` | App Server 守护进程 + 客户端 + 传输层 |
| `exec-server/` | 沙箱内命令执行服务 |
| `memories/` | 持久化记忆系统 |
| `rollout/` | 会话 rollout 记录 |
| `tools/` | 工具定义 |
| `prompts/` | 系统提示词 |
| `config/` | TOML 配置 |
| `mcp-*` | MCP 客户端 + 服务端 |
| `skills/` | 技能系统 |
| `codex-api/` | OpenAI API 客户端 |
| `state/` | 状态数据库 |

## 二、值得借鉴的特性

### 1. OS 级沙箱（最重要的差异）

**文件**: `codex-rs/sandboxing/`, `core/src/sandboxing/mod.rs`

Codex CLI 提供三档沙箱策略：
- **read-only**: 默认，macOS Seatbelt / Linux Landlock 限制只读
- **workspace-write**: 允许写工作目录，仍禁止网络
- **danger-full-access**: 无限制（需明确指定）

关键实现：
- macOS: `Seatbelt` (sandbox-exec)
- Linux: `Landlock` (内核级文件系统沙箱)
- Windows: 受限令牌 (restricted token)

`ExecRequest` 结构体携带完整的沙箱配置：
```rust
pub struct ExecRequest {
    pub sandbox: SandboxType,
    pub file_system_sandbox_policy: FileSystemSandboxPolicy,
    pub network_sandbox_policy: NetworkSandboxPolicy,
    pub permission_profile: PermissionProfile,
    // ...
}
```

**对我们的价值**: 天枢目前没有任何沙箱保护。`bash` 工具可以执行任意命令，`edit_file` 可以写任意文件。这是安全风险。

**实施建议**:
- Phase 1: 在 bash 工具执行前，检测危险命令（rm -rf /, curl | sh）并警告
- Phase 2: 使用 Node.js 的 `child_process` + `chroot`/`cgroups` 实现基本隔离
- Phase 3: 评估 Deno 的权限模型作为替代

### 2. App Server 架构（进程分离）

**文件**: `app-server/`, `app-server-client/`, `app-server-protocol/`, `app-server-transport/`

Codex CLI 将 agent 运行时和 TUI 分离为两个进程：
- **App Server**: 守护进程，管理会话、执行工具、维护状态
- **TUI Client**: 纯展示层，通过 Unix Domain Socket / stdin-stdout 与 Server 通信

好处：
- TUI 崩溃不影响 agent 运行
- 可以有多个客户端（TUI + IDE + CLI）
- 可以远程连接

**对我们的价值**: 天枢的 AgentLoop 和 TUI 在同一进程，TUI 崩溃可能导致工具执行中断。

**实施建议**: 远期目标。当前架构下，可以通过更健壮的错误边界（已有的 ErrorBoundary）和工具超时保护来缓解。

### 3. Rollout 会话记录

**文件**: `core/src/rollout/`, `core/src/session.rs`

Codex CLI 的会话记录（rollout）是结构化的：
- 每个会话有唯一 ID 和元数据
- 支持分页浏览历史会话（`ThreadsPage`, `Cursor`）
- 支持 archive 和恢复
- `read_head_for_summary`: 读取会话头部用于生成摘要

**对我们的价值**: 天枢的 `SessionPersist` 只存 OAI 消息数组。缺少元数据（开始时间、模型、token 用量等），缺少分页和浏览。

**实施建议**:
- 在 SessionPersist 中添加元数据 header（JSON 行）
- 支持 `--list-sessions` 列出历史会话
- 支持从任意历史会话恢复

### 4. PermissionProfile 权限配置

**文件**: `codex-rs/core/src/exec_policy.rs`, `protocol/src/models/`

Codex CLI 有细粒度的权限配置：
- `PermissionProfile`: 定义哪些操作需要审批
- `ExecPolicy`: 定义哪些命令可以自动执行
- 三种审批模式：`suggest`（默认需审批）、`auto-edit`（文件操作自动）、`full-auto`（全部自动）

**对我们的价值**: 天枢的 `approval-risk.ts` 做了类似的事，但 Codex 的 `ExecPolicy` 更结构化——可以配置白名单命令（如 `git status` 自动通过）。

**实施建议**: 增强 `approval-risk.ts`，支持配置化的命令白名单/黑名单。

### 5. 记忆系统 (Memories)

**文件**: `codex-rs/memories/`, `core/src/compact.rs`

Codex CLI 有独立的记忆系统：
- 自动从对话中提取重要信息
- 持久化到 `~/.codex/memories/`
- 在新会话中自动注入

**对我们的价值**: 天枢的 `project-memory.md` + `context-claim-store` 做了类似的事，但缺少自动提取。我们的记忆需要手动 `remember` 或从工具结果中提取。

### 6. Skills 系统

**文件**: `codex-rs/core/src/skills/`, `core-skills/`, `collaboration-mode-templates/`

Codex CLI 有"技能"概念：
- 预定义的提示词模板 + 工具组合
- 用户可以通过 `@skill_name` 调用
- 技能有元数据（描述、参数、预算）

**对我们的价值**: 类似于我们 `delegate_task` 的 profile 概念，但更轻量。可以将常用的操作模式（如"探索代码库"、"修复测试"、"重构"）封装为技能。

### 7. 网络代理 (Network Proxy)

**文件**: `codex-rs/network-proxy/`

Codex CLI 内置网络代理，用于：
- 沙箱内限制网络访问
- 记录网络请求
- 审计

**对我们的价值**: 天枢的 `web_fetch` 工具可以访问任意 URL。在网络受限环境中，需要代理支持。

### 8. 实时音频 (Realtime API)

**文件**: `codex-rs/realtime-webrtc/`, `core/src/realtime_*.rs`

Codex CLI 支持通过 WebRTC 与模型进行实时音频对话。

**对我们的价值**: 语音模式是差异化特性。天枢可以评估集成 Whisper + TTS 作为 Phase 3。

### 9. `codex exec` 无头模式

**文件**: `codex-rs/exec/`

```bash
codex exec "Fix the failing tests in src/agent/"
echo "output" | codex exec "Summarize this"
```

**对我们的价值**: 天枢的 `--prompt` 参数支持类似功能，但 `codex exec` 更完善：
- 支持 `--ephemeral`（不持久化会话）
- 支持 stdin 管道
- 输出格式化（纯文本，非 TUI）

### 10. Hooks 系统

**文件**: `codex-rs/hooks/`

Codex CLI 支持 hook：
- `session_start` / `session_end`
- `pre_tool_call` / `post_tool_call`
- 用户可以配置自定义 shell 命令作为 hook

**对我们的价值**: 天枢的 `hooks.firePostToolUse` 是内置的，但不支持用户自定义。添加用户可配置的 hook 系统可以支持 CI/CD 集成。

## 三、不建议借鉴的部分

| 特性 | 原因 |
|------|------|
| Rust 重写 | 工程量巨大，TypeScript 生态对 AI agent 更友好（OpenAI SDK） |
| Ratatui 替换 Ink | Ink 的 React 模型更适合复杂 UI 状态管理 |
| App Server 进程分离 | 增加复杂度，当前单进程架构足够 |
| 60+ crate monorepo | 过度拆分，增加构建和维护复杂度 |

## 四、实施优先级建议

| 优先级 | 特性 | 估算工作量 | ROI |
|--------|------|-----------|-----|
| P0 | PermissionProfile 命令白名单 | 1-2d | 高（安全+体验） |
| P1 | Rollout 会话元数据 | 2-3d | 高（会话管理基础） |
| P1 | 基本沙箱（危险命令检测） | 2-3d | 高（安全） |
| P2 | Skills 系统 | 3-5d | 中（提升效率） |
| P2 | `codex exec` 等价物 | 1-2d | 中（CI/CD 集成） |
| P3 | 用户自定义 Hooks | 3-5d | 低（可扩展性） |
| P3 | 网络代理 | 5-7d | 低（特殊场景） |

## 五、与 Gemini CLI 对比

| 维度 | Gemini CLI | Codex CLI | 天枢 |
|------|-----------|-----------|------|
| 语言 | TypeScript | Rust | TypeScript |
| 沙箱 | 无 | OS 级 | 无 |
| TUI | Ink (React) | Ratatui | Ink (React) |
| 会话管理 | Session Browser | Rollout + ThreadStore | SessionPersist |
| 权限 | ApprovalMode (YOLO等) | ExecPolicy + PermissionProfile | approval-risk.ts |
| 按键系统 | Kitty + 优先级 | 原始事件 | Ink useInput |
| 子进程 | 无 | App Server 分离 | 单进程 |

**核心差异**: Codex 的最大优势是**安全**（OS 沙箱 + 权限配置），Gemini 的最大优势是**UX**（按键系统 + Alternate Buffer + Session Browser）。天枢应该从两者各取所长。
