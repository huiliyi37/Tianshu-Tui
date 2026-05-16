# Rivet TUI 能力缺漏补齐 — 总体设计

> 对标 Claude Code + DeepSeek-TUI + OpenClaw，三波实施

## 目标定位

**OpenClaw 级智能体架构 + Claude Code 级开发者能力 + DeepSeek-TUI 级 TUI 体验**

## 三波实施路线图

### Wave 1：补齐核心缺漏（1-2 周）
让 Rivet 达到"终端编码代理标配"水平。

| 能力 | 优先级 | 复杂度 |
|------|--------|--------|
| Headless 模式 (`rivet -p "prompt"`) | P0 | 中 |
| Permission allow rules | P0 | 低 |
| Cost/token 实时显示 | P0 | 低 |
| Custom slash commands | P1 | 低 |
| Onboarding 引导 | P1 | 中 |

### Wave 2：差异化超越（2-3 周）
让 Rivet 在关键维度超越竞品。

| 能力 | 优先级 | 复杂度 |
|------|--------|--------|
| HTTP/SSE Runtime API | P0 | 高 |
| LSP 诊断集成 | P1 | 中 |
| Session forking | P1 | 中 |
| 审批编辑 | P1 | 低 |
| 自动推理等级 | P2 | 中 |

### Wave 3：体验打磨（3-4 周）
让 Rivet 的日常使用体验达到顶级。

| 能力 | 优先级 | 复杂度 |
|------|--------|--------|
| Vim keybindings | P1 | 中 |
| @file 自动补全 | P1 | 中 |
| 命令面板 (Ctrl-K) | P2 | 中 |
| 外部编辑器 (Ctrl-O) | P2 | 低 |
| Git worktree 隔离 | P2 | 高 |

---

## Wave 1 架构决策

### 1. Headless 模式

**设计**：`rivet -p "prompt"` 跳过 Ink TUI 渲染，直接运行 AgentLoop 并将输出写到 stdout。

```
rivet -p "fix the bug"           # 单次执行，输出结果
rivet -p "fix" --json            # JSON 输出（tool calls + result）
rivet -p "fix" --stream-json     # 逐事件 JSON 流
cat prompt.txt | rivet -p -      # 从 stdin 读取 prompt
```

**关键决策**：
- 复用现有 `AgentLoop`，不创建新的 agent 实现
- 输出格式：text（默认）、json、stream-json
- 退出码：0 = 成功，1 = agent 错误，2 = 配置错误
- 不渲染 Ink 组件，直接 `process.stdout.write`

**文件**：
- 修改 `src/main.tsx`：CLI 参数解析，分支到 headless 路径
- 创建 `src/headless.ts`：headless 执行逻辑

### 2. Permission Allow Rules

**设计**：在 config 中增加 `permissions.allow` 数组，匹配的 tool call 自动批准。

```json
{
  "permissions": {
    "allow": [
      "read_file",
      "grep",
      "glob",
      "bash:npm test",
      "bash:npm run build",
      "git:status",
      "git:diff"
    ]
  }
}
```

**规则**：
- `"tool_name"` — 该工具所有调用自动批准
- `"tool_name:pattern"` — 仅匹配 pattern 的调用自动批准（bash 匹配命令前缀，git 匹配 action）
- 读操作（read_file, grep, glob, git:status, git:diff, git:log）默认免审批
- `permissions.mode: "bypass"` 跳过所有审批（CI 模式）

**文件**：
- 修改 `src/config/schema.ts`：增加 permissions schema
- 创建 `src/agent/permissions.ts`：匹配逻辑
- 修改 `src/agent/loop.ts`：审批前检查 allow rules

### 3. Cost/Token 实时显示

**设计**：在 SummaryBar 中增加 token 消耗和费用显示。

```
[Turn 5] ↑12.3K ↓2.1K | $0.042 | Cache: 99.1% | ████░░ 62%
```

**数据来源**：API response 的 `usage` 字段已有 `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`。

**文件**：
- 创建 `src/tui/cost-tracker.ts`：累积 token/cost 计算
- 修改 `src/tui/summary-bar.tsx`：显示 cost 信息

### 4. Custom Slash Commands

**设计**：从 `.rivet/commands/*.md` 加载用户自定义命令。

```markdown
<!-- .rivet/commands/review.md -->
Review the changes in the current branch against main.
Focus on: security issues, performance problems, and code style.
Use `git diff main...HEAD` to see the changes.
```

用户输入 `/review` 时，将文件内容作为 user message 发送。

**文件**：
- 创建 `src/commands/loader.ts`：扫描 + 加载命令文件
- 修改 `src/tui/app.tsx`：未知 slash command 时查找自定义命令

### 5. Onboarding 引导

**设计**：首次运行时（无 `~/.rivet/config.json`）启动交互式设置向导。

步骤：
1. 选择 provider（DeepSeek / OpenAI / Anthropic / Custom）
2. 输入 API key
3. 选择默认模型
4. 保存 config

**文件**：
- 创建 `src/tui/onboarding.tsx`：Ink 组件，引导流程
- 修改 `src/main.tsx`：检测首次运行，渲染 onboarding

---

## 与现有系统的关系

| 新能力 | 依赖的现有组件 | 不改变的组件 |
|--------|--------------|-------------|
| Headless | AgentLoop, ToolRegistry, PromptEngine | TUI 组件（不加载） |
| Permissions | approval-risk.ts（扩展） | hooks 系统 |
| Cost display | SummaryBar（扩展） | API client |
| Custom commands | app.tsx 命令路由 | 其他 slash commands |
| Onboarding | config/schema.ts | 已有配置加载逻辑 |
