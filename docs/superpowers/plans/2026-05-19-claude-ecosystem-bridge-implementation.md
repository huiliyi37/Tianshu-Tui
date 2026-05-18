# Claude Ecosystem Bridge 实施计划

> 日期：2026-05-19  
> 设计文档：`docs/superpowers/specs/2026-05-19-claude-ecosystem-bridge-design.md`  
> 前置：MCP client 基础能力已存在；TUI 2.4 structural maturity 已将 AgentLoop 大部分重构完成  
> 目标：把 Context7、Claude/ECC/OMC/superpowers-zh skills、轻量 workflow aliases 和 ecosystem doctor 以 Rivet 原生方式接入。  
> 重点：把用户高频使用的 superpowers-zh `writing-plans` 固化为 Rivet 原生 `/plan` / `/write-plan` 工作流。  
> 铁律：不运行外部 full installer；不执行导入目录中的脚本；不修改 `src/prompt/static.ts`；不暴露 secrets；所有能力默认显式启用。

---

## 总体切分

| Phase | 目标 | 风险 | 建议提交 |
|-------|------|------|----------|
| 0 | Baseline 与现有未提交状态确认 | 低 | 无或 docs-only |
| 1 | Context7 MCP preset | 低 | `feat(mcp): add context7 preset` |
| 2 | MCP remote URL transport | 中 | `feat(mcp): support remote streamable transport` |
| 3 | 统一 Skill Loader + `/skill search` | 中 | `feat(skills): add Claude ecosystem skill loader` |
| 4 | Skill importer for ECC/OMC/superpowers-zh | 中 | `feat(skills): import external skill packs` |
| 5 | Workflow aliases + superpowers writing-plans | 中 | `feat(workflows): add ecosystem workflow aliases` |
| 6 | Ecosystem doctor | 低 | `feat(ecosystem): add doctor command` |
| 7 | Docs + verification | 低 | `docs(ecosystem): document Claude bridge setup` |

推荐执行顺序：**Phase 1 → Phase 3 → Phase 6 → Phase 5 → Phase 4 → Phase 2**。

理由：

- Context7 stdio preset 和 skill loader 立即提升能力，且最少改动 runtime。
- remote URL transport 涉及 SDK 细节和网络状态，单独做。
- importer 比 loader 更容易造成文件写入风险，应在 loader 稳定后做。
- workflow aliases 不依赖外部生态，可中途插入；其中 `/plan` 应优先落地，因为 `writing-plans` 是高频核心技能。

---

## Phase 0：Baseline 与约束检查

### 目标

确保当前工作区状态、测试基线和所有权边界明确。

### 文件

- 只读：`git status`
- 只读：`docs/superpowers/specs/2026-05-19-claude-ecosystem-bridge-design.md`
- 只读：`src/mcp/*`
- 只读：`src/tui/slash-commands.ts`
- 只读：`src/config/manager.ts`

### 步骤

- [ ] 检查 `git status`，确认只有预期文档或 runtime 状态文件脏。
- [ ] 如 `.rivet/playbook.jsonl` 有 runtime 变化，不纳入功能提交，除非用户明确要求。
- [ ] 阅读设计文档。
- [ ] 阅读 `src/mcp/config.ts`、`src/mcp/manager.ts`、`src/mcp/wrapper.ts`、`src/mcp/policy.ts`。
- [ ] 阅读 `/skill` 当前实现：`src/tui/slash-commands.ts`。
- [ ] 不修改 `src/prompt/static.ts`。

### 验证

无需运行测试。

---

## Phase 1：Context7 MCP Preset

### 目标

让用户可以通过一条 config 命令配置 Context7 MCP，而不手写 command/args。

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/mcp/presets.ts` | 内置 MCP presets，第一批只含 Context7 |
| `src/mcp/__tests__/presets.test.ts` | preset 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/config/manager.ts` | `rivet config mcp list-presets`、`add-preset <id>` |
| `README.md` | Context7 setup 示例，可放到后续 docs phase |

### 设计

`src/mcp/presets.ts`：

```ts
import type { McpServerConfig } from './config.js'

export interface McpPreset {
  id: string
  label: string
  description: string
  config: McpServerConfig
  optionalEnv?: string[]
  expectedTools?: string[]
  capability: 'read' | 'network' | 'write' | 'execute'
}

const PRESETS: Record<string, McpPreset> = {
  context7: {
    id: 'context7',
    label: 'Context7 documentation',
    description: 'Up-to-date library/API docs via Context7 MCP.',
    config: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
    optionalEnv: ['CONTEXT7_API_KEY'],
    expectedTools: ['resolve-library-id', 'query-docs'],
    capability: 'read',
  },
}

export function listMcpPresets(): McpPreset[] {
  return Object.values(PRESETS)
}

export function getMcpPreset(id: string): McpPreset | null {
  return PRESETS[id] ?? null
}
```

> 注意：实现前用 Context7 官方 README 确认 stdio 命令。如果 npm 包只支持 remote URL，则 Phase 1 改为输出 guidance，并把真正可用接入放到 Phase 2。

### CLI 行为

```bash
rivet config mcp list-presets
rivet config mcp add-preset context7
rivet config mcp add-preset context7 --id docs
```

输出要求：

- 不打印 `CONTEXT7_API_KEY` 值。
- 如 env 未设置，只提示：`Optional env: CONTEXT7_API_KEY (not checked)` 或 `set for higher rate limits`。
- 如果同名 server 已存在，报错并提示 `remove` 或 `--id`。

### 测试

`src/mcp/__tests__/presets.test.ts`：

- [ ] `listMcpPresets()` 包含 `context7`。
- [ ] `getMcpPreset('context7')` 返回 stdio config。
- [ ] `getMcpPreset('missing')` 返回 null。
- [ ] preset config 可被 `mcpServerConfigSchema.parse()` 接受。

`src/config/__tests__/manager-mcp-preset.test.ts` 或现有 config test：

- [ ] CLI `mcp add-preset context7` 写入 config。
- [ ] 已存在同名 server 时失败。
- [ ] `--id docs` 写入 `servers.docs`。

### 验证命令

```bash
npx tsc --noEmit
npx tsx --test src/mcp/__tests__/presets.test.ts src/config/__tests__/*.test.ts
```

---

## Phase 2：MCP Remote URL Transport

### 目标

让 `url` 型 MCP server 真正可连接，以支持 Context7 官方 remote endpoint 或其他远程 MCP server。

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/mcp/manager.ts` | 实现 URL/headers transport |
| `src/mcp/__tests__/manager.test.ts` | remote transport 测试 |
| `README.md` | remote MCP 示例 |

### 实现要点

- 使用 `@modelcontextprotocol/sdk` 官方 HTTP/SSE/Streamable transport。具体 import 以当前 SDK 版本为准。
- 保留 stdio 行为不变。
- `headers` 只传给 transport，不进入 tool result / TUI。
- 连接失败只更新 server state 为 `error`，不得阻塞其他 server 初始化。
- 超时仍使用 `withTimeout()`。

### 伪代码

```ts
if (cfg.url) {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
  })
  await withTimeout(client.connect(transport), `MCP connect ${serverId}`, this.timeoutMs)
  return { client, transport, serverId }
}
```

如果 SDK 实际使用 `SSEClientTransport`，用对应构造器并加测试隔离。

### 测试

- [ ] `_connectServer()` 对 url config 创建 remote transport 并调用 `client.connect()`。
- [ ] headers 不出现在 error string 中。
- [ ] remote connect timeout 进入 `error` state。
- [ ] stdio tests 继续通过。

### 验证命令

```bash
npx tsc --noEmit
npx tsx --test src/mcp/__tests__/manager.test.ts src/mcp/__tests__/wrapper.test.ts src/agent/__tests__/approval-risk.test.ts
```

---

## Phase 3：统一 Skill Loader + `/skill search`

### 目标

把 `/skill` 从 TUI slash command 内联文件扫描重构为可测试的 loader，并扩展到 `.rivet/skills`。

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/skills/types.ts` | SkillSource、SkillManifest、LoadedSkill 类型 |
| `src/skills/loader.ts` | 扫描、frontmatter 解析、读取 skill |
| `src/skills/__tests__/loader.test.ts` | loader 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/slash-commands.ts` | `/skill` 使用 loader；增加 `/skill search <query>` |

### Loader 设计

默认扫描顺序：

1. `.rivet/skills/*/SKILL.md` — `rivet-project`
2. `.claude/skills/*/SKILL.md` — `claude-project`
3. `~/.claude/skills/*/SKILL.md` — `claude-global`
4. 可选外部 root：superpowers-zh / OMC / ECC checkout，只读扫描，不执行安装器

后续 importer 可写入 `.rivet/skills`。

superpowers-zh 目录型 skills 与 Claude Code 兼容，例如：`skills/writing-plans/SKILL.md`。Loader 第一版无需特殊处理，只要支持 `<root>/<name>/SKILL.md` 即可。

类型：

```ts
export interface SkillManifest {
  name: string
  description: string
  triggers: string[]
  source: 'rivet-project' | 'claude-project' | 'claude-global' | 'superpowers-zh' | 'omc' | 'ecc' | 'external'
  path: string
  size: number
  trusted: boolean
}

export interface LoadedSkill extends SkillManifest {
  content: string
}
```

函数：

```ts
export function discoverSkills(cwd: string, opts?: { homeDir?: string }): SkillManifest[]
export function searchSkills(skills: SkillManifest[], query: string): SkillManifest[]
export function loadSkill(skill: SkillManifest, opts?: { maxChars?: number }): LoadedSkill
```

frontmatter：

- 只解析 `name`、`description`、`triggers`。
- 无 frontmatter 时，name 来自目录名，description 为 `(no description)`。
- `triggers` 支持 YAML list 或逗号分隔字符串；第一版可以只支持简单 list/string。

### `/skill` 行为

```text
/skill list
/skill search security
/skill load typescript-reviewer
/skill typescript-reviewer   # alias of load
```

输出中展示：

- source icon：`.rivet` / project Claude / global Claude
- size
- description
- duplicate name warning

加载时 anchor：

```text
[Active Skill: typescript-reviewer · source=rivet-project · trusted=true]
<content truncated to 8000 chars>
```

### 测试

`src/skills/__tests__/loader.test.ts`：

- [ ] 发现 `.rivet/skills/foo/SKILL.md`。
- [ ] 发现 `.claude/skills/bar/SKILL.md`。
- [ ] 发现 fake home `~/.claude/skills/baz/SKILL.md`。
- [ ] 发现外部 superpowers-zh root 下的 `skills/writing-plans/SKILL.md`，source=`superpowers-zh`。
- [ ] 忽略非目录、缺少 `SKILL.md`、非法名称。
- [ ] 解析 description/triggers。
- [ ] search 命中 name/description/triggers。
- [ ] loadSkill 截断内容。

`src/tui/__tests__/slash-commands.test.ts` 或新增 test：

- [ ] `/skill list` 无 skills 时提示扫描路径。
- [ ] `/skill search security` 返回匹配项。
- [ ] `/skill load foo` 调用 `agent.addAnchor()`。

### 验证命令

```bash
npx tsc --noEmit
npx tsx --test src/skills/__tests__/loader.test.ts src/tui/__tests__/slash-commands.test.ts
```

---

## Phase 4：Skill Importer for ECC/OMC/superpowers-zh

### 目标

安全地把外部 ECC/OMC/superpowers-zh skill pack 导入 `.rivet/skills`，不运行外部 installer。

superpowers-zh 是优先支持对象，因为它的 `writing-plans`、`executing-plans`、`subagent-driven-development`、`verification-before-completion` 与 Rivet 当前工作流高度匹配。

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/skills/importer.ts` | dry-run/import/copy/normalize |
| `src/skills/__tests__/importer.test.ts` | importer 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/config/manager.ts` 或新增 CLI 分支 | `rivet ecosystem import-skills` |
| `src/main.tsx` | 若已有 CLI routing，需要接入 `ecosystem` 子命令 |

### 命令

```bash
rivet ecosystem import-skills <path> --dry-run
rivet ecosystem import-skills <path> --profile typescript --dry-run
rivet ecosystem import-skills <path> --profile superpowers-core --dry-run
rivet ecosystem import-skills <path> --overwrite
```

支持输入结构：

- superpowers-zh：`skills/<skill-name>/SKILL.md`，优先支持 `writing-plans`。
- OMC：`skills/<skill-name>/SKILL.md`
- Claude-style：`<root>/<skill-name>/SKILL.md`
- ECC：`skills/**/*.md` 或 `skills/<category>/<name>.md`

内置 profile：

| Profile | 包含 |
|---------|------|
| `superpowers-core` | `brainstorming`、`writing-plans`、`executing-plans`、`test-driven-development`、`systematic-debugging`、`verification-before-completion`、`subagent-driven-development` |
| `superpowers-planning` | `brainstorming`、`writing-plans`、`executing-plans` |
| `typescript` | ECC/OMC TypeScript 相关 skills（后续可扩展匹配规则） |

输出写入：

```text
.rivet/skills/<normalized-name>/SKILL.md
```

### 安全规则

- 默认 dry-run examples 必须清楚展示会复制哪些文件。
- 不执行 shell script、package script、hook file。
- 单个 skill 最大 128KB，超过 skip 并提示。
- normalized name 只允许 `[a-z0-9._-]`，其他转 `-`。
- 重名默认 skip；`--overwrite` 才覆盖。
- 路径必须在输入 root 和项目 cwd 下，防 path traversal。

### ImportResult

```ts
export interface SkillImportPlanItem {
  sourcePath: string
  targetPath: string
  name: string
  action: 'copy' | 'skip' | 'overwrite'
  reason?: string
}

export interface SkillImportPlan {
  root: string
  targetRoot: string
  items: SkillImportPlanItem[]
}
```

### 测试

- [ ] Claude-style directory import plan。
- [ ] superpowers-zh `skills/writing-plans/SKILL.md` import plan。
- [ ] `--profile superpowers-core` 只选择 core skills，且包含 `writing-plans`。
- [ ] ECC nested markdown import plan。
- [ ] dry-run 不写文件。
- [ ] overwrite=false 时重名 skip。
- [ ] overwrite=true 时覆盖。
- [ ] path traversal 被拒绝。
- [ ] oversized skill 被 skip。

### 验证命令

```bash
npx tsc --noEmit
npx tsx --test src/skills/__tests__/importer.test.ts src/skills/__tests__/loader.test.ts
```

---

## Phase 5：Workflow Aliases

### 目标

把 OMC/ECC/superpowers-zh 中最有价值、且不依赖外部 runtime 的 workflows 翻译为 Rivet 原生 slash aliases。

本 Phase 的核心是把 superpowers-zh `writing-plans` 变成 Rivet 原生 `/plan` / `/write-plan`。这是用户在 Claude 上高频使用的能力，优先级高于 `/autopilot`、`/ralph`。

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/workflows/ecosystem-workflows.ts` | workflow prompt builders |
| `src/workflows/__tests__/ecosystem-workflows.test.ts` | prompt builder 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/slash-commands.ts` | 解析 `/interview`、`/plan`、`/write-plan`、`/deepsearch`、`/quality-gate` 等 |

### 第一批 workflows

#### `/interview <topic>`

返回给 AgentLoop 的用户输入：

```text
Run a Socratic requirements interview for: <topic>
Do not edit files yet. Produce:
1. Goal
2. Non-goals
3. User flows
4. Acceptance criteria
5. Hidden assumptions
6. Risks
7. Clarifying questions
Stop after questions unless the user explicitly asks to implement.
```

#### `/plan <feature>` / `/write-plan <feature>`

基于 superpowers-zh `writing-plans`，返回给 AgentLoop 的用户输入：

```text
我正在使用 writing-plans 技能创建实现计划。

Create a comprehensive implementation plan for: <feature>

Requirements:
- Do not write implementation code yet.
- Read relevant docs/specs/code first.
- Save the plan to docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md unless the user specified another path.
- Assume the implementing engineer has near-zero context about this codebase.
- Start with this header:
  # [功能名称] 实现计划
  > **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
  **目标：** ...
  **架构：** ...
  **技术栈：** ...
- Include a file structure section before tasks.
- Break work into 2-5 minute steps.
- Use TDD: failing test → run failing test → minimal implementation → run passing test → commit.
- Every task must list exact files to create/modify/test.
- Every command must include expected result.
- No placeholders: no TODO / 待定 / 后续实现 / 类似任务 N / add proper error handling.
- Run a self-check for spec coverage, placeholder scan, and type/signature consistency.
- End with execution handoff options: subagent-driven vs inline executing-plans.
```

可选增强：如果 `writing-plans` skill 已通过 `/skill load writing-plans` 激活，则 builder 只生成任务主题和保存路径，让已加载 skill 提供完整细节；否则使用上面的内置精简模板。

#### `/deepsearch <query>`

```text
Perform codebase deep search for: <query>
Rules:
- Start with repo_map or inspect_project if structure is unknown.
- Use grep/glob/read_file before proposing edits.
- Summarize evidence with file_path:line_number references.
- Do not edit files in this turn unless explicitly asked.
```

#### `/quality-gate`

```text
Run a release-quality gate for the current working tree.
Check git diff/status, relevant tests, evidence, and risks.
Do not commit. Return: Pass / Blocked / Needs verification with reasons.
```

### 第二批 workflows（后续）

- `/autopilot <task>`：plan → implement → verify → fix loop。
- `/ralph <task>`：persistent verification closure。
- `/ultrawork <task>`：优先 delegate_batch 并行探索。
- `/ask <provider> <prompt>`：外部 advisor artifact。

第二批需要 AgentLoop / mode / auto-reasoning 更深接入，不在第一批实现。

### 测试

- [ ] builder 对空 topic 返回 usage/error。
- [ ] `/plan foo` prompt 包含 `writing-plans` 声明、计划保存路径、文件结构、TDD、小步骤、禁止占位符、自检、执行交接。
- [ ] `/plan foo` prompt 包含禁止写实现代码约束。
- [ ] prompt 包含禁止编辑约束。
- [ ] slash command 对 `/interview foo` 返回 false 让 agent 处理增强 prompt，或通过 resolver 替换 input。
- [ ] slash command 对 `/plan foo` 返回 false 让 agent 创建计划文档，而不是直接开始实现。
- [ ] `/quality-gate` 不直接执行 commit/test，除非 agent 后续选择工具并经过正常 approval。

### 验证命令

```bash
npx tsc --noEmit
npx tsx --test src/workflows/__tests__/ecosystem-workflows.test.ts src/tui/__tests__/slash-commands.test.ts
```

---

## Phase 6：Ecosystem Doctor

### 目标

给用户一个可见面板/命令，知道 Claude 生态桥接能力哪些可用、哪些缺失。

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/ecosystem/doctor.ts` | 收集 ecosystem 状态 |
| `src/ecosystem/__tests__/doctor.test.ts` | doctor 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/slash-commands.ts` | `/ecosystem`、`/ecosystem doctor` |
| 可选：`src/config/manager.ts` | `rivet ecosystem doctor` |

### Doctor 输出

```ts
export interface EcosystemDoctorReport {
  context7: {
    configured: boolean
    serverId: string | null
    transport: 'stdio' | 'url' | null
  }
  skills: {
    total: number
    bySource: Record<string, number>
    duplicates: string[]
  }
  cli: Array<{
    name: 'ctx7' | 'omc' | 'ecc' | 'codex' | 'gemini'
    available: boolean
    version?: string
  }>
  warnings: string[]
}
```

### CLI 检查规则

- 不通过 shell 拼接命令；如需检查，用 `spawn`/`execFile` 或 PATH lookup。
- 只运行 `--version` 或 `version`，设置短 timeout。
- 失败不报错，只显示 missing。
- 不打印 env values。

### Slash 输出示例

```text
Claude Ecosystem Bridge
Context7: configured (stdio, server: context7)
Skills: 12 total (.rivet 4, .claude project 2, global 6)
Duplicate skills: typescript-reviewer
CLI: ctx7 ✓, omc ✗, ecc ✗, codex ✓, gemini ✗
Warnings:
- MCP URL transport is not enabled; remote Context7 endpoint requires Phase 2.
```

### 测试

- [ ] 无 config 时 context7.configured=false。
- [ ] config 有 context7 stdio 时识别。
- [ ] skills bySource 统计正确。
- [ ] duplicate skill names 识别。
- [ ] CLI checker 可注入 fake runner，避免真实依赖。

### 验证命令

```bash
npx tsc --noEmit
npx tsx --test src/ecosystem/__tests__/doctor.test.ts src/skills/__tests__/loader.test.ts
```

---

## Phase 7：Docs + Verification

### 目标

补齐用户文档，并完成最小验证闭环。

### 修改文件

| 文件 | 变更 |
|------|------|
| `README.md` | Claude Ecosystem Bridge 小节 |
| `docs/superpowers/status/` 或 handoff | 记录已完成阶段与限制 |

### README 内容

至少包含：

- Context7 preset：

```bash
rivet config mcp add-preset context7
rivet config mcp list
```

- 手动 remote MCP：

```bash
rivet config mcp add-sse context7 https://mcp.context7.com/mcp
```

并说明 remote URL transport 需要相应版本支持。

- Skill 路径：

```text
.rivet/skills/*/SKILL.md
.claude/skills/*/SKILL.md
~/.claude/skills/*/SKILL.md
```

- 外部 skill pack 导入：

```bash
rivet ecosystem import-skills ./everything-claude-code/skills --dry-run
```

- 安全说明：不运行外部 installers；导入只复制 markdown。

### 全量验证

最小：

```bash
npx tsc --noEmit
npx tsx --test src/mcp/__tests__/*.test.ts src/skills/__tests__/*.test.ts src/ecosystem/__tests__/*.test.ts src/tui/__tests__/slash-commands.test.ts
```

最终：

```bash
npm test
npm run build
```

如果 `compact.test.ts` 出现已知 flaky，记录并单独重跑确认。

---

## 建议首个实现切片

如果只做一个小 PR，有两个可选切片：

### 切片 A：Context7 preset（最低风险）

1. `src/mcp/presets.ts`
2. `rivet config mcp list-presets/add-preset`
3. `src/mcp/__tests__/presets.test.ts`
4. README 一小段 Context7 preset 用法

不包含 remote transport、不包含 importer。这样能最快让 Context7 进入 Rivet 用户路径，且风险最低。

### 切片 B：writing-plans workflow（最高体感收益）

1. `src/workflows/ecosystem-workflows.ts`
2. `buildWritingPlanPrompt(feature, opts)`
3. `/plan <feature>` 与 `/write-plan <feature>` slash alias
4. `src/workflows/__tests__/ecosystem-workflows.test.ts`
5. `src/tui/__tests__/slash-commands.test.ts` 覆盖不直接实现、生成计划文档约束

不包含 skill importer。直接把用户最常用的 superpowers-zh `writing-plans` 经验做成 Rivet 内建工作流。

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Context7 stdio 命令不稳定 | preset 不可用 | 实现前确认官方包；preset test 只测 schema，不连网 |
| remote MCP SDK API 变动 | 编译失败 | Phase 2 单独提交；隔离 transport factory |
| ECC/OMC skills 太大 | 上下文膨胀 | loader/importer 限制 size 和 maxChars |
| 外部 skills prompt injection | 行为污染 | 来源标记、trusted=false、显式加载、后续 sanitizer |
| workflow alias 绕过 approval | 安全风险 | aliases 只生成 prompt，不直接执行工具 |
| CLI doctor 扫描卡住 | TUI 卡顿 | timeout + best-effort + 可注入 runner |

---

## 完成定义

- [ ] Context7 可通过 preset 写入 config。
- [ ] `.rivet/skills` 与 `.claude/skills` 由统一 loader 扫描。
- [ ] `/skill search` 可用且有测试。
- [ ] `/ecosystem doctor` 可展示 MCP/skills/CLI 状态。
- [ ] 第一批 workflow aliases 至少 `/interview`、`/plan`、`/write-plan`、`/deepsearch`、`/quality-gate` 有 prompt builder 测试。
- [ ] `/plan` / `/write-plan` 符合 superpowers-zh `writing-plans` 的核心质量门槛。
- [ ] 不修改 `src/prompt/static.ts`。
- [ ] 不执行 OMC/ECC install scripts。
- [ ] typecheck 与相关 tests 通过。
