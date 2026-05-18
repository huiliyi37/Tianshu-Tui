# Rivet Claude Ecosystem Bridge 设计

> 日期：2026-05-19  
> 状态：Design Draft  
> 关联：`docs/superpowers/plans/2026-05-16-rivet-mcp-client-implementation.md`、`docs/superpowers/specs/2026-05-16-rivet-p2-model-mcp-repo-intel-design.md`、`docs/superpowers/plans/2026-05-19-tui-2.4-structural-maturity.md`  
> 目标：选择性吸收 Claude Code 生态中已经验证有效的 MCP、skills、workflow 与 advisor 能力，让 Rivet 更擅长查文档、借用经验、澄清需求、分解和验证任务，同时不把 Claude Code 插件运行时变成 Rivet 的依赖。

---

## 1. 背景

Rivet 已经具备接入 Claude 生态的关键地基：

- MCP client：`src/mcp/*` 已支持 stdio server 连接、tool discovery、MCP tool wrapper、approval risk、cockpit 展示。
- Skill 手动加载：`/skill` 已扫描 `.claude/skills/*/SKILL.md` 与 `~/.claude/skills/*/SKILL.md`，并通过 anchor 注入当前会话。
- 自定义 commands：`.rivet/commands/*.md` 已有 loader 与 slash command resolver。
- Subagent / evidence / verification：Rivet 已有原生 bounded workers、EvidenceTracker、failure-classifier、checkpoint 与 TUI cockpit。

外部可吸收生态：

| 来源 | 可复用资产 | 不直接复用的部分 |
|------|------------|------------------|
| Context7 | 最新库/API 文档检索；MCP tools `resolve-library-id` / `query-docs`；CLI `ctx7 library/docs` | 不把远程文档结果视为可信代码；不自动对所有任务联网 |
| oh-my-claudecode (OMC) | Team/Autopilot/Ralph/Ultrawork/Deep Interview 的 workflow 语义；`/ask` advisor 思路；skill learning 思路 | Claude Code plugin API、tmux team runtime、HUD/statusline、全局 installer |
| Everything Claude Code (ECC) | 大量 skills/rules/commands；security/harness-audit/quality-gate 思路；cross-harness packaging 经验 | full installer、全量 hooks runtime、全量 rules 注入、GUI dashboard |
| superpowers-zh | 20 个中文方法论 skills；尤其 `writing-plans`、`executing-plans`、`subagent-driven-development`、TDD、系统化调试、验证前完成；中文团队协作规范 | 不运行 `npx superpowers-zh` 自动安装器；不接其 hooks/bootstrap；不默认全量自动触发 |

核心判断：**Rivet 不应安装整套 OMC/ECC/superpowers-zh，而应建设一个 Claude Ecosystem Bridge：MCP preset + skill compatibility + workflow aliases + ecosystem doctor。**

---

## 2. 设计原则

1. **Rivet 原生优先**  
   外部生态只作为能力包和模式来源，不替代 Rivet 的 AgentLoop、subagent、approval、checkpoint、evidence、TUI cockpit。

2. **显式启用，默认安静**  
   Context7、ECC/OMC skills、advisor CLI 均需要用户显式配置或命令触发。第一版不做全自动联网查询。

3. **最小上下文污染**  
   不把 ECC/OMC rules 全量注入 prompt；skills 通过 budget、frontmatter、手动选择或后续匹配器进入 volatile/anchor 层。

4. **安全边界清晰**  
   MCP tools 仍走现有 approval risk 和 policy；外部 skills/rules 以 untrusted text 处理；导入器不得执行 install script；不得读取或打印 secret。

5. **不破坏 prefix cache**  
   不修改 `src/prompt/static.ts` 以接入生态能力。新增能力通过 config、slash command、volatile context 或 runtime hook 暴露。

6. **兼容而不耦合 Claude Code**  
   支持读取 `.claude/skills` / OMC / ECC 目录结构，但运行时不依赖 Claude Code plugin marketplace 或 Claude-specific hooks。

---

## 3. 当前能力与缺口

### 3.1 MCP

当前实现：

- `src/mcp/config.ts`：配置 schema 支持 stdio 与 SSE/URL 形态。
- `src/mcp/manager.ts`：stdio transport 已实现；`url` transport 当前抛出 `SSE transport not yet implemented`。
- `src/mcp/wrapper.ts`：MCP tools 包装成 Rivet `Tool`，名称为 `mcp__<serverId>__<toolName>`。
- `src/agent/approval-risk.ts` 与 `src/mcp/policy.ts`：已有 MCP risk 评估。
- `src/tui/cockpit/mcp-panel.tsx`：已有 MCP 状态展示。

缺口：

- 没有 Context7 preset。
- README 示例提到 `add-sse`，但 runtime 未实现 remote URL transport。
- 没有 `/mcp presets` 或 `rivet config mcp add-preset`。
- 没有为 Context7 这样的 read-only docs server 做更准确的 capability hint。

### 3.2 Skills

当前实现：

- `/skill list` 与 `/skill <name>` 扫描 `.claude/skills` 与 `~/.claude/skills`。
- 读取 `SKILL.md`，简单提取 `description`，加载时截断到 8000 字符并作为 anchor 注入。

缺口：

- 不扫描 `.rivet/skills`。
- 不支持 OMC `.omc/skills/*.md`、ECC `skills/`、superpowers-zh `skills/<name>/SKILL.md` 目录结构。
- 没有可测试的独立 skill loader 模块。
- 没有 search/import/trust/source/capacity 机制。
- 没有 frontmatter schema 和 trigger 匹配。

### 3.3 Commands / Workflows

当前实现：

- `.rivet/commands/*.md` 可以作为项目自定义 commands。
- `/interview` 存在入口，但主要作为让 agent 继续处理的命令，不是完整 workflow。

缺口：

- 没有 OMC/ECC workflow alias：`/deepsearch`、`/quality-gate`、`/autopilot`、`/ralph`、`/ultrawork`。
- 没有 command importer；不能从 ECC/OMC commands 中筛选可安全转译的 markdown prompt。
- 没有 ecosystem doctor 告知用户哪些外部能力可用。

---

## 4. 目标体验

### 4.1 Context7

```bash
rivet config mcp add-preset context7
rivet config mcp list
```

启动 Rivet 后可见：

```text
/mcp
context7: connected · 2 tools
  mcp__context7__resolve-library-id
  mcp__context7__query-docs
```

用户显式使用：

```text
用 context7 查 Ink 6 useInput 的最新 API，然后修复这个 TUI 输入问题
```

Agent 行为：

1. 调用 `mcp__context7__resolve-library-id`。
2. 调用 `mcp__context7__query-docs`。
3. 在实现前引用文档摘要。
4. 不把文档结果当成可信代码直接执行。

### 4.2 Claude/ECC/OMC Skills

```text
/skill list
/skill search security
/skill load typescript-reviewer
```

增强扫描路径：

- `.rivet/skills/*/SKILL.md`
- `.claude/skills/*/SKILL.md`
- `~/.claude/skills/*/SKILL.md`
- `.omc/skills/*.md`
- `superpowers-zh/skills/*/SKILL.md`
- 可配置外部目录，如本地 clone 的 ECC/OMC/superpowers-zh repo

导入：

```bash
rivet ecosystem import-skills ./everything-claude-code/skills --profile typescript --dry-run
rivet ecosystem import-skills ./oh-my-claudecode/skills --dry-run
rivet ecosystem import-skills ./superpowers-zh/skills --profile core --dry-run
```

导入目标：

```text
.rivet/skills/<skill-name>/SKILL.md
```

### 4.3 Workflow Aliases

第一批只做无外部 runtime 依赖的 prompt/workflow alias：

| 命令 | Rivet 原生语义 |
|------|----------------|
| `/interview <topic>` | Socratic requirement clarification；产出目标、非目标、验收、风险、问题 |
| `/plan <feature>` 或 `/write-plan <feature>` | 使用 superpowers-zh `writing-plans` 方法论生成 `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` 实施计划；强调文件结构、TDD、小步骤、禁止占位符、自检与执行交接 |
| `/deepsearch <query>` | repo_map + grep/read_file 策略提示，鼓励先搜后改 |
| `/quality-gate` | 汇总 git diff、typecheck/test/evidence 状态，给出是否可提交 |

第二批再考虑：

| 命令 | Rivet 原生语义 |
|------|----------------|
| `/execute-plan <path>` | 使用 superpowers `executing-plans` 语义按计划分批执行、验证、checkpoint |
| `/autopilot <task>` | plan → implement → verify → fix loop |
| `/ralph <task>` | persistent verification closure，直到通过或 blocked |
| `/ultrawork <task>` | 优先 delegate_batch / bounded workers 并行探索 |
| `/ask <provider> <prompt>` | 调外部 provider/CLI 或 Rivet worker advisor，写 artifact |

### 4.4 Ecosystem Doctor

```text
/ecosystem
/ecosystem doctor
```

展示：

```text
Claude Ecosystem
- Context7 MCP: configured / connected / missing
- MCP remote URL transport: supported / not supported
- .rivet skills: 8
- .claude project skills: 3
- ~/.claude skills: 12
- ECC repo: not configured
- OMC CLI: found / missing
- codex CLI: found / missing
- gemini CLI: found / missing
```

---

## 5. Architecture

```text
                  ┌────────────────────────────┐
                  │  Config / CLI / Slash       │
                  │  rivet config mcp preset    │
                  │  /skill /ecosystem          │
                  └─────────────┬──────────────┘
                                │
       ┌────────────────────────┼────────────────────────┐
       │                        │                        │
┌──────▼────────┐       ┌───────▼────────┐       ┌───────▼─────────┐
│ MCP Bridge    │       │ Skill Bridge   │       │ Workflow Bridge │
│ presets       │       │ loader/import  │       │ alias prompts   │
│ stdio/url     │       │ trust/budget   │       │ quality gate    │
└──────┬────────┘       └───────┬────────┘       └───────┬─────────┘
       │                        │                        │
┌──────▼────────┐       ┌───────▼────────┐       ┌───────▼─────────┐
│ McpManager    │       │ Agent anchors  │       │ AgentLoop       │
│ ToolRegistry  │       │ volatile ctx   │       │ evidence/hooks  │
└───────────────┘       └────────────────┘       └─────────────────┘
```

### 5.1 MCP Bridge

新增模块：

```text
src/mcp/presets.ts
```

职责：

- 定义内置 MCP presets。
- 提供 `getMcpPreset(id)`、`listMcpPresets()`。
- 不读取环境变量值，只声明 env key。

Context7 preset 建议形态：

```ts
export const MCP_PRESETS = {
  context7: {
    id: 'context7',
    label: 'Context7 documentation',
    transport: 'stdio',
    config: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
    optionalEnv: ['CONTEXT7_API_KEY'],
    expectedTools: ['resolve-library-id', 'query-docs'],
    capability: 'read',
  },
}
```

如果实际 Context7 stdio 命令不同，以官方 `ctx7 setup` 或 `@upstash/context7-mcp` README 为准。实现时不得硬编码 API key。

### 5.2 Remote MCP Transport

当前 config schema 支持 `url`，但 manager 未实现。补齐时遵守：

- 优先使用 MCP SDK 官方 Streamable HTTP/SSE transport。
- `headers` 从 config 读取，但 TUI/log 输出只显示 header keys，不显示 values。
- 连接失败进入 `error` 或 `degraded` state，不阻塞 Rivet 启动。
- 远程 MCP 默认视为 network capability；write/execute 仍需 approval。

### 5.3 Skill Bridge

新增模块：

```text
src/skills/types.ts
src/skills/loader.ts
src/skills/importer.ts
src/skills/matcher.ts   // 后续阶段
```

核心类型：

```ts
export interface SkillSource {
  kind: 'rivet-project' | 'claude-project' | 'claude-global' | 'omc' | 'ecc' | 'superpowers-zh' | 'external'
  root: string
  trust: 'project' | 'user' | 'external'
}

export interface SkillManifest {
  name: string
  description: string
  triggers: string[]
  source: SkillSource['kind']
  path: string
  size: number
  trusted: boolean
}
```

加载规则：

- 支持目录型：`<root>/<name>/SKILL.md`，覆盖 Claude Code 与 superpowers-zh。
- 支持文件型：`.omc/skills/<name>.md`、ECC `skills/**/*.md`（导入时归一化）。
- 对 superpowers-zh 提供 core profile：`brainstorming`、`writing-plans`、`executing-plans`、`test-driven-development`、`systematic-debugging`、`verification-before-completion`、`subagent-driven-development`。
- 最大读取大小默认 64KB；注入大小默认 8KB，后续由 skill budget 控制。
- frontmatter 解析失败不报错，只降级为 plain markdown skill。

### 5.4 Workflow Bridge

不执行 OMC/ECC runtime，只把常用 workflow 变成 Rivet 原生 prompt template 或 slash command resolver。

新增模块建议：

```text
src/workflows/ecosystem-workflows.ts
```

第一批 workflow 返回 prompt input，让 AgentLoop 继续处理：

- `/interview <topic>`：生成澄清问题与验收标准。
- `/plan <feature>` / `/write-plan <feature>`：内置 superpowers-zh `writing-plans` 的计划质量门槛，要求输出可执行计划文件、文件结构、TDD 步骤、精确命令、禁止占位符与自检清单。
- `/deepsearch <query>`：强约束先 `repo_map/grep/read_file`，不直接 edit。
- `/quality-gate`：要求读取 evidence/git/test 状态并给出 release/commit readiness。

### 5.5 Ecosystem Doctor

新增模块建议：

```text
src/ecosystem/doctor.ts
```

收集：

- MCP config 中是否有 context7。
- McpManager state 中 context7 是否 connected。
- skill sources 数量。
- CLI 可用性：`ctx7`、`omc`、`ecc`、`codex`、`gemini`。检查 CLI 时只用 non-destructive `--version` 或 PATH lookup，失败不报错。
- 是否存在 duplicate skill names。

---

## 6. 安全设计

### 6.1 MCP

- Context7 read-only tools 不需要 approval，但仍要标注 `[MCP: context7 · read-only]`。
- 未知 MCP server 的 write/execute/network 工具继续走 `evaluateMcpPolicy()`。
- 远程 MCP headers 不进入日志、TUI、tool result。
- MCP 输出视为外部内容：不应自动执行其建议命令。

### 6.2 Skills / Rules

- 外部导入只复制 markdown，不执行脚本。
- 导入前必须支持 `--dry-run`。
- 重名 skill 默认 skip，除非显式 `--overwrite`。
- skill frontmatter 只解析白名单字段：`name`、`description`、`triggers`、`source`。
- skill 内容注入前加来源标记：`[Active Skill: name · source=ecc · untrusted]`。
- superpowers-zh 的 `writing-plans` 可作为内置 workflow 模板复述其方法论，但导入原始 skill 时仍按外部 markdown 处理。

### 6.3 Workflow Aliases

- `/autopilot`、`/ralph`、`/ultrawork` 不得绕过 approval。
- `/quality-gate` 不直接 commit。
- `/ask` 外部 CLI 后续实现时必须写 artifact，并明确 provider/source。

---

## 7. 非目标

| 不做 | 原因 |
|------|------|
| 直接运行 OMC/ECC full installer | 可能污染 `~/.claude`、重复 hooks、难以回滚 |
| 依赖 Claude Code plugin marketplace | Rivet 不是 Claude Code runtime |
| 全量复制 ECC rules 到 prompt | 上下文污染和 cache 风险过高 |
| 用 OMC tmux team 替代 Rivet subagent | 与 Rivet bounded worker 架构重复 |
| 自动联网查询所有库相关任务 | 噪声、成本、安全与隐私风险 |
| 修改 `src/prompt/static.ts` | 会破坏 prefix cache |

---

## 8. 验收标准

- Context7 能作为 MCP preset 加入 config，且不会暴露 API key。
- `.rivet/skills`、`.claude/skills` 至少可被统一 loader 扫描。
- `/skill list/search/load` 使用统一 loader，行为可测试。
- `/ecosystem doctor` 能展示 Context7/MCP/skills/CLI 可用性，不执行破坏性命令。
- 第一批 workflow aliases 不依赖外部 OMC/ECC/superpowers-zh runtime。
- `/plan` 或 `/write-plan` 能以 superpowers-zh `writing-plans` 标准生成高质量实施计划提示。
- TypeScript strict 通过，相关 node:test 通过。

---

## 9. 迁移路径

1. 保留现有 `/skill` 行为，内部替换为 `src/skills/loader.ts`。
2. 保留现有 `rivet config mcp add-stdio/add-sse`，新增 `add-preset/list-presets`。
3. Context7 先支持 stdio preset；remote URL transport 单独阶段补齐。
4. ECC/OMC skills 先通过 import/dry-run 进入 `.rivet/skills`，不读取其 hooks/install scripts。
5. 自动 skill matching 和 workflow automation 后续在真实使用反馈后再启用。
