# Claude Code 功能差异补强分析

> 日期：2026-05-26
> 来源：直接分析 claude-code-haha 源码 (bun + @anthropic-ai/sdk)
> 目的：标注 Claude Code 中天枢缺失或可借鉴的功能，为补强提供具体参考
> 基线版本：claude-code-local@999.0.0-local (泄露源码修复版)

---

## 一、工具系统差异

### 1.1 BashTool 安全体系（天枢缺失 ❌）

Claude Code 的 BashTool 有 **8 个安全子模块**，天枢只有基础的 `bash.ts` + `sandbox-exec.ts`。

| 子模块 | 功能 | 天枢现状 |
|--------|------|----------|
| `bashSecurity.ts` | 命令注入检测：heredoc 注入、进程替换 `>()`、Zsh 危险命令 (zmodload/emulate/sysopen)、PowerShell 注释语法 | ❌ 无 |
| `bashPermissions.ts` | 命令语义分析 + AST 解析 + 分类器 (allow/ask/deny) + wildcard 规则匹配 | ⚠️ 只有 risk assessment |
| `shouldUseSandbox.ts` | 沙箱决策：排除命令列表 (用户可配) + 二进制劫持变量检测 + compound 命令拆分 | ⚠️ 有 sandbox-exec 但无决策层 |
| `destructiveCommandWarning.ts` | 破坏性命令警告：git reset --hard, rm -rf, DROP TABLE, docker rm 等 20+ 模式 | ❌ 无 |
| `commandSemantics.ts` | 命令语义解析：子命令提取、重定向检测、管道分析 | ❌ 无 |
| `readOnlyValidation.ts` | 只读命令验证：区分读写操作 | ❌ 无 |
| `sedValidation.ts` | sed 编辑验证：防止 sed 绕过安全检查 | ❌ 无 |
| `pathValidation.ts` | 路径验证：防止路径穿越 | ⚠️ 有 path-validate.ts |

**补强建议**：
- P1: 将 `destructiveCommandWarning.ts` 的模式匹配逻辑移植到天枢的 `bash.ts`，在 tool result 中注入警告
- P2: 将 `bashSecurity.ts` 的命令注入检测移植，作为 `assessToolRisk()` 的补充
- P3: 考虑引入 AST 级别的命令语义分析（`commandSemantics.ts`）

### 1.2 Plan Mode（天枢缺失 ❌）

Claude Code 有完整的 Plan Mode 工具链：

| 工具 | 功能 | 天枢现状 |
|------|------|----------|
| `EnterPlanModeTool` | 进入计划模式：只读，不允许写操作 | ❌ 无 |
| `ExitPlanModeTool` (V2) | 退出计划模式：生成计划文件、写入磁盘、审批流程 | ❌ 无 |
| Plan 文件持久化 | `.claude/plans/*.md` 持久化 | ❌ 无 |

**补强建议**：
- P1: 实现 Plan Mode 概念——agent 在复杂任务前先探索、设计方案，用户审批后再执行
- 天枢已有 `todo.ts` 但缺少 "只读探索 → 方案设计 → 审批 → 执行" 的工作流

### 1.3 Agent Tool（天枢有 delegate_task 但架构不同）

| 维度 | Claude Code | 天枢 |
|------|------------|------|
| 子 agent 类型 | AgentTool (fork subagent, 远程 agent, 进程内 teammate) | delegate_task / delegate_batch |
| 隔离模型 | worktree 隔离 + 远程隔离 (teleport) | worktree 隔离 (hands-session) |
| 通信模式 | SendMessageTool (进程内 mailbox, 远程 bridge) | 无直接通信，只返回结果 |
| 进度追踪 | AgentProgress + 后台总结 (30s 周期) | coordinator-state |
| Agent 定义 | Markdown frontmatter + JSON schema | 硬编码 profile (code_scout 等) |
| 验证 Agent | 内置 verification agent (PASS/FAIL/PARTIAL) | 无 |

**补强建议**：
- P1: 实现 Agent 定义的外部化（`.rivet/agents/*.md`），允许用户自定义 agent
- P2: 实现进程内 teammate 通信（mailbox 模式）
- P2: 实现内置 verification agent

### 1.4 Task 系统（天枢缺失 ❌）

Claude Code 有完整的任务管理工具链：

| 工具 | 功能 |
|------|------|
| `TaskCreateTool` | 创建任务：subject, description, activeForm, metadata |
| `TaskGetTool` | 获取任务详情 |
| `TaskListTool` | 列出所有任务 |
| `TaskOutputTool` | 获取任务输出 |
| `TaskStopTool` | 停止任务 |
| `TaskUpdateTool` | 更新任务状态 |
| `TodoWriteTool` | Todo 清单管理（带 verification nudge） |

天枢有 `todo.ts` + `todo-store.ts`，但缺少完整的任务生命周期管理。

**补强建议**：
- P2: 扩展 todo 系统为完整的 Task 系统，支持后台任务追踪
- P2: 实现 verification nudge（完成 3+ 任务时提醒验证）

### 1.5 Workflow Tool（天枢缺失 ❌）

Claude Code 有 `WorkflowTool` 支持定义和执行多步骤工作流。天枢无此功能。

**补强建议**：
- P3: 考虑是否需要——天枢的 goal-loop + todo 系统可能已覆盖部分场景

### 1.6 REPLTool（天枢缺失 ❌）

Claude Code 有 `REPLTool` 支持交互式 REPL 环境。天枢无此功能。

**补强建议**：
- P3: 低优先级，bash tool 已覆盖大部分场景

---

## 二、内存/上下文管理差异

### 2.1 Memory 系统（天枢缺失 ❌）

Claude Code 有完整的记忆管理系统：

**目录结构**：`src/memdir/`
- `memdir.ts` — MEMORY.md 入口点，200 行 / 25KB 截断
- `memoryTypes.ts` — 4 种记忆类型：`user`, `feedback`, `project`, `reference`
- `memoryScan.ts` — 记忆文件扫描
- `findRelevantMemories.ts` — 使用 Sonnet 侧查询选择相关记忆（最多 5 个）
- `paths.ts` — 自动记忆路径管理（user/project/local 三级 scope）

**记忆类型定义**（每个类型有完整的 when_to_save / how_to_use / body_structure）：
- **user**: 用户角色、目标、偏好（始终 private）
- **feedback**: 用户对工作方式的纠正和确认（默认 private）
- **project**: 项目进展、目标、计划（偏向 team）
- **reference**: 外部系统指针（通常 team）

**自动记忆提取**：`src/services/extractMemories/` — 后台 agent 自动从对话中提取记忆

天枢有 `recall.ts` + claim store，但缺少结构化记忆系统。

**补强建议**：
- P0: 实现 `.rivet/MEMORY.md` 入口点 + 分类记忆文件
- P1: 实现 `findRelevantMemories` 的轻量版（基于关键词匹配而非 LLM 选择）
- P1: 实现自动记忆提取（后台 agent 从对话中提取关键信息）

### 2.2 Session Memory（天枢缺失 ❌）

Claude Code 有 `src/services/SessionMemory/` — 会话级记忆：
- 自动在会话结束时提取关键信息
- 跨会话持久化
- 与 compact 系统集成

天枢有 Dream 记忆蒸馏，但不是每个会话都运行。

**补强建议**：
- P1: 在 session 结束时自动提取关键 claims 为长期记忆

### 2.3 Context Assembly（架构差异）

Claude Code 的上下文组装：
- `src/context.ts` — `getSystemContext()` + `getUserContext()`
- 自动注入：git status, CLAUDE.md, memory files, 当前日期
- `getUserContext()` 缓存 + 手动清除

天枢的上下文组装：
- `src/prompt/engine.ts` — PromptEngine
- `src/prompt/volatile.ts` — volatile context
- `src/agent/context-injection.ts` — context injection

**关键差异**：Claude Code 将 git status、CLAUDE.md 等作为 system context 注入；天枢将这些作为 volatile context 注入。两者架构不同但功能等价。

### 2.4 Compaction 系统（架构相似，细节差异）

| 维度 | Claude Code | 天枢 |
|------|------------|------|
| 自动压缩 | autoCompact（80% 阈值 + 13K buffer） | smartCompact（5 级压力分级） |
| 微压缩 | microCompact（tool result 预算裁剪） | staleRound（时间衰减裁剪） |
| 全量压缩 | LLM 摘要（带 analysis scratchpad） | LLM 摘要 |
| 压缩后清理 | postCompactCleanup（文件附件恢复） | snapshot 恢复 |
| 会话记忆压缩 | sessionMemoryCompact | 无 |
| 压缩边界 | compact boundary 消息 | compact boundary 消息 |
| 熔断器 | 连续 3 次失败停止 | 压力监控 + 恢复触发 |

**补强建议**：
- P2: 实现 sessionMemoryCompact（压缩时保留会话记忆）

---

## 三、权限/安全差异

### 3.1 权限模式（天枢较弱）

| Claude Code | 天枢 |
|------------|------|
| 7 种模式 (default/acceptEdits/bypassPermissions/dontAsk/plan/auto/bubble) | 3 种模式 (auto-accept/auto-safe/manual) |
| 5 级规则优先级 (policy → user → project → local → session) | 单级规则 |
| 投机式分类器（等待用户时异步运行） | 无 |
| 权限冒泡（子 agent → 父 agent） | 无 |
| 工具级权限规则 (Bash:git:*, FileEdit:path) | 工具级 allowlist |

**补强建议**：
- P1: 实现权限冒泡（delegate_task 中的工具调用可冒泡到主 agent 审批）
- P2: 实现分级规则（user/project 级别的权限配置）

### 3.2 Sandbox（天枢已实现但较简单）

| Claude Code | 天枢 |
|------------|------|
| `SandboxManager` 抽象层 | `sandbox-exec.ts` 直接实现 |
| 排除命令列表（用户可配） | 无 |
| 二进制劫持变量检测 | 无 |
| 沙箱 UI 工具 | 无 |

**补强建议**：
- P2: 实现沙箱排除命令列表（用户可配）
- P3: 实现沙箱状态 UI

---

## 四、Hooks/插件差异

### 4.1 Hook 系统（天枢无用户可配 hook）

Claude Code 的 hooks：
- `src/hooks/` — 50+ React hooks (UI 层)
- 用户可配 hook：settings.json 中的 `hooks` 字段
- 19 种生命周期事件

天枢的 hooks：
- `src/agent/create-runtime-hooks.ts` — 9+ runtime hooks
- 5 phases (signal-consumer, perception, vigor, theta, kick)
- **无用户可配 hook API**

**补强建议**：
- P2: 暴露 PreToolUse/PostToolUse 用户 hook API
- P3: 实现 hook 配置文件（`.rivet/hooks.json`）

### 4.2 Plugin 系统（天枢缺失 ❌）

Claude Code 有 `src/plugins/` + `src/services/plugins/`：
- 内置插件 (`bundled/index.ts`)
- 插件管理服务
- 插件市场

天枢无插件系统。

**补强建议**：
- P3: 低优先级——天枢的 tool registry 已支持动态注册

### 4.3 Skill 系统（天枢缺失 ❌）

Claude Code 有 `src/skills/`：
- 内置 skills: `verify`, `remember`, `loop`, `claudeApi`, `debug`, `stuck`, `scheduleRemoteAgents`
- 每个 skill 是一个 Markdown 文件 + frontmatter
- 用户可通过 `/skillname` 调用

天枢无 skill 系统。

**补强建议**：
- P1: 实现 `.rivet/skills/*.md` 用户自定义 skill 系统
- 内置 skill: `verify`（代码验证）、`remember`（记忆整理）

---

## 五、多 Agent/协作差异

### 5.1 Coordinator Mode（天枢缺失 ❌）

Claude Code 有 `src/coordinator/coordinatorMode.ts`：
- 环境变量切换 (`CLAUDE_CODE_COORDINATOR_MODE`)
- Worker 工具池限制
- Scratchpad 功能

天枢有 `DelegationCoordinator`，但无 coordinator mode 概念。

**补强建议**：
- P2: 考虑是否需要——天枢的 delegate 工具已覆盖大部分场景

### 5.2 Team 系统（天枢缺失 ❌）

Claude Code 有完整的多 agent 团队系统：
- `TeamCreateTool` / `TeamDeleteTool` — 创建/删除团队
- `SendMessageTool` — agent 间消息传递（进程内 mailbox + 远程 bridge）
- Team memory 同步 (`src/services/teamMemorySync/`)
- Agent 颜色管理 (`agentColorManager.ts`)
- Team 文件 (`.claude/teams/*.json`)

天枢无 team 系统。

**补强建议**：
- P2: 实现 agent 间通信（基于现有的 CollaborationProtocol 扩展）
- P3: 实现 team 概念（多 agent 协作工作流）

### 5.3 Remote Agent（天枢缺失 ❌）

Claude Code 有 `src/tasks/RemoteAgentTask/`：
- 远程 agent 会话 (teleport)
- 后台远程 agent 生命周期管理
- 远程 agent 元数据持久化
- Ultrareview / Ultraplan / Autofix-pr 远程任务类型

天枢无远程 agent。

**补强建议**：
- P3: 考虑是否需要——天枢的 worktree 隔离已覆盖本地隔离需求

---

## 六、UI/交互差异

### 6.1 Vim Mode（天枢缺失 ❌）

Claude Code 有完整的 Vim 模式：
- `src/vim/` — motions, operators, transitions, textObjects
- 支持 Vim 键绑定

天枢无 Vim 模式。

**补强建议**：
- P3: 低优先级

### 6.2 IDE 集成（天枢缺失 ❌）

Claude Code 有：
- IDE 连接状态 (`useIdeConnectionStatus.ts`)
- IDE 选择同步 (`useIdeSelection.ts`)
- Diff in IDE (`useDiffInIDE.ts`)
- IDE 日志 (`useIdeLogging.ts`)

天枢无 IDE 集成。

**补强建议**：
- P2: 实现 VS Code 扩展集成（diff 展示、文件跳转）

### 6.3 命令系统（天枢较弱）

Claude Code 有：
- `src/commands/` — 内置命令系统
- Slash commands (`/commit`, `/verify`, `/remember` 等)
- 命令队列 (`useCommandQueue.ts`)

天枢有基础的命令注册，但无 slash command 系统。

**补强建议**：
- P1: 实现 `/` 前缀命令系统
- 内置命令: `/compact`, `/clear`, `/undo`, `/commit`

---

## 七、其他差异

### 7.1 Cost Tracking（天枢缺失 ❌）

Claude Code 有：
- `cost-tracker.ts` — 成本追踪
- `costHook.ts` — 成本 hook
- 每个 session 的 token 使用统计

天枢无成本追踪。

**补强建议**：
- P2: 实现 token 使用统计 + 成本估算

### 7.2 Auto Dream（天枢有 Dream 但非自动）

Claude Code 有 `src/services/autoDream/`：
- 自动在空闲时运行记忆整理
- 后台 agent 模式

天枢有 Dream session，但是手动触发。

**补强建议**：
- P2: 实现自动 Dream（session 空闲时自动运行记忆整理）

### 7.3 LSP 集成（天枢缺失 ❌）

Claude Code 有 `src/services/lsp/`：
- LSP 客户端 (`LSPClient.ts`)
- LSP 诊断注册 (`LSPDiagnosticRegistry.ts`)
- LSP 服务器实例管理 (`LSPServerInstance.ts`, `LSPServerManager.ts`)
- 被动反馈 (`passiveFeedback.ts`)

天枢无 LSP 集成。

**补强建议**：
- P1: 实现 LSP 集成（go-to-definition, find-references）
- 直接影响 tool call 信噪比和 token 效率

### 7.4 MCP 集成（天枢缺失 ❌）

Claude Code 有 `src/services/mcp/`：
- MCP 客户端
- MCP 资源管理
- MCP 工具集成
- MCP Skill 构建器

天枢无 MCP 集成。

**补强建议**：
- P1: 实现 MCP 客户端（扩展工具生态）

### 7.5 Analytics/遥测（天枢缺失 ❌）

Claude Code 有：
- `src/services/analytics/` — 事件追踪
- GrowthBook feature flags
- OpenTelemetry 集成

天枢有基础的 telemetry，但无 feature flag 系统。

**补强建议**：
- P3: 低优先级

---

## 八、优先级总结

### P0 — 核心缺失（应尽快补齐）

| 功能 | 价值 | 复杂度 |
|------|------|--------|
| Memory 系统 | 跨会话知识积累 | 中 |
| LSP 集成 | 提升 tool call 信噪比 | 中 |
| MCP 客户端 | 扩展工具生态 | 中 |

### P1 — 重要差异（应在 1-2 个迭代内补齐）

| 功能 | 价值 | 复杂度 |
|------|------|--------|
| Plan Mode 工作流 | 复杂任务质量提升 | 中 |
| Agent 定义外部化 | 用户可自定义 agent | 低 |
| Slash command 系统 | 用户交互效率 | 低 |
| Skill 系统 | 用户可扩展功能 | 中 |
| 权限冒泡 | 多 agent 安全协作 | 中 |
| 自动记忆提取 | 被动知识积累 | 中 |
| 破坏性命令警告 | 安全性提升 | 低 |

### P2 — 有价值但可推迟

| 功能 | 价值 | 复杂度 |
|------|------|--------|
| Task 完整生命周期 | 后台任务管理 | 中 |
| Agent 间通信 | 多 agent 协作 | 高 |
| Team 系统 | 多 agent 团队协作 | 高 |
| 用户可配 Hook | 可扩展性 | 中 |
| 沙箱排除命令列表 | 安全性 | 低 |
| 成本追踪 | 资源管理 | 低 |
| 自动 Dream | 记忆整理 | 中 |
| IDE 集成 | 用户体验 | 高 |
| sessionMemoryCompact | 上下文管理 | 低 |

### P3 — 可选/低优先级

| 功能 | 说明 |
|------|------|
| Workflow Tool | goal-loop + todo 已覆盖 |
| REPLTool | bash 已覆盖 |
| Vim Mode | 小众需求 |
| Remote Agent | worktree 已覆盖 |
| Coordinator Mode | delegate 已覆盖 |
| Plugin 系统 | tool registry 已覆盖 |
| Analytics/遥测 | 非核心 |

---

## 九、天枢独有优势（不应丢失）

| 功能 | 说明 |
|------|------|
| Sensorium 3D 自感知 | momentum/confidence/pressure/vigor 实时感知 |
| Immune 系统 | Innate + Adaptive + APC + Context + Hook 五层免疫 |
| Sycophancy Trap | 讨好检测 + 质疑注入 |
| Repair Pipeline | fourHorsemen + semantic + ctclSanitizer |
| Dream 记忆蒸馏 | 会话记忆整理 |
| Prefix Cache 原生优化 | Ice Mirror cache engine + anchor 保护 |
| Evidence Tracker | 证据追踪链 |
| Star Domain Voice | 领域人格化 |
| Doom Loop 防护 | TraceStore + getDoomLoopLevel() |
| Prediction Error 小脑环 | 连续失败 → intervention level → gate/escalate |
| 多模型协作 | Ice Mirror + 多 provider adapter |

---

## 十、实施路线图建议

### Phase 1（2 周）：基础补强
1. Memory 系统（MEMORY.md + 分类记忆 + 关键词搜索）
2. Slash command 系统（`/compact`, `/clear`, `/undo`）
3. 破坏性命令警告（移植 `destructiveCommandWarning.ts` 模式）

### Phase 2（2 周）：能力扩展
4. LSP 集成原型（go-to-definition）
5. MCP 客户端原型
6. Plan Mode 工作流
7. Agent 定义外部化

### Phase 3（2 周）：高级功能
8. Skill 系统
9. 自动记忆提取
10. 权限冒泡
11. 成本追踪
