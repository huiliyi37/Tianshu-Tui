# 天枢 (Tianshu)

一个全功能的终端编程智能体运行时——智能上下文管理、多模型协调、DeepSeek V4 前缀缓存优化、结构化审查纪律、可扩展工具架构。

> 🇨🇳 [中文文档](README.zh-CN.md) · 📖 [English](README.md)

基于 **TypeScript strict** + **ANSI 终端渲染引擎 (T9)** + 流式 API 构建。约 15 万行源码,520+ 测试文件。

## 为什么做天枢

大多数 AI 编程助手把上下文当作桶——装满就溢出,然后盲目压缩。天枢把上下文当作**结构化、可缓存的资源**:

- **前缀缓存命中率高达 99.6%**——通过冻结/易变提示词分层、基于 SHA-256 指纹的漂移检测和自适应压缩阈值,在 DeepSeek V4 的 1M 上下文窗口上实现
- **跨回合验证**——每项代码改动在提交前都要经过追踪、测试和交付门禁;"测试通过"是底线,不是天花板
- **多模型 Worker 委派**——生成独立上下文的无界面 worker,自适应模型路由,4 种聚合策略
- **结构化审查纪律**——内置对抗性验证、路径边界检查和复杂规格的数据流验证

## 特性

### 前缀缓存引擎

DeepSeek 对缓存未命中收取 50× 费用。天枢的提示词引擎围绕前缀缓存友好构建:

- **冻结前缀**——系统提示词 + 工具定义 + 稳定上下文在会话开始时被冻结,永不重写。DeepSeek 的 exact-prefix 缓存在每次后续请求中都命中。
- **增量附录**——动态上下文(进度、advisories、信号)作为跨回合 diff append-only 块注入,永不重写历史消息。回合间增量约 200 字节 vs ~5KB 全量重写。
- **Read-ref 去重**——对未变化文件的重复读取返回紧凑引用而非重新输出完整内容,节省上下文 token。
- **缓存感知压缩**——压缩保留前 2 条消息作为缓存锚点,选择回合时维持 API 不变量。
- **诊断**——`/debug cache` 显示命中率(绿 ≥80%、黄 ≥40%、红 <40%)、未命中原因分析、每回合缓存历史。

实战命中率:长会话稳定 95-99%。

### 多提供商 + 自适应路由

| 提供商 | 认证 | 旗舰模型 |
|--------|------|----------|
| DeepSeek | API key | deepseek-v4-pro (1M ctx), deepseek-v4-flash |
| Claude | API key (通过 `cc-switch` 代理) | opus-4-7, opus-4-6, sonnet-4-5 |
| GLM (智谱) | API key | glm-5.2 |
| Codex (GPT-5.5) | OAuth PKCE (ChatGPT 订阅) | gpt-5.5 |
| MiniMax | API key | MiniMax-M2.7 |
| MiMo | API key | mimo-v2.5-pro |

在会话内用 `/model <name>` 切换提供商。为主 agent 和子 agent 配置不同模型(见 [Provider Config](docs/user-guide-provider-config.md))。

### 子智能体编排

将子任务委派给独立的无界面 worker 会话:

- **类型化 work orders**——code_search、review、verify、patch_proposal、plan
- **工具隔离**——只读 worker (scout) vs 写 worker (patcher)
- **自适应模型路由**——按 profile 的通过率 + 延迟评分自动选择每个任务类型的最佳模型
- **批量调度**——多个 work order 并发执行,5 种聚合策略(primary_decides、all_required、first_success、majority、weighted_confidence)
- **团队编排**——Plan → 按 wave 并行执行,带文件冲突感知的调度

### 目标驱动的自动续跑

设定一个高层目标,天枢跨多个回合自主运行:

```
/goal 重构认证模块,全面使用 async/await
/cancel-goal   # 提前停止
```

GoalTracker 与回合循环、doom-loop 检测、交付门禁集成。在 goal 模式下,doom-loop 阈值放宽,允许更深入探索。

### 倒带(Rewind)

随时双击 **ESC** 打开消息历史。选择任一过往用户消息,将会话倒带到该点——agent 状态、工具历史、会话元数据都干净地回滚。TUI 和 desktop 都可用。

### 委员会(多视角审查)

```
/council <objective>
/council <objective> --rounds 2   # 启用反驳轮次
```

召集多个专家席位审查一个计划或设计,当出现冲突时可选用第二轮反驳。产出可审计的 Markdown 计划,含席位贡献和收敛状态。

### Skills 系统

可复用的工作流剧本,从 `.rivet/skills/*.md` 加载。两层渐进式披露:只有 name + description 进入上下文,完整指令按需通过 `skill` 工具加载。配置中可按名导入指定 Claude Code skills。

**内置 skills** 随仓库发布在 `.rivet/skills/`:

| Skill | 说明 |
|-------|------|
| `writing-plans` | 结构化计划写作,含 Mermaid 图、spec 段落、验证计划 |
| `executing-plans` | 任务图分解,按 wave 执行,每 wave 验证 |
| `subagent-driven-development` | 委派复杂任务,带类型化 profile、批量调度、并行 worker |
| `agent-harness-testing` | TDD 可行性探针、测试脚手架、red-green-refactor 工作流 |
| `research-spec` | 研究 + spec 工作流:探索 → 条件矩阵 → 反证表 |

**使用 skill**:

```
/skill writing-plans       # 把完整指令加载进上下文
```

或当任务匹配触发模式时,agent 自动加载。

**创建自定义 skill**——在 `.rivet/skills/` 放一个 `.md` 文件,带 YAML frontmatter:

```markdown
---
name: my-workflow
description: 一句话描述这个 skill 做什么。
triggers:
  - 触发该 skill 的关键词或模式
---

# My Workflow

加载该 skill 时 agent 遵循的分步指令...
```

Skills 可共享:在项目间复制 `.rivet/skills/`,或通过配置引用中心化 skills 目录。

### 跨会话知识

蒸馏过的知识跨会话持久化(默认启用):

| 来源 | 内容 |
|------|------|
| `.rivet/knowledge/memory.jsonl` | 项目规则、调试启发式、架构约定 |
| `.rivet/sessions/<id>/pheromones.json` | 跨会话信号 |
| `.rivet/presence.json` | 伴生 agent 感知 |

通过配置 `agent.crossSessionEnabled` 切换。强制关闭: `RIVET_NO_CROSS_SESSION=1`。

### MCP (Model Context Protocol)

连接外部工具服务器——文档搜索、数据库、API——直接接入 agent 的工具流水线。MCP 服务器启动时自动发现,其工具以 `mcp__<serverId>__<toolName>` 形式出现。

**前置条件**:Node.js 22+ 且 `npx` 可用(stdio 传输)。SSE 服务器是基于网络的,不需要本地运行时。

**添加 MCP 服务器**:

```bash
# stdio 传输(本地进程)
rivet config mcp add-stdio <server-id> npx -y <package> [args...]

# SSE 传输(远程/网络服务器)
rivet config mcp add-sse <server-id> http://localhost:3001/sse

# Streamable HTTP 传输(2025 规范)
rivet config mcp add-http <server-id> http://localhost:3001/mcp
```

**内置预设**——一行命令安装常用服务器:

```bash
rivet config mcp add-preset context7    # @upstash/context7-mcp —— 实时库文档
```

**列出和管理**:

```bash
rivet config mcp list                   # 显示所有已注册服务器 + 状态
rivet config mcp remove <server-id>     # 移除服务器
rivet config mcp set-timeout <server-id> 30000  # 覆盖默认 60s 超时
```

**会话内**:

```
/mcp                          # 显示所有 MCP 服务器的连接状态
/debug mcp                    # 详细诊断(启动错误、工具发现)
```

MCP 工具与内置工具遵循同一审批模式(`auto-safe` / `manual` / `dangerously-skip-permissions`)。

**故障排查**:首次 `npx` 安装卡住,增大超时(`rivet config mcp set-timeout <id> 120000`)。SSE 服务器连接失败,确认服务器在运行且 URL 从 agent 进程可达。

### 验证与审查

- **审查纪律**——四条强制规则:禁止同上下文自我审批、修复前生成对抗性验证器、对触及文件运行既有测试、对无证据的"绿声明"执行失败关闭
- **交付门禁**——`deliver_task` 检查证据、影响文件和测试结果后才允许提交
- **路径边界审查**——对路径遍历、分类正确性和失败关闭安全性的结构化检查

### 审批模式

| 模式 | 行为 |
|------|------|
| `auto-safe` (默认) | 低风险操作自动批准,高风险仍询问 |
| `manual` | 任何工具声明需要审批时都询问 |
| `dangerously-skip-permissions` | 跳过所有交互式提示——仅限可信工作区 |

```bash
rivet config set-approval dangerously-skip-permissions
rivet --dangerously-skip-permissions   # 单次覆盖
```

跳过提示**不会**禁用工具验证、路径安全、证据追踪、检查点、交付门禁。

## 快速开始

### 1. 环境要求

- **Node.js 24.1.0**（推荐；22+ 可能可用）— 用 `node --version` 检查。
- **Git** — 可选但强烈建议；没有它天枢仍可运行，但委派/检查点/回滚功能会降级。

### 2. 克隆并构建

```bash
git clone https://github.com/huiliyi37/Tianshu-Tui.git
cd Tianshu-Tui
npm install
npm run build
```

这会生成 TUI 入口文件 `dist/main.js`。

### 3. 配置 API Key

```bash
# A. 环境变量（首次试用最简单）
export DEEPSEEK_API_KEY=sk-xxx

# B. 持久化 CLI 配置（保存到 ~/.rivet/config.json）
node dist/main.js config set-key deepseek sk-xxx
```

> 其他提供商（Claude、GLM、Codex、MiniMax、MiMo）使用相同模式。运行
> `node dist/main.js config set-key <provider> <key>` 或查看
> [Provider Config](docs/user-guide-provider-config.md)。

### 4. 启动

```bash
npm start
# 或直接运行：node dist/main.js
```

你应该会看到带有 `〉` 提示符的 TUI。输入需求后按回车即可。

> 安装的 CLI 命令是 `rivet`（项目早期代号）。仓库与项目名为**天枢/Tianshu**，
> 二进制名保持 `rivet` 以兼容旧用法。

### 可选：全局安装

构建完成后，可以将 `rivet` 命令全局安装，方便从任意目录启动：

```bash
npm install -g .
rivet
```

> 注意：从仓库全局安装依赖 `dist/main.js` 已存在，请先执行 `npm run build`。
> 从 npm 安装则直接运行 `npm install -g tianshu-tui && rivet`（需已发布到 registry）。

### 无界面模式

```bash
# 单次提示,文本输出,无 TUI
rivet -p "解释 src/agent/loop.ts"

# JSON 输出,用于脚本集成
rivet -p "列出所有 TODO 注释" --json
```

## 配置

### 提供商设置

```bash
# 交互式设置(TTY)
rivet config

# 通过环境变量配置 DeepSeek
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default

# GLM
rivet config setup glm --key-env ZHIPU_API_KEY

# Codex OAuth(首次运行浏览器登录)
rivet config setup codex --default

# 完整配置
rivet config show
```

或直接编辑 `~/.rivet/config.json`(只覆盖需要的字段,默认值深度合并):

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          { "id": "deepseek-v4-pro", "contextWindow": 1000000, "maxTokens": 64000 }
        ]
      }
    }
  },
  "agent": {
    "maxTurns": 50,
    "approval": "auto-safe",
    "crossSessionEnabled": true
  },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

### Worker 路由

为子 agent 使用不同提供商:

```json
{
  "workers": {
    "profiles": {
      "capable": { "provider": "codex", "model": "gpt-5.5" },
      "cheap":   { "provider": "minimax", "model": "MiniMax-M2.7" }
    },
    "routing": {
      "code_edit": "capable",
      "repo_summarization": "cheap"
    }
  }
}
```

### MCP 服务器

通过 Model Context Protocol 连接外部工具服务器:

```bash
rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp
rivet config mcp add-sse ctx7 http://localhost:3001/sse
rivet config mcp list
```

MCP 工具以 `mcp__<serverId>__<toolName>` 形式出现,启动时自动发现。

### 项目指令

在项目根目录放置 `.rivet.md` 文件,其内容会自动注入为项目上下文:

```markdown
# 项目指令
- 使用 pnpm,不用 npm
- 提交前所有测试必须通过
- 遵循约定式提交格式
```

### 自定义斜杠命令

在 `.rivet/commands/` 目录下定义命令:

```bash
mkdir -p .rivet/commands
echo '审查这段代码的问题并给出修复建议:
$ARGUMENTS' > .rivet/commands/review.md
```

### 会话持久化

会话保存到 `~/.rivet/sessions/<project-slug>/`。重启后按 `r` 恢复,按任意键开始新会话。

### 自动检查点

天枢在每个回合首次修改文件前自动创建 Git 检查点:
- `/rollback`——预览将被丢弃的内容
- `/rollback confirm`——恢复到检查点

## 工具集(49 个工具)

| 类别 | 工具 |
|------|------|
| **文件 I/O** | read_file, edit_file, write_file, glob, grep, diff |
| **执行** | bash, run_tests, sandbox_exec |
| **Git** | git(status, diff, log, stash, commit), undo |
| **导航** | repo_map, inspect_project, related_tests, repo_graph |
| **知识** | recall, remember, plan_submit, delegate_task |
| **网络** | web_fetch(HTML→Markdown,SSRF 安全) |
| **元工具** | todo, deliver_task, hash_edit, apply_patch |

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/model [name\|list]` | 显示或切换模型/提供商 |
| `/goal <text>` | 设置自主目标;运行到完成 |
| `/cancel-goal` | 停止目标执行 |
| `/plan` | 进入计划模式(设计优先,审批门禁) |
| `/council <text>` | 召集多专家审查 |
| `/compact` | 立即压缩上下文 |
| `/context` | 显示上下文账本:健康度、tokens、回合、声明 |
| `/evidence` | 显示证据摘要(读取/修改的文件、测试) |
| `/rollback` | 预览/恢复 git 检查点(`confirm` 执行) |
| `/undo` | 撤销上次文件变更(预览,`confirm` 恢复) |
| `/rewind` | 双 ESC:倒带到过往用户消息 |
| `/sessions` `/resume <n>` | 列出/恢复已保存会话 |
| `/effort [off\|low\|medium\|high\|max]` | 控制推理深度 |
| `/theme [name\|list]` | 切换色彩主题 |
| `/skill <name>` | 加载 skill 的完整指令 |
| `/debug [prompt\|cache\|mcp]` | 调试 prompt、缓存统计或 MCP |
| `/mcp` | MCP 服务器连接状态 |
| `/memory <text>` | 保存会话记忆条目 |
| `/exit` `/quit` | 保存会话并退出 |

双击 **ESC** 打开倒带覆盖层。按 **Esc** 关闭任何覆盖层。

## 开发

### 技术栈

Node.js 22 · TypeScript strict (`noUncheckedIndexedAccess`) · T9 ANSI 渲染引擎 · tsup 打包 · node:test + assert/strict

### 构建与测试

```bash
npx tsc --noEmit                                    # typecheck
npm exec -- tsx --test src/**/__tests__/*.test.ts   # 所有测试(2700+)
npm run build                                        # tsup 打包
npm run dev                                          # tsup --watch
node dist/main.js                                    # 启动 TUI
node dist/main.js -p "fix the typo"                  # 无界面模式
```

### 代码约定

- TypeScript strict 模式,`noUncheckedIndexedAccess: true`
- 数据不用 class——使用 `interface` + 纯对象
- async/await + try-catch,不用裸 Promise 链
- 工具返回 `ToolResult { content, isError?, rawPath?, uiContent? }`
- 测试文件镜像源码:`src/agent/foo.ts` → `src/agent/__tests__/foo.test.ts`

### 扩展

**添加工具**——在 `src/tools/` 实现 `ToolDefinition` + executor,在 `src/main.tsx` 注册,在 `src/tools/__tests__/` 加测试。工具返回 `ToolResult { content, isError?, rawPath?, uiContent? }`。

**添加 skill**——在 `.rivet/skills/` 放一个带 frontmatter(`name`、`description`、`triggers`)的 `.md` 文件。完整指令按需加载。

**添加斜杠命令**——项目级 `.rivet/commands/*.md`,带 `$ARGUMENTS` 插值。

**添加 hook**——实现 `PreToolUse | PostToolUse | UserPromptSubmit | PreCompact` 处理器,通过 `HookRegistry` 注册。处理器是隔离的——一个坏 hook 永远不会让循环崩溃。

### 架构

```
src/
├── agent/     核心循环(250+ 模块):turn-orchestrator、tool pipeline、coordinator、
│              advisory-bus、goal-tracker、plan-execution-trace、sensorium、免疫系统
├── api/       流式 API 客户端 —— DeepSeek、GLM、Codex OAuth、多提供商路由
├── prompt/    提示词引擎 —— 冻结前缀 + 增量附录 + 易变上下文层
├── tools/     30+ 工具 —— bash、edit、read/write、grep、glob、run_tests、git、delegate、
│              deliver_task、plan_submit、council_convene、web_fetch、lsp、undo、rewind
├── tui/       终端 UI(T9 ANSI 引擎:commit-engine scrollback、input controller、overlay system、stream renderer)
│   ├── engine/   Commit-engine scrollback、input controller、overlay system、stream renderer
│   └── cockpit/  多面板 cockpit:trace、verify、context、safety、model、MCP
├── compact/   三层语义修剪 + 微压缩 + T7 请求时坍缩
├── context/   上下文账本、渐进式压缩、声明系统、锚点注册表
├── config/    Zod 验证配置:默认值 → ~/.rivet → 项目覆盖
├── server/    Desktop sidecar:会话管理、REST 路由、SSE 流
├── mcp/       Model Context Protocol 客户端(stdio + SSE)
├── lsp/       Language Server Protocol 集成
└── search/    语义搜索(BM25 + embedding RRF 融合)
```

### 数据流

```
用户输入 → 斜杠命令路由(内置 / 自定义 / agent)
           → AgentLoop:
               PromptEngine.buildRequest()
                 冻结的系统提示词(缓存锚点)
                 增量附录(跨回合 diff,约 200 字节)
                 易变上下文(git 状态、工具历史、进度)
               ApiClient.stream() → SSE → 内容块(text、thinking、tool_use)
               工具执行流水线:
                 PreToolUse hook → 审批 → 执行 → PostToolUse hook
                 → 证据追踪 → 写时缓存失效
               循环至无 tool_use 或 maxTurns
```

### 会话数据

会话日志存储在项目外的 `~/.rivet/sessions/<project-slug>/`（slug = 目录名 + cwd 哈希前缀）。这样 `glob`/`grep`（尊重 `.gitignore`）不会扫描到 agent 自身的运维数据，避免污染工作区。可用 `RIVET_SESSION_DIR` 覆盖。

```
~/.rivet/sessions/<slug>/
├── <id>.jsonl                  对话记录
├── <id>.meta.json              元数据:model、回合数、退出状态
├── <id>/cache-log.jsonl        每请求缓存遥测
├── knowledge/memory.jsonl      跨会话蒸馏知识
└── artifacts/                   大输出持久化
```

全局配置在 `~/.rivet/config.json`。

### 多会话隔离

每次启动得到一个唯一会话 ID。会话文件、检查点、记忆都按该 ID 作用域——多个 TUI 实例并行运行互不干扰。要最大隔离,使用 git worktree。

## 安全

- **路径边界强制**——glob/grep/diff 拒绝 `..` 路径穿越;`validatePath` 阻止逃逸
- **符号链接环保护**——realpath + 访问集
- **SSRF 保护**——逐跳 DNS + 私有 IP 拦截,作用于每次重定向
- **敏感文件拒绝**——`.env`、`credentials.*`、`*key*`、`*token*` 禁止读/commit
- **破坏性命令门禁**——`rm -rf`、force push、`DROP/TRUNCATE` 需要显式确认
- **检查点 + 回滚**——每个回合首次修改文件前创建 Git 检查点
- **文件级撤销**——每次写/编辑前的版本化备份
- **Worker 安全**——通过 AbortController 的超时预算,工具白名单强制

## 文档

| 文档 | 说明 |
|------|------|
| [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) | 模型提供商配置指南 |
| [`docs/dangerously-skip-permissions.md`](docs/dangerously-skip-permissions.md) | 权限跳过说明与安全边界 |
| [`docs/meridian-architecture.md`](docs/meridian-architecture.md) | Meridian DB 架构(跨会话学习存储) |
| [`docs/review-discipline.md`](docs/review-discipline.md) | 结构化代码审查规则体系 |
| [`docs/WINDOWS-INSTALL.md`](docs/WINDOWS-INSTALL.md) | Windows 安装与 Shell 兼容性指南 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南 |
| [`config.example.json`](config.example.json) | 示例配置文件（含子代理/审查模型路由） |

## 统计

| 指标 | 数值 |
|------|------|
| TypeScript 源文件 | ~1,050 |
| 测试文件 | 520+ |
| 源码行数 | ~150K |
| 工具实现 | 49 |
| Agent 模块 | 204 |
| TUI 组件 | 94 |
| 依赖数 | 10 |

## 许可证

本项目采用 [Apache License, Version 2.0](LICENSE) 开源许可。

Copyright 2025-2026 Tianshu Contributors
