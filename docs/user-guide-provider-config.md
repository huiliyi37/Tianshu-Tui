# Provider 配置用户手册

> 本文档面向最终用户，解释如何使用 Rivet（天枢）配置模型 Provider。

---

## 什么是 Provider？

Provider 是「模型接入点」——你告诉天枢从哪里调用模型、用什么认证方式、支持哪些能力。

天枢内置了 5 个 Provider 预设，开箱即用：

| Provider | 对应模型 | 协议 | 认证方式 | Context Window | 特点 |
|----------|----------|------|----------|----------------|------|
| `deepseek` | DeepSeek V4 Pro / Flash | OpenAI-compatible | API Key | 1M tokens | 原生前缀缓存，Cache Hit 可达 90%+ |
| `opencode-go` | DeepSeek / MiMo / GLM / Kimi 等开源模型 | OpenAI-compatible | API Key | 1M tokens | OpenCode Go 订阅服务，首月 $5，每月 $10 |
| `opencode-go-anthropic` | Qwen / MiniMax 等开源模型 | Anthropic Messages | API Key | 1M tokens | OpenCode Go 的 Anthropic 协议端点，支持 cache_control |
| `glm` | 智谱 GLM-5.1 | OpenAI-compatible | API Key | 200K tokens | 支持 thinking |
| `mimo` | 小米 MiMo-v2.5-Pro | OpenAI-compatible | API Key | 1M tokens | 支持 thinking，prefix cache |
| `minimax` | MiniMax M2.7 | OpenAI-compatible | API Key | 204.8K tokens | 需过滤 `top_k/metadata/cache_control` 参数 |
| `codex` | GPT-5.5 (ChatGPT 订阅) | Codex Responses | OAuth PKCE | 1M tokens | 使用 ChatGPT 订阅（非 API 计费），自动 token 刷新 |

> 📌 上表 `codex` 行为**预设默认**（直连 ChatGPT OAuth）。本机实际已把 codex 改走本地
> **cliproxy 账号池**（GPT-5.5 / `claude-opus-4-5`）——配置、排障、账号池维护与自动刷新
> 见 [`docs/codex-cliproxy-account-pool.md`](./codex-cliproxy-account-pool.md)。

---

## 配置方式概览

### 方式一：交互式向导（推荐首次使用）

在终端运行：

```bash
rivet config
```

会进入 TTY 交互向导，依次询问：

1. **选择 Provider**：输入 `deepseek` / `glm` / `mimo` / `minimax` / `codex`，或直接回车使用当前默认
2. **认证方式**（非 Codex）：
   - `env` → 输入环境变量名（如 `DEEPSEEK_API_KEY`）
   - `inline` → 直接粘贴 API Key
   - `keep` → 保持现有配置不变
3. **Base URL**：直接回车使用预设地址，或输入自定义地址
4. **Model ID**：直接回车使用默认模型，或输入自定义模型 ID
5. **Model Alias**（可选）：简写别名
6. **Context Window**：直接回车使用预设值
7. **Max Tokens**：直接回车使用预设值
8. **设为默认？** `[y/N]`：输入 `y` 将此 Provider 设为默认

示例输出：

```
Rivet provider configuration
Built-in providers: deepseek, glm, mimo, minimax, codex
Current default: deepseek
Provider [deepseek|glm|mimo|minimax|codex]: deepseek
Auth mode [env|inline|keep]: env
API key env var: DEEPSEEK_API_KEY
Base URL [https://api.deepseek.com/v1]: 
Model ID [deepseek-v4-pro]: 
Model alias: 
Context window [1000000]: 
Max tokens [163000]: 
Set as default? [y/N]: y
Provider deepseek configured. Run "rivet config providers" to inspect.
```

### 方式二：命令行脚本化配置

适合 CI/CD、环境变量自动化、容器化部署等场景。

#### `rivet config setup <provider>`

按内置预设创建或更新 Provider：

```bash
# 使用环境变量配置 DeepSeek
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default

# 使用内联 Key 配置 GLM
rivet config setup glm --key sk-xxxx --default

# 配置 MiMo 并指定自定义 URL
rivet config setup mimo --key-env MIMO_API_KEY --url https://token-plan-sgp.xiaomimimo.com/v1

# 配置 MiniMax 指定模型参数
rivet config setup minimax --key-env MINIMAX_API_KEY --model MiniMax-M2.8 --alias m28 --context-window 300000 --max-tokens 64000 --default

# 配置 Codex（OAuth，无需 API Key）
rivet config setup codex --default
```

支持的 flags：

| Flag | 说明 | 示例 |
|------|------|------|
| `--key <key>` | 内联 API Key（敏感） | `--key sk-xxxx` |
| `--key-env <env>` | API Key 环境变量名 | `--key-env DEEPSEEK_API_KEY` |
| `--url <url>` | 自定义 Base URL | `--url https://api.example.com/v1` |
| `--model <id>` | 模型 ID | `--model deepseek-v4-pro` |
| `--alias <name>` | 模型别名 | `--alias v4-pro` |
| `--context-window <n>` | Context Window 大小 | `--context-window 1000000` |
| `--max-tokens <n>` | 最大输出 Tokens | `--max-tokens 163000` |
| `--default` | 同时设为默认 Provider | `--default` |

#### `rivet config set-url <provider> <url>`

重写 Provider 的 Base URL：

```bash
rivet config set-url deepseek https://api.deepseek.com/v1
rivet config set-url mimo https://token-plan-sgp.xiaomimimo.com/v1
```

#### `rivet config set-model <provider> <id> [context-window] [max-tokens] [alias]`

设置 Provider 的首选模型：

```bash
# 最小参数
rivet config set-model deepseek deepseek-v4-flash

# 完整参数
rivet config set-model minimax MiniMax-M2.8 300000 64000 m28
```

#### `rivet config set-key <provider> <key>`

直接写入 API Key（保存在 `~/.rivet/config.json`，会覆盖环境变量）：

```bash
rivet config set-key deepseek sk-xxxx
```

#### `rivet config set-key-env <provider> <env-var>`

指定 API Key 从环境变量读取（推荐，Key 不落地）：

```bash
rivet config set-key-env deepseek DEEPSEEK_API_KEY
rivet config set-key-env minimax MINIMAX_API_KEY
```

#### `rivet config set-default <provider>`

切换默认 Provider：

```bash
rivet config set-default mimo
```

#### `rivet config providers`

查看所有 Provider 及其状态：

```bash
rivet config providers
```

输出示例：

```
Providers:
  deepseek (default)
    baseUrl: https://api.deepseek.com/v1
    apiKey: env(DEEPSEEK_API_KEY)
    models: v4-pro, v4-flash
  glm
    baseUrl: https://open.bigmodel.cn/api/coding/paas/v4
    apiKey: env(ZHIPU_API_KEY)
    models: glm
  mimo
    baseUrl: https://token-plan-sgp.xiaomimimo.com/v1
    apiKey: env(MIMO_API_KEY)
    models: mimo-pro, mimo
  minimax
    baseUrl: https://api.minimaxi.com/v1
    apiKey: (not set)
    models: minimax
  codex
    baseUrl: https://chatgpt.com/backend-api/codex
    apiKey: oauth
    models: codex
```

#### `rivet config show`

打印完整配置 JSON（可用于调试）：

```bash
rivet config show | jq '.provider'
```

### 方式三：手动编辑 JSON 文件

配置文件位于 `~/.rivet/config.json`。**配置文件只需要写你想覆盖的部分**，其余使用内置默认值。

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "minimax": {
        "apiKeyEnv": "MINIMAX_API_KEY",
        "models": [
          {
            "id": "MiniMax-M2.7",
            "alias": "minimax",
            "contextWindow": 204800,
            "maxTokens": 64000
          }
        ]
      }
    }
  }
}
```

也可以添加自定义 Provider：

```json
{
  "provider": {
    "providers": {
      "my-openai": {
        "name": "my-openai",
        "apiKeyEnv": "MY_OPENAI_KEY",
        "baseUrl": "https://api.openai.com/v1",
        "protocol": "openai",
        "capabilities": {
          "cacheControl": false,
          "stripParams": [],
          "toolJsonBug": false,
          "prefixCache": "none",
          "prefixCompletion": false
        },
        "thinking": "enabled",
        "maxTokens": 128000,
        "models": [
          {
            "id": "gpt-4.1",
            "contextWindow": 200000,
            "maxTokens": 64000
          }
        ],
        "unsupported": []
      }
    }
  }
}
```

---

## 各 Provider 详解

### DeepSeek（默认）

**推荐场景**：通用编程任务、长会话、追求极致性价比。

DeepSeek V4 Pro 支持原生前缀缓存，在长时间对话中 Cache Hit 可达 90%+，显著降低 API 成本。

```bash
rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default
```

可选模型：
- `deepseek-v4-pro`（默认）：完整 thinking，`reasoningEffort: max`
- `deepseek-v4-flash`：快速响应，`reasoningEffort: high`

### OpenCode Go（开源模型订阅服务）

**推荐场景**：一站式接入多个开源编程模型，无需分别申请各厂商 API Key。

OpenCode Go 是 [OpenCode](https://opencode.ai) 提供的低成本订阅服务（首月 $5，之后每月 $10），提供经过测试和基准评估的开源编程模型的稳定访问。模型托管在美国、欧盟和新加坡。

#### 两个 Provider 条目

由于 OpenCode Go 的不同模型使用不同 API 协议，天枢需要配置两个 Provider 条目：

| Provider Key | 协议 | 端点 | 适用模型 |
|--------------|------|------|----------|
| `opencode-go` | OpenAI Chat Completions | `/v1/chat/completions` | DeepSeek V4 Pro/Flash, MiMo-V2.5/V2.5-Pro, GLM-5/5.1, Kimi K2.5/K2.6 |
| `opencode-go-anthropic` | Anthropic Messages | `/v1/messages` | Qwen3.5/3.6/3.7, MiniMax M2.5/M2.7 |

> **注意**：`opencode-go-anthropic` 的 `name` 字段必须设为 `"anthropic"`，这样天枢的 factory 才会路由到 `AnthropicClient`，使用 `/v1/messages` 端点。

#### 配置方法

**方式一：交互式向导**

```bash
rivet config setup opencode-go --key sk-xxxx --default
```

**方式二：手动编辑 `~/.rivet/config.json`**

```json
{
  "provider": {
    "default": "opencode-go",
    "providers": {
      "opencode-go": {
        "name": "opencode-go",
        "apiKey": "sk-xxxx",
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "protocol": "openai",
        "capabilities": {
          "cacheControl": false,
          "stripParams": ["top_k", "metadata", "service_tier", "cache_control"],
          "prefixCache": "none"
        },
        "thinking": "enabled",
        "maxTokens": 64000,
        "models": [
          { "id": "deepseek-v4-pro", "alias": "go-ds4p", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "max" },
          { "id": "deepseek-v4-flash", "alias": "go-ds4f", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "mimo-v2.5-pro", "alias": "go-mimo", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "max" },
          { "id": "glm-5.1", "alias": "go-glm", "contextWindow": 200000, "maxTokens": 64000, "reasoningEffort": "max" },
          { "id": "kimi-k2.6", "alias": "go-kimi", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" }
        ],
        "unsupported": ["stream_options"]
      },
      "opencode-go-anthropic": {
        "name": "anthropic",
        "apiKey": "sk-xxxx",
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "protocol": "openai",
        "capabilities": {
          "cacheControl": true,
          "stripParams": [],
          "prefixCache": "anthropic-cache-control"
        },
        "thinking": "enabled",
        "maxTokens": 64000,
        "models": [
          { "id": "qwen3.7-max", "alias": "go-qwen", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "qwen3.6-plus", "alias": "go-qwen36", "contextWindow": 1000000, "maxTokens": 64000, "reasoningEffort": "high" },
          { "id": "minimax-m2.7", "alias": "go-mm27", "contextWindow": 204800, "maxTokens": 64000 },
          { "id": "minimax-m2.5", "alias": "go-mm25", "contextWindow": 204800, "maxTokens": 64000 }
        ],
        "unsupported": []
      }
    }
  }
}
```

#### 使用限制

| 周期 | 额度 |
|------|------|
| 每 5 小时 | $12 |
| 每周 | $30 |
| 每月 | $60 |

额度以美元计价，不同模型消耗不同（如 MiMo-V2.5 便宜，允许更多请求；GLM-5.1 较贵，允许较少请求）。

#### 当前可用模型（2026-06）

| 模型 | 协议 | 模型 ID |
|------|------|---------|
| DeepSeek V4 Pro | OpenAI | `deepseek-v4-pro` |
| DeepSeek V4 Flash | OpenAI | `deepseek-v4-flash` |
| MiMo-V2.5 | OpenAI | `mimo-v2.5` |
| MiMo-V2.5-Pro | OpenAI | `mimo-v2.5-pro` |
| GLM-5 | OpenAI | `glm-5` |
| GLM-5.1 | OpenAI | `glm-5.1` |
| Kimi K2.5 | OpenAI | `kimi-k2.5` |
| Kimi K2.6 | OpenAI | `kimi-k2.6` |
| Qwen3.7 Max | Anthropic | `qwen3.7-max` |
| Qwen3.6 Plus | Anthropic | `qwen3.6-plus` |
| Qwen3.5 Plus | Anthropic | `qwen3.5-plus` |
| MiniMax M2.7 | Anthropic | `minimax-m2.7` |
| MiniMax M2.5 | Anthropic | `minimax-m2.5` |

完整模型列表可通过 API 查询：

```bash
curl https://opencode.ai/zen/go/v1/models \
  -H "Authorization: Bearer $OPENCODE_GO_KEY"
```

#### 验证连通性

```bash
# OpenAI 协议模型
curl https://opencode.ai/zen/go/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_GO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic 协议模型
curl https://opencode.ai/zen/go/v1/messages \
  -H "x-api-key: $OPENCODE_GO_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.7-max","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

#### 路由原理

天枢的 `factory.ts` 根据 Provider 配置决定使用哪个 HTTP Client：

- `name === 'opencode-go'` → `OpenAIClient` → 请求 `/v1/chat/completions`
- `name === 'anthropic'` 或 `prefixCache === 'anthropic-cache-control'` → `AnthropicClient` → 请求 `/v1/messages`

这就是为什么 `opencode-go-anthropic` 的 `name` 必须是 `"anthropic"` —— 触发 Anthropic 协议路由。

---

### GLM（智谱）

**推荐场景**：需要中文理解强化的任务。

```bash
rivet config setup glm --key-env ZHIPU_API_KEY
```

注意：GLM 不支持 `stream_options` 参数，配置中会自动添加 `unsupported: ["stream_options"]`。

### MiMo（小米）

**推荐场景**：需要超长 Context（1M tokens）且追求 prefix cache 的任务。

```bash
rivet config setup mimo --key-env MIMO_API_KEY --default
```

小米 MiMo 支持类似 DeepSeek 的前缀缓存策略 `prefixCache: deepseek-native`。

### MiniMax

**推荐场景**：MiniMax 自有模型接入。

```bash
rivet config setup minimax --key-env MINIMAX_API_KEY
```

注意：MiniMax 需要过滤 `top_k`、`metadata`、`service_tier`、`cache_control` 参数，配置中已自动处理。

### Codex（GPT-5.5 via ChatGPT 订阅）

**推荐场景**：已订阅 ChatGPT Plus，想用 GPT-5.5 而不想额外付费。

**不需要 API Key**，使用 OAuth PKCE 认证：

```bash
rivet config setup codex --default
node dist/main.js  # 首次运行会弹出浏览器登录
```

认证流程：
1. 首次运行 `rivet config setup codex` 后，使用 `--provider codex` 启动时会自动打开浏览器
2. 完成 ChatGPT OAuth 登录
3. Token 自动保存到 `~/.rivet/auth/codex.json`
4. 每 55 分钟自动刷新 Token

---

## 配置优先级

天枢使用四层配置合并，**高优先级覆盖低优先级**：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1（最高） | 命令行 `--provider` / `--model` | 临时覆盖，不保存 |
| 2 | 项目配置 `.rivet-config.json` | 项目级别覆盖，在当前目录及父目录查找 |
| 3 | 用户配置 `~/.rivet/config.json` | 个人配置，通过 CLI 或手动编辑 |
| 4（最低） | 内置默认值 | `src/config/provider-presets.ts`，不可修改 |

例如：在项目目录创建 `.rivet-config.json` 可以让项目使用不同的默认模型，而不影响其他项目。

---

## 环境变量

每个 Provider 的 API Key 可以通过对应的环境变量提供：

| Provider | 环境变量 |
|----------|----------|
| deepseek | `DEEPSEEK_API_KEY` |
| opencode-go | `OPENCODE_GO_KEY` |
| opencode-go-anthropic | `OPENCODE_GO_KEY` |
| glm | `ZHIPU_API_KEY` |
| mimo | `MIMO_API_KEY` |
| minimax | `MINIMAX_API_KEY` |
| claude | `CLAUDE_API_KEY` |
| kimi | `KIMI_API_KEY` |

如果使用 `--key-env` 配置，系统会在运行时从环境变量读取 Key，而不是从配置文件读取。这样 Key 不会写入磁盘，更安全。

---

## 常见问题

### Q: 提示 "Provider not found"

确保 Provider 名称拼写正确，或使用 `rivet config providers` 查看可用 Provider 列表。如果是自己添加的 Provider，需要先通过 `setup` 或配置文件创建。

### Q: API Key 认证失败

1. 检查 Key 是否正确（环境变量是否设置、内联 Key 是否完整）
2. 检查 Base URL 是否正确（特别是使用代理或自定义端点时）
3. 使用 `rivet config show` 查看实际使用的配置
4. 测试 Key 是否有效：`curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" https://api.deepseek.com/v1/models`

### Q: Codex OAuth Token 过期

Token 每 55 分钟自动刷新。如果长时间未使用导致过期，重新运行即可：

```bash
node dist/main.js --provider codex
```

浏览器会弹出重新授权。

### Q: 如何切换 Provider？

在 TUI 中使用 `/model <name>` 命令切换模型：

```bash
/model v4-pro      # 切换到 DeepSeek V4 Pro
/model glm         # 切换到 GLM
/model codex        # 切换到 Codex
/model list        # 查看所有可用模型
```

或启动时指定：

```bash
node dist/main.js --provider mimo --model mimo-v2.5-pro
```

### Q: 如何完全重置配置？

删除用户配置文件，天枢将恢复使用内置默认值：

```bash
rm ~/.rivet/config.json
rivet config providers  # 应该只显示内置 Provider
```

---

## 配置示例

### 最小配置（仅 API Key）

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      }
    }
  }
}
```

### 多 Provider 配置

```json
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      },
      "minimax": {
        "apiKeyEnv": "MINIMAX_API_KEY"
      },
      "codex": {}
    }
  }
}
```

### 自定义模型配置

```json
{
  "provider": {
    "providers": {
      "deepseek": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "models": [
          {
            "id": "deepseek-v4-pro",
            "alias": "v4-pro",
            "contextWindow": 1000000,
            "maxTokens": 163000,
            "reasoningEffort": "max"
          },
          {
            "id": "deepseek-v4-flash",
            "alias": "v4-flash",
            "contextWindow": 1000000,
            "maxTokens": 163000,
            "reasoningEffort": "high"
          },
          {
            "id": "deepseek-coder",
            "alias": "coder",
            "contextWindow": 1000000,
            "maxTokens": 8192,
            "reasoningEffort": "medium"
          }
        ]
      }
    }
  }
}
```

---

## 调试

查看完整配置：

```bash
rivet config show | jq
```

查看 Provider 详情：

```bash
rivet config providers
```

测试 Provider 连接（用 curl）：

```bash
# DeepSeek
curl https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY"

# GLM
curl https://open.bigmodel.cn/api/coding/paas/v4/models \
  -H "Authorization: Bearer $ZHIPU_API_KEY"
```

---

## 参考链接

- 实现计划：[Provider 配置模式优化实现计划](./plans/2026-05-28-设计一下我们模型接入的provider的模式配置优化-比如初始化的时候-输入-r.md)
- Provider 预设源码：src/config/provider-presets.ts
- 配置管理器：src/config/manager.ts
- 配置向导：src/config/provider-wizard.ts