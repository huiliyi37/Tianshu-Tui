# 天枢 × OpenClaw 架构集成设计

> 日期：2026-07-09
> 状态：设计初稿
> 路径：路径 C —— 不计成本的全新合体

## 1. 背景与问题

天枢（rivet）是一个深度编码 agent 引擎，强项是 AgentLoop 循环、PromptEngine prompt 组装、星域人格系统、50+ 工具链、桌面端 Tauri 外壳。但它只有终端和桌面两个交互入口，缺少多渠道消息能力。

OpenClaw 是一个多渠道 AI 网关，覆盖 24+ 消息平台（WhatsApp/Telegram/Slack/Discord/WeChat/QQ/Feishu/iMessage/Matrix/Teams...），有成熟的 skill 插件体系和配置系统。但它的 AI 调用是简单的 completion 模式（simple-completion-runtime），缺少天枢的深度 agent 循环能力。

**核心矛盾**：两个系统各自补全了对方最缺的能力，但运行模型和架构假设完全不同。集成不是简单的 API 桥接，而是需要重建一个统一的 agent runtime。

## 2. 调研发现

### 2.1 OpenClaw 核心架构

**入口链路**：
- `openclaw.mjs`（Node launcher，compile-cache + version gating ≥22.19）
- → `src/entry.ts`（argv 解析、容器检测、profile env）
- → `src/cli/run-main.ts`（Commander CLI 分发）

**渠道适配层**：
- 接口定义：`src/plugins/manifest.ts:1891` 的 `PluginPackageChannel` 类型
- 合约是隐式的（metadata-driven），不是显式 TypeScript interface
- 关键字段：`id`, `label`, `configuredState`（specifier + exportName）, `persistedAuthState`
- 渠道注册：`dist/channel-catalog.json` + `extensions/` 目录的 bundled plugins
- 每个渠道是一个独立包（如 `extensions/slack/` 有 301 个文件），通过 package.json 的 `openclaw.channel` 声明

**AI/LLM 调用层**：
- `src/llm/stream.ts` → re-export `@openclaw/ai/internal/runtime`（complete, stream, completeSimple）
- 内置 provider 注册：`@openclaw/ai/providers`，import 时 side-effect 注册
- 编排层：`src/agents/simple-completion-runtime.ts`（auth → model selection → streaming）
- 没有 agent loop、没有工具调用循环、没有多轮收敛检测

**配置系统**：
- `src/config/io.ts:2787` → `loadConfig()` → `OpenClawConfig`
- ~40 个顶层 section：auth, models, agents, channels, plugins, tools, secrets, session, cli, browser...
- 进程级 singleton pinning：`loadPinnedRuntimeConfig()`

**Skill 系统**：
- 定义：`SKILL.md` 文件 + YAML frontmatter（name, description, optional `metadata.openclaw`）
- 加载：6 源优先级链（extra < bundled < managed < personal < project < workspace）
- 插件 skill：`resolvePluginSkillDirs()` 通过 symlink 发现，path-containment 安全校验
- Prompt 注入：`<available_skills>` XML 块，18K 字符预算 + compact fallback

### 2.2 天枢核心架构

**AgentLoop**：`src/agent/loop.ts:137`
- `run(userInput, callbacks)` → re-entry guard → `_runInner()` → `TurnOrchestrator.execute()`
- 状态：SessionContext, AbortController, turn heartbeat, evidence tracker, compact circuit breaker, trajectory recorder, repair pipeline, failure journal, routing metrics

**TurnOrchestrator**：`src/agent/turn-orchestrator.ts:350`
- for-loop over turns：initializeRun → abort check → checkpoint → context pressure → LLM stream → tool processing
- 每轮后：convergence detection, repair passes, post-turn decisions
- 终止条件：maxTurns, user abort, convergence, voluntary finish

**PromptEngine**：`src/prompt/engine.ts`
- 三层组装：system prompt + frozen base + dynamic appendix
- 精确保留 prefix cache（DeepSeek V4 优化）

**星域系统**：
- 10 个内置人格：`src/agent/star-domain.ts`
- 扩展注册表：`src/agent/star-domain-registry.ts`
- 22+ worker profiles：`src/agent/profile-registry.ts`

**工具系统**：
- 50+ 工具：`src/tools/registry.ts` + `src/tools/default-registry.ts`
- 外部名称别名映射

**HTTP 服务**：
- `src/server/serve.ts` — HTTP + SSE sidecar
- `RuntimeSessionManager` — 多会话生命周期管理
- 路由：`/health`, `/prompt`, `/sessions/*`, `/stream`, `/interventions/*`, `/schedule`

### 2.3 关键差异对比

| 维度 | 天枢 | OpenClaw | 集成冲击 |
|------|------|----------|----------|
| AI 调用 | 多轮 agent loop + 工具调用 + 收敛检测 | 单轮 completion（stream/simple） | 核心替换点 |
| Prompt | 三层组装 + prefix cache 保护 | 简单 prompt 拼接 | 需要保留天枢的 engine |
| 工具 | 50+ 内置工具（file ops, ast_grep, bash...） | skill 插件系统（spotify/weather/trello...） | 两套共存 |
| 人格 | 10 星域 + 22 worker profiles | 无 | 天枢独有，直接带入 |
| 渠道 | 0（仅 TUI + 桌面端） | 24+ 消息平台 | OpenClaw 独有，直接带入 |
| 配置 | config.json（~10 section） | OpenClawConfig（~40 section） | 需要统一 |
| 包管理 | npm（单体） | pnpm monorepo | 需要迁移到 monorepo |

## 3. 方案对比

### 方案 A：AgentLoop 作为 OpenClaw 的一个 completion provider

把天枢的 AgentLoop 封装成 `@openclaw/ai` 的一个自定义 provider，替换 `simple-completion-runtime`。

- **优势**：改动最小，OpenClaw 渠道层零修改
- **代价**：AgentLoop 的工具系统无法穿透到渠道层；skill 和工具两套体系无法统一
- **结论**：❌ 淘汰 —— 工具调用是 agent 的手和脚，截断它等于把天枢变成一个 fancy chatbot

### 方案 B：天枢 sidecar 模式 —— OpenClaw 代理转发

OpenClaw 收消息 → 转发到天枢 sidecar 的 HTTP API（`/prompt`）→ 天枢处理 → 返回结果 → OpenClaw 发回渠道。

- **优势**：零侵入，两个系统完全独立运行
- **代价**：延迟翻倍（两次 HTTP 跳转）；OpenClaw 的 skill 系统与天枢工具系统无法互通；每条消息都是无状态的，丢失了天枢的 session 持久化优势
- **结论**：❌ 淘汰 —— 等同于路径 A，只是更慢

### 方案 C：天枢内核植入 OpenClaw monorepo —— 统一 agent runtime（存活方案）

在 OpenClaw 的 monorepo 中创建 `packages/core`，将天枢的 AgentLoop + PromptEngine + 星域 + 工具系统作为核心 runtime。OpenClaw 的渠道层直接调用这个 runtime，而不是 simple-completion-runtime。

- **优势**：真正的统一体验；天枢的 agent 能力直接穿透到所有 24+ 渠道；工具和 skill 可以统一注册
- **代价**：需要重构天枢核心为独立 package；需要重写 OpenClaw 的 completion 编排层；prompt cache 不变量需要在多渠道并发下验证
- **结论**：✅ 存活 —— 这是唯一能做到 1+1>2 的路径

### 方案 D：OpenClaw 渠道层提取为独立包，嵌入天枢（反向吸收）

把 OpenClaw 的 `extensions/` 渠道适配器提取出来，移植到天枢的 `src/channels/` 下。

- **优势**：天枢保持为单体，改动集中
- **代价**：需要移植整个 plugin manifest 系统 + config 系统 + skill 加载器；OpenClaw 的渠道生态（24+ 适配器）依赖复杂的 metadata + symlink + catalog 机制
- **结论**：❌ 淘汰 —— 逆向移植 24 个渠道的工作量远大于把天枢核心打包成一个 package

## 4. 最终方案：路径 C 详细设计

### 4.1 目标架构

```
openclaw/                          (pnpm monorepo)
├── packages/
│   ├── ai/                        (已有 — @openclaw/ai，LLM provider 注册 + completion)
│   ├── tianshu-core/              (新建 — 天枢 agent runtime)
│   │   ├── src/
│   │   │   ├── agent/             ← 从 rivet/src/agent/ 移植
│   │   │   ├── prompt/            ← 从 rivet/src/prompt/ 移植
│   │   │   ├── tools/             ← 从 rivet/src/tools/ 移植（50+ 工具）
│   │   │   ├── config/            ← 从 rivet/src/config/ 移植
│   │   │   ├── hooks/             ← 从 rivet/src/hooks/ 移植
│   │   │   ├── cache/             ← 从 rivet/src/cache/ 移植
│   │   │   ├── repo/              ← 从 rivet/src/repo/ 移植（native-resolver 等）
│   │   │   ├── api/               ← 从 rivet/src/api/ 移植（provider 抽象）
│   │   │   └── index.ts           ← 导出 AgentLoop, PromptEngine, ToolRegistry, StarDomain
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── fs-safe/                   (已有)
│   ├── proxyline/                 (已有)
│   └── ...
├── extensions/                    (已有 — 24+ 渠道适配器，不动)
├── skills/                        (已有 — 技能插件，不动)
├── src/                           (已有 — OpenClaw 核心，改动集中在此)
│   ├── agents/
│   │   ├── simple-completion-runtime.ts  (已有 — 简单 completion，保留给轻量场景)
│   │   └── tianshu-agent-runtime.ts      (新建 — 天枢 agent 编排层)
│   ├── llm/
│   │   └── stream.ts              (修改 — 注入 tianshu-core 作为可选 runtime)
│   └── ...
└── ui/                            (已有 — Web UI，不动)
```

### 4.2 核心集成点

**注入点 1：completion 路由**

```
渠道消息进入
  → OpenClaw 消息解析
  → agent 配置检查：
      若 agent.type === "tianshu" → tianshu-agent-runtime.ts
      若 agent.type === "simple"  → simple-completion-runtime.ts（原有路径）
  → 返回结果
  → OpenClaw 渠道发送
```

当前行为 → 改后行为：
- 今天：所有消息走 `simple-completion-runtime`（单轮 completion）
- 改后：配置为 `tianshu` 类型的 agent 走 AgentLoop（多轮 + 工具 + 收敛）
- 安全性：fallback 保留原有路径，零破坏

**注入点 2：工具注册统一**

```
tianshu-core 的 ToolRegistry
  + OpenClaw 的 skill 系统
  = 统一工具平面
```

天枢的 50+ 内置工具（file_ops, ast_grep, bash, code_edit, delegate...）和 OpenClaw 的 skill（spotify, weather, trello...）注册到同一个 ToolRegistry。skill loader 适配 ToolRegistry 的 `register()` 接口。

**注入点 3：配置合并**

```yaml
# openclaw.config.yaml 新增 section
agents:
  default:
    type: tianshu                    # 启用天枢 runtime
    model: deepseek-v4               # 模型选择
    starDomain: auto                 # 星域人格（auto = 按任务自动匹配）
    maxTurns: 50
    tools:                           # 工具白名单
      - file-ops
      - ast-grep
      - bash
      - code-edit
      - delegate
    skills:                          # OpenClaw skill
      - weather
      - spotify-player
    promptEngine:
      cachePrefix: true              # DeepSeek V4 prefix cache 保护
      frozenBase: true
```

### 4.3 需要解决的关键问题

**问题 1：prompt cache 不变量在多渠道并发下是否成立？**

天枢的 PromptEngine 假设每会话独立 PromptEngine（frozen base + dynamic appendix），这在单用户桌面端成立。多渠道并发时，每个渠道会话需要独立的 PromptEngine 实例。

- 解法：`RuntimeSessionManager` 已经支持多会话隔离（每会话独立 AgentLoop + PromptEngine + ArtifactStore）。只需要确保 `tianshu-agent-runtime` 为每个 inbound message 创建独立 session，而不是复用共享实例。
- 风险：内存占用线性增长。需要设置 session 上限 + LRU 淘汰。

**问题 2：工具系统的权限模型**

天枢的工具（bash, file_ops）在桌面端有完整的沙箱和权限控制。在 OpenClaw 的多渠道场景下，来自 WhatsApp 的消息触发 bash 执行是危险的。

- 解法：`tianshu-agent-runtime` 根据渠道来源动态过滤工具白名单。桌面端保留全部工具，WhatsApp/Telegram 等消息渠道只暴露安全子集（无 bash、无 file_ops、无 code_edit）。
- 参考：天枢已有 `toolWhitelist` 在 `ProfileRegistry` 中，每个 worker profile 定义可访问的工具列表。

**问题 3：星域人格在非编码场景的适配**

天枢的 10 个星域是为编码任务设计的（天枢-调度、天权-规划、瑶光-验证...）。在 OpenClaw 的消息渠道场景下（"帮我查天气"、"播放音乐"），星域人格需要扩展。

- 解法：在 `star-domain-registry.ts` 中注册通用人格（如「客服星域」「生活助手星域」），编码任务自动匹配编码星域，生活任务匹配通用星域。
- 天枢已有 `auto` 匹配机制（`star-domain.ts` 中按任务类型选择），扩展成本低。

**问题 4：构建体系统一**

天枢用 tsup（esbuild），OpenClaw 用 tsdown（rolldown/esbuild）。需要统一。

- 解法：`tianshu-core` 作为 package 使用 tsdown 构建，与 OpenClaw monorepo 保持一致。tsup 的 `banner`（createRequire shim）需要在 tsdown 中等效实现。

## 5. 边界标定

**会碰的文件（天枢侧）**：
- `src/agent/` — 移植到 `packages/tianshu-core/src/agent/`
- `src/prompt/` — 移植到 `packages/tianshu-core/src/prompt/`
- `src/tools/` — 移植到 `packages/tianshu-core/src/tools/`
- `src/config/` — 移植到 `packages/tianshu-core/src/config/`
- `src/hooks/` — 移植到 `packages/tianshu-core/src/hooks/`
- `src/cache/` — 移植到 `packages/tianshu-core/src/cache/`
- `src/repo/` — 移植到 `packages/tianshu-core/src/repo/`
- `src/api/` — 移植到 `packages/tianshu-core/src/api/`

**会碰的文件（OpenClaw 侧）**：
- `src/agents/tianshu-agent-runtime.ts` — 新建
- `src/llm/stream.ts` — 修改（注入 tianshu runtime 路由）
- `src/config/types.openclaw.ts` — 修改（新增 agents.type = "tianshu" 配置类型）
- `pnpm-workspace.yaml` — 修改（确认 packages/tianshu-core 在 workspace 内）

**不改什么**：
- OpenClaw 的 24+ 渠道扩展（`extensions/`）—— 零修改
- OpenClaw 的 skill 系统（`skills/`）—— 零修改，通过适配器接入 ToolRegistry
- OpenClaw 的 Web UI（`ui/`）—— 零修改
- 天枢的 TUI / 桌面端 —— 保留为独立运行形态，与 OpenClaw 共用 tianshu-core

## 6. 数据流

```
用户消息 (WhatsApp/Telegram/Discord/...)
  │
  ▼
OpenClaw 渠道适配器 (extensions/whatsapp, extensions/telegram, ...)
  │ 统一消息格式: InboundMessage { channel, userId, text, attachments }
  ▼
OpenClaw 路由层 (src/agents/)
  │ agent.type === "tianshu" ?
  ▼
tianshu-agent-runtime.ts
  │ 创建/复用 session → AgentLoop.run()
  ▼
AgentLoop (packages/tianshu-core)
  │ TurnOrchestrator.execute()
  │   ├── PromptEngine 组装 prompt (frozen base + dynamic appendix)
  │   ├── LLM stream (@openclaw/ai provider)
  │   ├── 工具调用 (50+ 内置 tools + OpenClaw skills)
  │   ├── 收敛检测 + repair passes
  │   └── 后续轮次...
  ▼
AgentLoop 完成 → 最终回复文本
  │
  ▼
OpenClaw 渠道适配器
  │ 格式化为渠道原生格式
  ▼
用户收到回复 (WhatsApp/Telegram/Discord/...)
```

## 7. 先例引用

- 天枢桌面端已经实现了 "Rust 外壳 + Node sidecar" 模式：外壳负责 I/O（窗口/输入），sidecar 负责 agent 逻辑。OpenClaw 集成是同一个模式的升级版 —— 外壳从 Tauri 变成 OpenClaw 网关。
- 天枢的 `src/server/serve.ts` 已经有 HTTP API 层，`RuntimeSessionManager` 已经支持多会话隔离。这不是从零开始。
- 天枢的 `ProfileRegistry` 工具白名单机制已经在桌面端使用（不同 worker profile 访问不同工具子集）。渠道级工具过滤是同一个机制的扩展。

## 8. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| prompt cache 在多渠道并发下失效 | 中 | 性能下降 | 每会话独立 PromptEngine，prefix 不跨会话共享 |
| 工具权限泄漏（消息渠道触发 bash） | 低 | 安全事故 | 渠道级工具白名单，fail-closed 默认策略 |
| tianshu-core 移植时依赖链断裂 | 高 | 构建失败 | 逐步移植 + 单元测试覆盖，先移植纯函数模块 |
| OpenClaw 的 pnpm monorepo 与 tianshu-core 的 ESM/CJS 混合冲突 | 中 | 运行时错误 | tianshu-core 强制 ESM，tsdown 构建，不保留 CJS |
| 星域人格在非编码场景表现不佳 | 低 | 用户体验 | 通用星域兜底，auto 匹配降级到默认人格 |

## 9. 下一步

这份是设计初稿。后续：
1. **深度验证**：读 OpenClaw 的一个完整渠道扩展（如 `extensions/discord/`）确认 `PluginPackageChannel` 的实际加载流程
2. **原型验证**：在 OpenClaw monorepo 中创建 `packages/tianshu-core` 骨架，移植 AgentLoop 的最小闭环，验证端到端消息流
3. **调用 `writing-plans`** 生成可执行的迁移计划（分波执行，每波有独立验证门）

需要我继续出执行计划，还是先确认设计方向？
