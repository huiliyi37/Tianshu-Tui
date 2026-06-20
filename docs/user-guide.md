# Rivet 用户手册

> 面向开源用户的安装、配置与使用指南。API 级细节见 README.md。

## 安装

```bash
git clone <repo> && cd rivet
npm install && npm run build
```

需要 Node.js 22+。

## 配置 API Key

至少配置一个 Provider：

```bash
# DeepSeek（默认，推荐）
export DEEPSEEK_API_KEY=sk-xxx
# 或持久保存：
rivet config set-key deepseek sk-xxx

# 其他 Provider
rivet config setup glm --key-env ZHIPU_API_KEY
rivet config setup codex --default          # OAuth 浏览器登录
```

完整 Provider 列表和参数见 [Provider 配置手册](user-guide-provider-config.md)。

## 启动

```bash
node dist/main.js                    # 交互式 TUI
node dist/main.js -p "修复 typo"      # 单次执行（headless）
```

## 基本用法

在输入框输入需求，按 Enter 发送。Rivet 会自动读文件、搜索代码、做修改、跑测试，完成后展示证据摘要。

会话自动保存到 `.rivet/sessions/`，重启后可用 `/resume` 恢复。

## 核心功能

### 模型切换

```
/model list              查看已配置的模型
/model deepseek-v4-pro   切换
/model glm-5.2
```

推理深度通过 `/effort` 控制（off/low/medium/high/max）。

### Goal 自治模式

```
/goal 把认证模块全部改成 async/await
```

设定目标后 Rivet 自主多轮执行，直到完成或 `/cancel-goal`。Goal 模式下 doom-loop 检测阈值放宽，允许更深探索。

### Rewind（回退）

双击 ESC 打开历史消息列表，选中任意一条用户消息即可回退到该时点——对话状态、工具历史、会话元数据全部干净回滚。

### Council（多专家评审）

```
/council 重构认证模块的方案
/council 重构认证模块的方案 --rounds 2
```

召集多个专家席位评审设计，冲突时可选第二轮反驳，产出带席位贡献和收敛状态的审计计划。

### 子代理委派

Rivet 自动将子任务委派给独立 worker 会话：只读 worker 做搜索/审查，写 worker 做修改。按 profile 自适应选择最优模型。

```
/model list   看 worker 可用的模型
```

Worker 路由配置见 README 的 Worker Routing 段。

### Slash 命令速查

| 命令 | 用途 |
|------|------|
| `/help` | 查看所有命令 |
| `/model [name\|list]` | 切换/查看模型 |
| `/goal` `/cancel-goal` | 自治目标 |
| `/plan` | 计划模式（先设计后执行） |
| `/council` | 多专家评审 |
| `/compact` | 立即压缩上下文 |
| `/context` | 查看上下文健康度 |
| `/evidence` | 查看证据摘要 |
| `/rollback` | 预览/恢复 git checkpoint |
| `/undo` | 撤销上次文件修改 |
| `/sessions` `/resume <n>` | 列出/恢复会话 |
| `/effort` | 推理深度 |
| `/theme` | 切换配色 |
| `/debug cache` | 缓存命中率诊断 |
| `/exit` | 保存并退出 |

## 配置文件

编辑 `~/.rivet/config.json`（只需写覆盖项，默认值自动深合并）：

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [{ "id": "deepseek-v4-pro", "contextWindow": 1000000 }]
      }
    }
  },
  "agent": { "approval": "auto-safe", "crossSessionEnabled": true },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

### 审批模式

| 值 | 行为 |
|----|------|
| `auto-safe`（默认） | 低风险自动通过，高风险仍需确认 |
| `manual` | 凡需审批的工具都问 |
| `dangerously-skip-permissions` | 跳过所有交互确认（仅限可信环境） |

```bash
rivet config set-approval dangerously-skip-permissions
rivet --dangerously-skip-permissions   # 单次会话覆盖
```

跳过确认**不影响**工具验证、路径安全、证据追踪、checkpoint 和交付门禁。

### 跨会话知识

默认开启。Rivet 从 `.rivet/knowledge/memory.jsonl` 加载蒸馏知识（项目规则、调试经验），注入新会话。关闭：

```json
{ "agent": { "crossSessionEnabled": false } }
```

或环境变量强制关闭：`RIVET_NO_CROSS_SESSION=1`

### Skills

在 `.rivet/skills/` 放 `.md` 文件即可注册技能：

```markdown
---
name: deploy-check
description: 上线前检查清单
triggers: [deploy, 部署, release]
---
1. 确认环境变量
2. 确认回滚方案
```

技能只注入名称和描述到上下文，完整指令按需通过 `skill` 工具加载。可按名称导入 Claude Code 的技能。

### MCP 服务器

```bash
rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp
rivet config mcp add-sse ctx7 http://localhost:3001/sse
rivet config mcp list
```

MCP 工具以 `mcp__<serverId>__<toolName>` 命名，启动时自动发现。

## 数据位置

```
.rivet/
├── sessions/<id>.jsonl          对话记录
├── sessions/<id>.meta.json      元数据
├── knowledge/memory.jsonl       跨会话知识
└── artifacts/                   大输出持久化
```

配置文件在 `~/.rivet/config.json`。

## FAQ

**缓存命中率怎么看？** 状态栏实时显示。`/debug cache` 看详细统计和 miss 原因分析。

**长会话上下文不够怎么办？** Rivet 在 800K tokens 自动压缩，保留前 2 条消息作为缓存锚点。也可手动 `/compact`。

**多个项目同时开会话冲突吗？** 不冲突。每次启动生成唯一 session ID，数据按 ID 隔离。用 git worktree 可获得最大隔离。

**怎么恢复上次会话？** `/sessions` 列出所有会话，`/resume <序号>` 恢复。
