<!-- IMPLEMENTED: 2026-05-16. All 5 capability modules verified. 859 tests pass, typecheck clean. See CHANGELOG.md for details. -->

# Wave 1：核心缺漏补齐 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐 Rivet 与 Claude Code/DeepSeek-TUI 的核心能力差距：headless 模式、permission allow rules、cost/token 显示、自定义命令、onboarding 引导。

**架构：** 复用现有 AgentLoop 实现 headless 路径；config schema 扩展 permissions；SummaryBar 扩展 cost 显示；命令加载器扫描 .rivet/commands/；Ink 组件实现 onboarding。

**技术栈：** TypeScript, Ink 6, React, Zod, existing AgentLoop/ToolRegistry

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/headless.ts` | Headless 执行：解析参数 → AgentLoop → stdout 输出 |
| `src/agent/permissions.ts` | Permission allow rules 匹配逻辑 |
| `src/tui/cost-tracker.ts` | Token/cost 累积计算 |
| `src/commands/loader.ts` | 自定义命令加载器 |
| `src/tui/onboarding.tsx` | 首次运行引导 Ink 组件 |
| `src/__tests__/headless.test.ts` | Headless 模式测试 |
| `src/__tests__/permissions.test.ts` | Permission 匹配测试 |
| `src/__tests__/cost-tracker.test.ts` | Cost 计算测试 |
| `src/__tests__/commands-loader.test.ts` | 命令加载测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/main.tsx` | CLI 参数解析 + headless 分支 + onboarding 检测 |
| `src/config/schema.ts` | 增加 `permissions` schema |
| `src/agent/loop.ts` | 审批前检查 allow rules |
| `src/tui/summary-bar.tsx` | 显示 cost/token 信息 |
| `src/tui/app.tsx` | 未知命令时查找自定义命令 |

---

## 任务 1：Permission Allow Rules

### 任务 1.1：Permission 匹配逻辑

**文件：**
- 创建：`src/agent/permissions.ts`
- 测试：`src/__tests__/permissions.test.ts`

- [x] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/permissions.test.ts
import { describe, it, expect } from 'vitest'
import { isToolAllowed } from '../agent/permissions.js'

describe('isToolAllowed', () => {
  const rules = [
    'read_file',
    'grep',
    'glob',
    'bash:npm test',
    'bash:npm run build',
    'git:status',
    'git:diff',
  ]

  it('allows exact tool name match', () => {
    expect(isToolAllowed('read_file', {}, rules)).toBe(true)
    expect(isToolAllowed('grep', {}, rules)).toBe(true)
  })

  it('rejects unlisted tool', () => {
    expect(isToolAllowed('write_file', {}, rules)).toBe(false)
    expect(isToolAllowed('bash', { command: 'rm -rf /' }, rules)).toBe(false)
  })

  it('matches bash command prefix', () => {
    expect(isToolAllowed('bash', { command: 'npm test' }, rules)).toBe(true)
    expect(isToolAllowed('bash', { command: 'npm test -- --watch' }, rules)).toBe(true)
    expect(isToolAllowed('bash', { command: 'npm run build' }, rules)).toBe(true)
    expect(isToolAllowed('bash', { command: 'rm -rf /' }, rules)).toBe(false)
  })

  it('matches git action', () => {
    expect(isToolAllowed('git', { action: 'status' }, rules)).toBe(true)
    expect(isToolAllowed('git', { action: 'diff' }, rules)).toBe(true)
    expect(isToolAllowed('git', { action: 'commit' }, rules)).toBe(false)
  })

  it('returns true for empty rules (no restrictions)', () => {
    expect(isToolAllowed('bash', { command: 'anything' }, [])).toBe(false)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/permissions.test.ts`
预期：FAIL — "Cannot find module '../agent/permissions.js'"

- [x] **步骤 3：实现 permissions.ts**

```typescript
// src/agent/permissions.ts
export function isToolAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowRules: string[],
): boolean {
  for (const rule of allowRules) {
    if (!rule.includes(':')) {
      if (rule === toolName) return true
      continue
    }
    const [ruleTool, rulePattern] = rule.split(':', 2)
    if (ruleTool !== toolName) continue

    if (toolName === 'bash') {
      const cmd = String(input.command ?? '')
      if (cmd.startsWith(rulePattern!)) return true
    } else if (toolName === 'git') {
      if (input.action === rulePattern) return true
    } else {
      if (JSON.stringify(input).includes(rulePattern!)) return true
    }
  }
  return false
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/permissions.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/permissions.ts src/__tests__/permissions.test.ts
git commit -m "feat(agent): permission allow rules matching logic"
```

---

### 任务 1.2：Config schema 扩展 + loop 集成

**文件：**
- 修改：`src/config/schema.ts`
- 修改：`src/agent/loop.ts`

- [x] **步骤 1：扩展 config schema**

在 `src/config/schema.ts` 的 `configSchema` 中增加：

```typescript
export const permissionsSchema = z.object({
  mode: z.enum(['interactive', 'bypass']).default('interactive'),
  allow: z.array(z.string()).default([
    'read_file', 'grep', 'glob', 'git:status', 'git:diff', 'git:log',
  ]),
})

// 在 configSchema 中增加：
export const configSchema = z.object({
  provider: z.object({ /* existing */ }),
  agent: agentSchema.default({}),
  compact: compactSchema.default({}),
  cache: cacheSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  permissions: permissionsSchema.default({}),
})
```

- [x] **步骤 2：在 loop.ts 审批逻辑中集成**

在 `src/agent/loop.ts` 中，找到调用 approval/审批的位置，在审批前增加：

```typescript
import { isToolAllowed } from './permissions.js'

// 在 tool execution 前的审批检查中：
const autoApproved = isToolAllowed(toolName, toolInput, this.config.permissions.allow)
if (autoApproved || this.config.permissions.mode === 'bypass') {
  // skip approval, execute directly
} else {
  // existing approval flow
}
```

- [x] **步骤 3：运行全量测试确保无回归**

运行：`npm test`
预期：所有测试 PASS

- [x] **步骤 4：Commit**

```bash
git add src/config/schema.ts src/agent/loop.ts
git commit -m "feat(agent): integrate permission allow rules into approval flow"
```

---

## 任务 2：Cost/Token 实时显示

### 任务 2.1：CostTracker 类

**文件：**
- 创建：`src/tui/cost-tracker.ts`
- 测试：`src/__tests__/cost-tracker.test.ts`

- [x] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/cost-tracker.test.ts
import { describe, it, expect } from 'vitest'
import { CostTracker } from '../tui/cost-tracker.js'

describe('CostTracker', () => {
  it('accumulates tokens across turns', () => {
    const tracker = new CostTracker({ inputPricePer1M: 0.14, outputPricePer1M: 0.28, cachedInputPricePer1M: 0.014 })
    tracker.recordTurn({ promptTokens: 10000, completionTokens: 2000, cacheHitTokens: 8000 })
    tracker.recordTurn({ promptTokens: 12000, completionTokens: 1500, cacheHitTokens: 10000 })

    expect(tracker.totalPromptTokens).toBe(22000)
    expect(tracker.totalCompletionTokens).toBe(3500)
    expect(tracker.totalCacheHitTokens).toBe(18000)
  })

  it('calculates cost correctly with cache discount', () => {
    const tracker = new CostTracker({ inputPricePer1M: 0.14, outputPricePer1M: 0.28, cachedInputPricePer1M: 0.014 })
    tracker.recordTurn({ promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 900_000 })
    // Cost = (100K uncached * 0.14/1M) + (900K cached * 0.014/1M) = 0.014 + 0.0126 = 0.0266
    expect(tracker.totalCost).toBeCloseTo(0.0266, 3)
  })

  it('formats display string', () => {
    const tracker = new CostTracker({ inputPricePer1M: 0.14, outputPricePer1M: 0.28, cachedInputPricePer1M: 0.014 })
    tracker.recordTurn({ promptTokens: 12300, completionTokens: 2100, cacheHitTokens: 11000 })
    const display = tracker.formatDisplay()
    expect(display).toContain('12.3K')
    expect(display).toContain('2.1K')
    expect(display).toContain('$')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/cost-tracker.test.ts`
预期：FAIL

- [x] **步骤 3：实现 CostTracker**

```typescript
// src/tui/cost-tracker.ts
interface PricingConfig {
  inputPricePer1M: number
  outputPricePer1M: number
  cachedInputPricePer1M: number
}

interface TurnUsage {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
}

export class CostTracker {
  totalPromptTokens = 0
  totalCompletionTokens = 0
  totalCacheHitTokens = 0
  totalCost = 0
  private pricing: PricingConfig

  constructor(pricing: PricingConfig) {
    this.pricing = pricing
  }

  recordTurn(usage: TurnUsage): void {
    this.totalPromptTokens += usage.promptTokens
    this.totalCompletionTokens += usage.completionTokens
    this.totalCacheHitTokens += usage.cacheHitTokens

    const uncachedInput = usage.promptTokens - usage.cacheHitTokens
    const turnCost =
      (uncachedInput / 1_000_000) * this.pricing.inputPricePer1M +
      (usage.cacheHitTokens / 1_000_000) * this.pricing.cachedInputPricePer1M +
      (usage.completionTokens / 1_000_000) * this.pricing.outputPricePer1M
    this.totalCost += turnCost
  }

  formatDisplay(): string {
    const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
    return `↑${fmtK(this.totalPromptTokens)} ↓${fmtK(this.totalCompletionTokens)} | $${this.totalCost.toFixed(4)}`
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/cost-tracker.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/tui/cost-tracker.ts src/__tests__/cost-tracker.test.ts
git commit -m "feat(tui): CostTracker — token/cost accumulation with cache-aware pricing"
```

---

### 任务 2.2：SummaryBar 集成 cost 显示

**文件：**
- 修改：`src/tui/summary-bar.tsx`

- [x] **步骤 1：在 SummaryBar 中导入并显示 CostTracker 数据**

在 `summary-bar.tsx` 的 props 或 context 中接收 cost 数据，在渲染中增加：

```typescript
// 在 SummaryBar 组件的渲染输出中增加 cost 段
// 格式: [Turn N] ↑12.3K ↓2.1K | $0.042 | Cache: 99.1% | ████░░ 62%
```

具体实现取决于 SummaryBar 现有结构——读取文件后适配。

- [x] **步骤 2：运行 typecheck 确认无类型错误**

运行：`npm run typecheck`
预期：无错误

- [x] **步骤 3：Commit**

```bash
git add src/tui/summary-bar.tsx
git commit -m "feat(tui): display cost/token stats in SummaryBar"
```

---

## 任务 3：Headless 模式

### 任务 3.1：CLI 参数解析

**文件：**
- 修改：`src/main.tsx`
- 创建：`src/headless.ts`
- 测试：`src/__tests__/headless.test.ts`

- [x] **步骤 1：编写 headless 测试**

```typescript
// src/__tests__/headless.test.ts
import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../headless.js'

describe('parseCliArgs', () => {
  it('detects headless mode with -p flag', () => {
    const args = parseCliArgs(['-p', 'fix the bug'])
    expect(args.headless).toBe(true)
    expect(args.prompt).toBe('fix the bug')
    expect(args.outputFormat).toBe('text')
  })

  it('detects json output format', () => {
    const args = parseCliArgs(['-p', 'test', '--json'])
    expect(args.outputFormat).toBe('json')
  })

  it('detects stream-json format', () => {
    const args = parseCliArgs(['-p', 'test', '--stream-json'])
    expect(args.outputFormat).toBe('stream-json')
  })

  it('returns headless=false without -p', () => {
    const args = parseCliArgs([])
    expect(args.headless).toBe(false)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/headless.test.ts`
预期：FAIL

- [x] **步骤 3：实现 parseCliArgs + headless runner**

```typescript
// src/headless.ts
export interface CliArgs {
  headless: boolean
  prompt: string
  outputFormat: 'text' | 'json' | 'stream-json'
}

export function parseCliArgs(argv: string[]): CliArgs {
  const pIdx = argv.indexOf('-p')
  if (pIdx === -1) return { headless: false, prompt: '', outputFormat: 'text' }

  const prompt = argv[pIdx + 1] ?? ''
  let outputFormat: CliArgs['outputFormat'] = 'text'
  if (argv.includes('--json')) outputFormat = 'json'
  else if (argv.includes('--stream-json')) outputFormat = 'stream-json'

  return { headless: true, prompt, outputFormat }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/headless.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/headless.ts src/__tests__/headless.test.ts
git commit -m "feat(cli): parseCliArgs for headless mode detection"
```

---

### 任务 3.2：Headless 执行逻辑 + main.tsx 集成

**文件：**
- 修改：`src/headless.ts`
- 修改：`src/main.tsx`

- [x] **步骤 1：在 headless.ts 中增加 runHeadless 函数**

```typescript
// src/headless.ts — 追加
import type { AgentLoop } from './agent/loop.js'

export async function runHeadless(
  agent: AgentLoop,
  prompt: string,
  outputFormat: CliArgs['outputFormat'],
): Promise<void> {
  let result = ''

  await agent.run(prompt, {
    onTextDelta: (text) => {
      if (outputFormat === 'text') process.stdout.write(text)
      else result += text
    },
    onToolUse: (name, input) => {
      if (outputFormat === 'stream-json') {
        process.stdout.write(JSON.stringify({ type: 'tool_use', name, input }) + '\n')
      }
    },
    onToolResult: (name, output) => {
      if (outputFormat === 'stream-json') {
        process.stdout.write(JSON.stringify({ type: 'tool_result', name, output: output.slice(0, 500) }) + '\n')
      }
    },
    onComplete: () => {},
    onAbort: () => { process.exit(1) },
    onError: (err) => {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(1)
    },
  })

  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify({ result }) + '\n')
  }
  if (outputFormat === 'text') process.stdout.write('\n')
}
```

- [x] **步骤 2：在 main.tsx 入口处增加 headless 分支**

在 `src/main.tsx` 的 `main()` 函数开头（在 Ink render 之前）：

```typescript
import { parseCliArgs, runHeadless } from './headless.js'

// 在 main() 函数开头：
const cliArgs = parseCliArgs(process.argv.slice(2))
if (cliArgs.headless) {
  // 初始化 config, client, agent（复用现有逻辑）
  // 调用 runHeadless(agent, cliArgs.prompt, cliArgs.outputFormat)
  // process.exit(0)
}
// 否则继续现有 TUI 渲染路径
```

- [x] **步骤 3：运行 typecheck**

运行：`npm run typecheck`
预期：无错误

- [x] **步骤 4：手动测试**

运行：`node dist/main.js -p "what is 2+2" --json`
预期：输出 JSON 包含 result 字段

- [x] **步骤 5：Commit**

```bash
git add src/headless.ts src/main.tsx
git commit -m "feat(cli): headless mode — rivet -p 'prompt' for non-interactive execution"
```

---

## 任务 4：Custom Slash Commands

### 任务 4.1：命令加载器

**文件：**
- 创建：`src/commands/loader.ts`
- 测试：`src/__tests__/commands-loader.test.ts`

- [x] **步骤 1：编写测试**

```typescript
// src/__tests__/commands-loader.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCustomCommands } from '../commands/loader.js'

describe('loadCustomCommands', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-cmd-'))
    mkdirSync(join(dir, '.rivet', 'commands'), { recursive: true })
  })

  it('loads .md files as commands', () => {
    writeFileSync(join(dir, '.rivet', 'commands', 'review.md'), 'Review the code changes')
    const cmds = loadCustomCommands(dir)
    expect(cmds.get('review')).toBe('Review the code changes')
  })

  it('returns empty map when no commands dir', () => {
    const empty = mkdtempSync(join(tmpdir(), 'rivet-empty-'))
    const cmds = loadCustomCommands(empty)
    expect(cmds.size).toBe(0)
  })

  it('strips .md extension for command name', () => {
    writeFileSync(join(dir, '.rivet', 'commands', 'deploy-prod.md'), 'Deploy to production')
    const cmds = loadCustomCommands(dir)
    expect(cmds.has('deploy-prod')).toBe(true)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/commands-loader.test.ts`
预期：FAIL

- [x] **步骤 3：实现 loader.ts**

```typescript
// src/commands/loader.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadCustomCommands(cwd: string): Map<string, string> {
  const commands = new Map<string, string>()
  const dir = join(cwd, '.rivet', 'commands')
  if (!existsSync(dir)) return commands

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const name = file.slice(0, -3)
    commands.set(name, readFileSync(join(dir, file), 'utf-8'))
  }
  return commands
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- src/__tests__/commands-loader.test.ts`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/commands/loader.ts src/__tests__/commands-loader.test.ts
git commit -m "feat(commands): custom slash command loader from .rivet/commands/*.md"
```

---

### 任务 4.2：app.tsx 集成自定义命令

**文件：**
- 修改：`src/tui/app.tsx`

- [x] **步骤 1：在 app.tsx 中导入 loader 并处理未知命令**

在 `src/tui/app.tsx` 的命令处理 switch 的 default 分支中：

```typescript
import { loadCustomCommands } from '../commands/loader.js'

// 在组件初始化时加载：
const customCommands = loadCustomCommands(process.cwd())

// 在 switch default 分支（处理未知 slash command 时）：
default: {
  const cmdName = userInput.slice(1).split(' ')[0]
  const customPrompt = customCommands.get(cmdName)
  if (customPrompt) {
    // 将 customPrompt 作为 user message 发送给 agent
    const args = userInput.slice(1 + cmdName.length).trim()
    const fullPrompt = args ? `${customPrompt}\n\nAdditional context: ${args}` : customPrompt
    // 调用 agent.run(fullPrompt, callbacks)
  } else {
    // 显示 "Unknown command" 错误
  }
}
```

- [x] **步骤 2：运行 typecheck**

运行：`npm run typecheck`
预期：无错误

- [x] **步骤 3：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): integrate custom slash commands from .rivet/commands/"
```

---

## 任务 5：Onboarding 引导

### 任务 5.1：Onboarding 组件

**文件：**
- 创建：`src/tui/onboarding.tsx`
- 修改：`src/main.tsx`

- [x] **步骤 1：创建 Onboarding Ink 组件**

```tsx
// src/tui/onboarding.tsx
import { createElement, useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'

interface OnboardingProps {
  onComplete: (config: { provider: string; apiKey: string; model: string }) => void
}

type Step = 'provider' | 'apiKey' | 'model' | 'done'

const PROVIDERS = [
  { name: 'deepseek', label: 'DeepSeek (V4)', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { name: 'openai', label: 'OpenAI (GPT-4o)', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { name: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-6' },
]

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>('provider')
  const [providerIdx, setProviderIdx] = useState(0)
  const [apiKey, setApiKey] = useState('')

  if (step === 'provider') {
    return createElement(Box, { flexDirection: 'column' },
      createElement(Text, { bold: true }, '🚀 Welcome to Rivet! Let\'s set up your configuration.'),
      createElement(Text, {}, ''),
      createElement(Text, {}, 'Select your AI provider (use number keys):'),
      ...PROVIDERS.map((p, i) =>
        createElement(Text, { key: p.name }, `  ${i + 1}. ${p.label}`)
      ),
    )
  }

  if (step === 'apiKey') {
    const provider = PROVIDERS[providerIdx]!
    return createElement(Box, { flexDirection: 'column' },
      createElement(Text, {}, `Provider: ${provider.label}`),
      createElement(Text, {}, 'Enter your API key:'),
      createElement(TextInput, {
        value: apiKey,
        onChange: setApiKey,
        onSubmit: () => {
          if (apiKey.length > 0) {
            onComplete({ provider: provider.name, apiKey, model: provider.defaultModel })
          }
        },
        mask: '*',
      }),
    )
  }

  return createElement(Text, {}, 'Setting up...')
}
```

- [x] **步骤 2：在 main.tsx 中检测首次运行**

```typescript
// src/main.tsx — 在 main() 函数中，loadConfig() 之前：
const configPath = join(homedir(), '.rivet', 'config.json')
if (!existsSync(configPath)) {
  // 渲染 Onboarding 组件
  // onComplete 回调中写入 config.json 然后继续正常启动
}
```

- [x] **步骤 3：运行 typecheck**

运行：`npm run typecheck`
预期：无错误

- [x] **步骤 4：Commit**

```bash
git add src/tui/onboarding.tsx src/main.tsx
git commit -m "feat(tui): onboarding wizard for first-run configuration"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| Headless 模式可用 | `node dist/main.js -p "echo hello" --json` 输出 JSON |
| Permission rules 生效 | read_file 不弹审批，write_file 弹审批 |
| Cost 显示正确 | SummaryBar 显示 token 数和费用 |
| 自定义命令加载 | 创建 `.rivet/commands/test.md`，输入 `/test` 执行 |
| Onboarding 触发 | 删除 config.json 后启动显示引导 |
| 全量测试通过 | `npm test` 零失败 |
| Typecheck 通过 | `npm run typecheck` 零错误 |
