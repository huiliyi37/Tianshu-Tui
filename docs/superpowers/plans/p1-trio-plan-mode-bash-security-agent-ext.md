# P1 三件套：Plan Mode / Bash 安全 / Agent 外部化 实现计划

> **状态：✅ 已全部实施** — Plan Mode + Bash 安全补强 + Agent 外部化

**目标：** 按优先级依次实现三个 P1 功能：Plan Mode（只读探索→审批→执行）、Bash 安全补强（命令注入检测 + 破坏性命令警告 + env 清洗）、Agent 定义外部化（`.rivet/agents/*.md`）。

**架构：** 三个功能互相独立，按序实施。Plan Mode 在 `tool-pipeline.ts` 的 doom-loop 检查后、approval gate 前插入只读拦截门。Bash 安全在 `approval-risk.ts` 新增模式匹配数组 + `bash.ts` 增加 env 清洗。Agent 外部化通过 `ProfileDefinition` 接口统一 6 处散落逻辑，`.rivet/agents/` 目录加载用户自定义 profile。

**技术栈：** TypeScript strict, zod schema, node:test + assert/strict

---

## Scope Check

三个功能跨独立子系统（tool-pipeline / approval-risk / work-order），但实现有先后依赖：
- **Phase A (Plan Mode)** — 独立，无外部依赖
- **Phase B (Bash 安全)** — 独立，不依赖 Plan Mode
- **Phase C (Agent 外部化)** — 独立，但改动面最大（6 文件），放在最后

每个 Phase 完成后独立 commit + typecheck + test。

---

## File Structure

### Phase A: Plan Mode

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/plan-mode.ts` | 创建 | PlanMode 类型、状态机、PLAN_MODE_TOOLS 白名单 |
| `src/agent/__tests__/plan-mode.test.ts` | 创建 | Plan Mode 状态机 + 工具拦截测试 |
| `src/agent/tool-pipeline.ts:442` | 修改 | 在 doom-loop 检查后插入 plan-mode gate |
| `src/agent/loop.ts` | 修改 | AgentLoop 持有 planModeState，提供 enter/exit 方法 |
| `src/prompt/volatile.ts` | 修改 | plan-mode 激活时注入 volatile 提示 |
| `src/tui/slash-commands.ts` | 修改 | 添加 `/plan` slash command 进入 plan mode |

### Phase B: Bash 安全补强

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/approval-risk.ts` | 修改 | 新增 INJECTION_PATTERNS + DESTRUCTIVE_EXTENDED_PATTERNS + SED_BYPASS_PATTERNS |
| `src/tools/bash.ts:83` | 修改 | env 清洗：strip API keys/tokens before passing to child |
| `src/agent/__tests__/approval-risk.test.ts` | 修改 | 新增 pattern 覆盖测试 |

### Phase C: Agent 定义外部化

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/profile-registry.ts` | 创建 | ProfileDefinition 接口 + 内置 profile 注册 + `.rivet/agents/` 加载 |
| `src/agent/__tests__/profile-registry.test.ts` | 创建 | Profile 加载/校验/覆盖测试 |
| `src/agent/work-order.ts` | 修改 | WorkerProfile 从 registry 动态获取，保留 z.enum 兜底 |
| `src/agent/coordination-policy.ts` | 修改 | classifyProfile 从 registry 读取 role |
| `src/agent/worker-prompts.ts` | 修改 | PROFILE_PROMPTS 从 registry 读取 |
| `src/agent/worker-evidence.ts` | 修改 | READ_ONLY_PROFILES 从 registry 推导 |
| `src/agent/hooks/dispatcher-hook.ts` | 修改 | inferWorkerProfile 从 registry 读取 defaultKind |
| `src/main.tsx:433` | 修改 | writeProfiles 从 registry 推导 |

---

## Research Endorsement（调研背书）

### 删除/行为变更操作

| 操作 | 调用方 | 存在理由 | 边界风险 |
|------|--------|----------|----------|
| tool-pipeline.ts 插入 plan-mode gate | loop.ts → tool-execution.ts → executeToolUse() | 当前 doom-loop 检查后直接进 approval gate，需在中间插入 | 必须保证 plan-mode off 时完全透传，零开销 |
| bash.ts env 清洗 | bash.ts execute() 是唯一调用点 | 当前传 `process.env` 全量，API key 泄露给子进程 | 必须保留 PATH/HOME/PWD/NODE_ENV/TERM/LANG 等必要变量 |
| work-order.ts WorkerProfile 扩展 | coordinator.ts, aggregation.ts, hands-session.ts 等 20+ 文件 | z.enum 提供编译时类型安全 | 扩展为动态后需要 z.string() + runtime 校验 |

### Plan Mode 插入点

`src/agent/tool-pipeline.ts` 工具执行路径：
```
line 395: cerebellar read-before-edit gate
line 410: PreToolUse hook
line 420: repair pipeline
line 435: reliability mode gate
line 440: doom-loop blocked check
→ [NEW] line ~442: plan-mode gate ←
line 443: approval gate (assessToolRisk → shouldAsk → onApprovalRequired)
line 492: checkpoint creation
line 525: actual tool execution
```

READ_TOOLS 白名单已存在于 `tool-pipeline.ts:157`，plan-mode 可复用。

---

## Tasks

### Phase A: Plan Mode

#### A1. 创建 plan-mode 类型与状态机

- [ ] **创建** `src/agent/plan-mode.ts`

```typescript
/** Plan Mode 类型与状态机 */

/** Plan Mode 状态 */
export type PlanModeState = 'off' | 'planning' | 'approved'

/** Plan Mode 下允许的工具 — 只读探索 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'repo_map',
  'inspect_project', 'related_tests', 'diff', 'todo', 'plan_close',
  'deliver_task', 'delegate_task', 'delegate_batch',
])

export interface PlanModeResult {
  /** 是否允许执行 */
  allowed: boolean
  /** 拒绝原因（allowed=false 时） */
  reason?: string
}

/** 检查工具是否在 plan-mode 下被允许 */
export function checkPlanMode(
  state: PlanModeState,
  toolName: string,
): PlanModeResult {
  if (state === 'off') return { allowed: true }
  if (state === 'approved') return { allowed: true }
  // state === 'planning'
  if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return { allowed: true }
  return {
    allowed: false,
    reason: `Plan Mode is active — write operations are blocked. Allowed tools: read, grep, glob, repo_map, inspect_project, todo, delegate. Use /plan-approve to exit plan mode and allow execution.`,
  }
}
```

- [ ] **创建** `src/agent/__tests__/plan-mode.test.ts`

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkPlanMode, type PlanModeState } from '../plan-mode.js'

describe('checkPlanMode', () => {
  it('off state allows all tools', () => {
    assert.deepEqual(checkPlanMode('off', 'write_file'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'bash'), { allowed: true })
  })

  it('approved state allows all tools', () => {
    assert.deepEqual(checkPlanMode('approved', 'edit_file'), { allowed: true })
  })

  it('planning state allows read-only tools', () => {
    for (const tool of ['read_file', 'grep', 'glob', 'repo_map', 'inspect_project', 'todo']) {
      assert.deepEqual(checkPlanMode('planning', tool), { allowed: true }, `${tool} should be allowed`)
    }
  })

  it('planning state blocks write tools', () => {
    for (const tool of ['write_file', 'edit_file', 'bash', 'run_tests']) {
      const result = checkPlanMode('planning', tool)
      assert.equal(result.allowed, false, `${tool} should be blocked`)
      assert.ok(result.reason, `${tool} should have a reason`)
    }
  })
})
```

**验证：** `npx tsx --test src/agent/__tests__/plan-mode.test.ts` → 4/4 pass
**提交：** `feat(agent): add plan-mode type, state machine, and allowed-tools check`

---

#### A2. 在 tool-pipeline 插入 plan-mode gate

- [ ] **修改** `src/agent/tool-pipeline.ts:~442`（doom-loop blocked return 之后、approval gate 之前）

在 doom-loop 检查块结束后（约 line 442），approval gate 注释之前，插入：

```typescript
// Plan-mode gate — block write tools during planning phase
const planModeResult = checkPlanMode(deps.config.planModeState ?? 'off', tu.name)
if (!planModeResult.allowed) {
  callbacks.onToolResult(tu.id, tu.name, planModeResult.reason ?? 'Plan Mode: write operations blocked', true)
  return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? (planModeResult.reason ?? '') + starSig : planModeResult.reason ?? '', is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
}
```

同时在文件顶部 import：
```typescript
import { checkPlanMode } from './plan-mode.js'
```

AgentConfig 接口新增可选字段：
```typescript
planModeState?: PlanModeState
```

**验证：** `npx tsc --noEmit` → pass
**提交：** `feat(agent): wire plan-mode gate into tool-pipeline execution path`

---

#### A3. AgentLoop 持有 plan-mode 状态 + prompt 注入

- [ ] **修改** `src/agent/loop.ts`

在 AgentLoop 类中新增：
```typescript
private planModeState: PlanModeState = 'off'

/** 进入 plan mode */
enterPlanMode(): void { this.planModeState = 'planning' }

/** 退出 plan mode（审批通过） */
exitPlanMode(): void { this.planModeState = 'off' }

/** 获取当前 plan mode 状态 */
getPlanModeState(): PlanModeState { return this.planModeState }
```

在 `createAgentConfig()` 返回对象中传递：
```typescript
planModeState: this.planModeState,
```

> 注意：由于 config 在构造时一次性创建，需要在 `_runInner` 每轮开始时同步 `planModeState` 到 config，或改为引用方式（config 引用 loop 实例的 getter）。

- [ ] **修改** `src/prompt/volatile.ts`（或 prompt engine 的 volatile 构建处）

plan-mode 激活时追加 volatile 提示：
```
<plan-mode>
You are in PLAN MODE. You may ONLY read files and explore the codebase — do NOT write, edit, or execute commands that modify state. Produce a detailed plan first. The user will approve before execution begins.
</plan-mode>
```

**验证：** `npx tsc --noEmit` → pass，`npm exec -- tsx --test src/agent/__tests__/plan-mode.test.ts` → pass
**提交：** `feat(agent): add plan-mode state to AgentLoop with prompt injection`

---

#### A4. TUI slash command 集成

- [ ] **修改** `src/tui/slash-commands.ts`

在现有 `/plan` case 旁添加 `/plan-mode` 和 `/plan-approve` 命令：

```typescript
case '/plan-mode': {
  agentLoop.enterPlanMode()
  pushStatic(createLogEntry({ type: 'system', content: '🔍 Plan Mode activated. Write operations are blocked. Explore the codebase and produce a plan.' }))
  break
}
case '/plan-approve': {
  agentLoop.exitPlanMode()
  pushStatic(createLogEntry({ type: 'system', content: '✅ Plan Mode exited. All operations are now allowed.' }))
  break
}
```

**验证：** `npx tsc --noEmit` → pass
**提交：** `feat(tui): add /plan-mode and /plan-approve slash commands`

---

### Phase B: Bash 安全补强

#### B1. 新增安全模式匹配数组

- [ ] **修改** `src/agent/approval-risk.ts`

在 `DANGEROUS_BASH_PATTERNS` 之后新增：

```typescript
/** 命令注入检测：heredoc 注入、进程替换、zsh 危险命令 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bheredoc\b/i,                          // heredoc 注入
  /\bprocess\s+substitution\b/i,           // 进程替换描述（文档性）
  /[<>]\s*\(/,                              // 进程替换 <(...) 或 >(...)
  /\bzmodload\b/,                           // zsh 模块加载
  /\bzsh\b.*\bemulate\b/,                   // zsh emulate
  /\bsysopen\b/,                            // zsh sysopen
  /\bpowershell\s*-enc/i,                   // PowerShell 编码执行
]

/** 扩展的破坏性命令警告 */
export const DESTRUCTIVE_EXTENDED_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\s+--force\b/i,             // 已有但双重保障
  /\bdocker\s+(?:rm|rmi)\b/,                // docker 删除
  /\bdocker\s+system\s+prune\b/,            // docker 清理
  /\bkubectl\s+delete\b/,                   // k8s 删除
  /\btruncate\s+-s\s+0\b/,                  // 清空文件
  /\bdd\s+if=.*of=\/dev\//,                 // dd 写设备
  /\bmkfs\b/,                               // 格式化
  /\bmount\b/,                              // 挂载
]

/** sed 绕过检测 — 通过 sed 间接修改安全关键文件 */
export const SED_BYPASS_PATTERNS: readonly RegExp[] = [
  /\bsed\b.*\b(?:\/etc\/|\.ssh\/|authorized_keys|shadow|passwd)\b/,  // sed 修改系统文件
]
```

在 `assessToolRisk()` 中，bash 工具的检测逻辑后追加：

```typescript
// 命令注入检测
if (toolName === 'bash') {
  const cmd = typeof input.command === 'string' ? input.command : ''
  for (const p of INJECTION_PATTERNS) {
    if (p.test(cmd)) {
      reasons.push(`Command injection pattern detected: ${p.source}`)
      riskLevel = 'high'
    }
  }
  for (const p of DESTRUCTIVE_EXTENDED_PATTERNS) {
    if (p.test(cmd)) {
      reasons.push(`Extended destructive command: ${p.source}`)
      riskLevel = riskLevel === 'high' ? 'high' : 'medium'
    }
  }
  for (const p of SED_BYPASS_PATTERNS) {
    if (p.test(cmd)) {
      reasons.push(`sed bypass attempt on security-critical file`)
      riskLevel = 'high'
    }
  }
}
```

- [ ] **修改** `src/agent/__tests__/approval-risk.test.ts`

新增测试组：

```typescript
describe('INJECTION_PATTERNS', () => {
  it('detects process substitution', () => {
    const result = assessToolRisk('bash', { command: 'cat <(ls)' }, 'none', [], undefined)
    assert.ok(result.reasons.some(r => r.includes('injection')), `Expected injection detection, got: ${result.reasons.join(', ')}`)
  })

  it('detects zsh dangerous commands', () => {
    const result = assessToolRisk('bash', { command: 'zmodload zsh/net/tcp' }, 'none', [], undefined)
    assert.ok(result.reasons.some(r => r.includes('injection')))
  })
})

describe('DESTRUCTIVE_EXTENDED_PATTERNS', () => {
  it('detects docker rm', () => {
    const result = assessToolRisk('bash', { command: 'docker rm -f $(docker ps -aq)' }, 'none', [], undefined)
    assert.ok(result.reasons.some(r => r.includes('destructive')))
  })

  it('detects kubectl delete', () => {
    const result = assessToolRisk('bash', { command: 'kubectl delete namespace production' }, 'none', [], undefined)
    assert.ok(result.reasons.some(r => r.includes('destructive')))
  })
})

describe('SED_BYPASS_PATTERNS', () => {
  it('detects sed on /etc/passwd', () => {
    const result = assessToolRisk('bash', { command: "sed -i 's/x/y/' /etc/passwd" }, 'none', [], undefined)
    assert.ok(result.reasons.some(r => r.includes('sed bypass')))
    assert.equal(result.level, 'high')
  })
})
```

**验证：** `npx tsx --test src/agent/__tests__/approval-risk.test.ts` → all pass
**提交：** `feat(agent): add injection/destructive-extended/sed-bypass pattern detection`

---

#### B2. Bash 环境变量清洗

- [ ] **修改** `src/tools/bash.ts:~83`

将 `env: { ...process.env }` 替换为清洗后的环境：

```typescript
/** 需要保留的环境变量前缀 */
const SAFE_ENV_PREFIXES = ['PATH', 'HOME', 'PWD', 'NODE_ENV', 'TERM', 'LANG', 'LC_', 'XDG_', 'EDITOR', 'VISUAL', 'PAGER', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP'] as const

/** 敏感关键词 — 包含这些子串的环境变量将被剥离 */
const SENSITIVE_ENV_KEYWORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH', 'API', 'PRIVATE'] as const

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    const isSensitive = SENSITIVE_ENV_KEYWORDS.some(kw => upper.includes(kw))
    const isSafe = SAFE_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (isSafe && !isSensitive) {
      clean[key] = value
    }
  }
  return clean
}
```

在 execute 函数中使用：
```typescript
env: sanitizeEnv(process.env),
```

- [ ] **修改** `src/tools/__tests__/bash.test.ts`

新增测试：

```typescript
describe('sanitizeEnv', () => {
  it('strips API keys', () => {
    const result = sanitizeEnv({ ...process.env, OPENAI_API_KEY: 'sk-xxx', MY_SECRET_TOKEN: 'abc' })
    assert.equal(result.OPENAI_API_KEY, undefined)
    assert.equal(result.MY_SECRET_TOKEN, undefined)
  })

  it('preserves PATH and HOME', () => {
    const result = sanitizeEnv(process.env)
    assert.ok(result.PATH, 'PATH should be preserved')
    assert.ok(result.HOME, 'HOME should be preserved')
  })
})
```

**验证：** `npx tsx --test src/tools/__tests__/bash.test.ts` → all pass
**提交：** `feat(bash): sanitize environment variables before passing to child processes`

---

### Phase C: Agent 定义外部化

#### C1. 创建 ProfileDefinition 接口与 Registry

- [ ] **创建** `src/agent/profile-registry.ts`

```typescript
/** Agent Profile 定义 — 替代 6 处散落的硬编码逻辑 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export type AgentRole = 'brain' | 'hands' | 'readonly'

/** 单个 Profile 的完整定义 */
export interface ProfileDefinition {
  /** Profile 名称（唯一标识） */
  name: string
  /** 角色 — 决定 dispatch 路径和工具集 */
  role: AgentRole
  /** 允许的工具列表 */
  allowedTools: readonly string[]
  /** 专长 prompt — 教 worker 如何做它的 job */
  expertisePrompt: string
  /** 默认 WorkOrderKind（可选） */
  defaultKind?: string
  /** 默认 maxTokens budget */
  defaultMaxTokens?: number
  /** 是否为内置 profile */
  builtIn?: boolean
}

/** .rivet/agents/*.md 的 frontmatter schema */
const AgentFrontmatterSchema = z.object({
  name: z.string(),
  role: z.enum(['brain', 'hands', 'readonly']),
  tools: z.array(z.string()),
  defaultKind: z.string().optional(),
  maxTokens: z.number().optional(),
})

/** 内置 profile 定义 — 与当前硬编码逻辑完全一致 */
const BUILTIN_PROFILES: ProfileDefinition[] = [
  {
    name: 'code_scout',
    role: 'readonly',
    allowedTools: ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
    expertisePrompt: `You are a code scout. Your job is to locate, read, trace, and verify code. Methodology:
1. Start with grep/glob to locate relevant files
2. read_file to understand implementation
3. Trace imports and callers
4. Report findings with file:line references
Do NOT modify any files.`,
    builtIn: true,
  },
  {
    name: 'doc_scout',
    role: 'readonly',
    allowedTools: ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
    expertisePrompt: `You are a documentation scout. Locate and read documentation files. Report findings accurately.`,
    builtIn: true,
  },
  {
    name: 'planner',
    role: 'brain',
    allowedTools: ['delegate_task', 'delegate_batch'],
    expertisePrompt: `You are a planner. Analyze the task, decompose it, and delegate to appropriate workers. You have access to delegation tools only.`,
    builtIn: true,
  },
  {
    name: 'reviewer',
    role: 'readonly',
    allowedTools: ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
    expertisePrompt: `You are a code reviewer. Read the code carefully, identify issues, and provide actionable feedback.`,
    builtIn: true,
  },
  {
    name: 'verifier',
    role: 'hands',
    allowedTools: ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'edit_file', 'write_file', 'bash', 'run_tests'],
    expertisePrompt: `You are a verifier. Run tests, check type errors, and verify changes work correctly. You may write and edit test files.`,
    defaultMaxTokens: 16384,
    builtIn: true,
  },
  {
    name: 'patcher',
    role: 'hands',
    allowedTools: ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'edit_file', 'write_file', 'bash', 'run_tests'],
    expertisePrompt: `You are a patcher. Apply code changes precisely. Follow edit instructions exactly, preserving indentation and context.`,
    defaultMaxTokens: 16384,
    builtIn: true,
  },
]

export class ProfileRegistry {
  private profiles = new Map<string, ProfileDefinition>()

  constructor() {
    for (const p of BUILTIN_PROFILES) {
      this.profiles.set(p.name, p)
    }
  }

  /** 从 .rivet/agents/ 目录加载用户自定义 profile */
  loadFromDirectory(dir: string): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf-8')
          const def = parseAgentMarkdown(content)
          if (this.profiles.has(def.name) && this.profiles.get(def.name)!.builtIn) {
            errors.push(`${file}: cannot override built-in profile "${def.name}"`)
            continue
          }
          this.profiles.set(def.name, { ...def, builtIn: false })
          loaded.push(def.name)
        } catch (e) {
          errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch {
      // directory doesn't exist — that's fine
    }
    return { loaded, errors }
  }

  get(name: string): ProfileDefinition | undefined {
    return this.profiles.get(name)
  }

  list(): ProfileDefinition[] {
    return [...this.profiles.values()]
  }

  listByRole(role: AgentRole): ProfileDefinition[] {
    return this.list().filter(p => p.role === role)
  }

  listWriteProfiles(): string[] {
    return this.listByRole('hands').map(p => p.name)
  }

  listReadOnlyProfiles(): string[] {
    return this.listByRole('readonly').map(p => p.name)
  }
}

/** 解析 .rivet/agents/*.md 格式：YAML frontmatter + body as expertisePrompt */
function parseAgentMarkdown(content: string): ProfileDefinition {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) throw new Error('Missing YAML frontmatter (--- delimiters)')

  const raw = frontmatterMatch[1]
  const expertisePrompt = frontmatterMatch[2].trim()

  // Simple YAML parse for our flat schema — avoid yaml dependency
  const fm: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) {
      const key = m[1]
      const val = m[2].trim()
      if (val.startsWith('[')) {
        fm[key] = JSON.parse(val.replace(/'/g, '"'))
      } else {
        fm[key] = val
      }
    }
  }

  const parsed = AgentFrontmatterSchema.parse(fm)
  return {
    name: parsed.name,
    role: parsed.role,
    allowedTools: parsed.tools,
    expertisePrompt,
    defaultKind: parsed.defaultKind,
    defaultMaxTokens: parsed.maxTokens,
  }
}

/** 全局单例 */
export const profileRegistry = new ProfileRegistry()
```

- [ ] **创建** `src/agent/__tests__/profile-registry.test.ts`

```typescript
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ProfileRegistry, type ProfileDefinition } from '../profile-registry.js'

describe('ProfileRegistry', () => {
  let registry: ProfileRegistry

  beforeEach(() => {
    registry = new ProfileRegistry()
  })

  it('has 6 built-in profiles', () => {
    assert.equal(registry.list().length, 6)
  })

  it('maps code_scout as readonly', () => {
    const p = registry.get('code_scout')!
    assert.equal(p.role, 'readonly')
    assert.equal(p.builtIn, true)
  })

  it('maps patcher as hands with write tools', () => {
    const p = registry.get('patcher')!
    assert.equal(p.role, 'hands')
    assert.ok(p.allowedTools.includes('edit_file'))
    assert.ok(p.allowedTools.includes('write_file'))
  })

  it('maps planner as brain with delegate tools', () => {
    const p = registry.get('planner')!
    assert.equal(p.role, 'brain')
    assert.ok(p.allowedTools.includes('delegate_task'))
  })

  it('listWriteProfiles returns hands roles', () => {
    const write = registry.listWriteProfiles()
    assert.deepEqual(write.sort(), ['patcher', 'verifier'])
  })

  it('listReadOnlyProfiles returns readonly roles', () => {
    const ro = registry.listReadOnlyProfiles()
    assert.deepEqual(ro.sort(), ['code_scout', 'doc_scout', 'reviewer'])
  })

  it('rejects overriding built-in profiles', () => {
    // Simulate load with a file that tries to override 'patcher'
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { mkdtempSync } = await import('node:os')
    const tmp = mkdtempSync('/tmp/rivet-test-agents-')
    writeFileSync(`${tmp}/patcher.md`, '---\nname: patcher\nrole: brain\ntools: ["read_file"]\n---\nOverride attempt')
    const result = registry.loadFromDirectory(tmp)
    assert.deepEqual(result.errors, [`${tmp}/patcher.md: cannot override built-in profile "patcher"`])
    rmSync(tmp, { recursive: true })
  })

  it('loads valid user-defined profile', async () => {
    const { writeFileSync, rmSync } = await import('node:fs')
    const { mkdtempSync } = await import('node:os')
    const tmp = mkdtempSync('/tmp/rivet-test-agents-')
    writeFileSync(`${tmp}/security-auditor.md`, '---\nname: security_auditor\nrole: readonly\ntools: ["read_file","grep","glob"]\n---\nYou audit code for security vulnerabilities.')
    const result = registry.loadFromDirectory(tmp)
    assert.deepEqual(result.loaded, ['security_auditor'])
    const p = registry.get('security_auditor')!
    assert.equal(p.role, 'readonly')
    assert.equal(p.expertisePrompt, 'You audit code for security vulnerabilities.')
    assert.equal(p.builtIn, false)
    rmSync(tmp, { recursive: true })
  })
})
```

**验证：** `npx tsx --test src/agent/__tests__/profile-registry.test.ts` → all pass
**提交：** `feat(agent): add ProfileRegistry with built-in profiles and .rivet/agents/ loading`

---

#### C2. 统一 coordination-policy 使用 registry

- [ ] **修改** `src/agent/coordination-policy.ts`

将 `classifyProfile()` 从硬编码 switch 改为从 registry 读取：

```typescript
import { profileRegistry } from './profile-registry.js'

export function classifyProfile(profile: string): AgentRole {
  const def = profileRegistry.get(profile)
  if (def) return def.role
  return 'readonly' // 未知 profile 默认只读
}
```

**验证：** `npx tsx --test src/agent/__tests__/coordination-policy.test.ts` → pass
**提交：** `refactor(agent): unify classifyProfile to use ProfileRegistry`

---

#### C3. 统一 worker-prompts 使用 registry

- [ ] **修改** `src/agent/worker-prompts.ts`

将 `PROFILE_PROMPTS` 的 lookup 改为从 registry fallback：

```typescript
import { profileRegistry } from './profile-registry.js'

// 在 buildWorkerPrompt 中替换 PROFILE_PROMPTS[order.profile]
const profileDef = profileRegistry.get(order.profile)
const profilePrompt = profileDef?.expertisePrompt ?? `You are a ${order.profile} worker. Complete your assigned task.`
```

**验证：** `npx tsx --test src/agent/__tests__/worker-prompts.test.ts` → pass
**提交：** `refactor(agent): unify worker prompt lookup to use ProfileRegistry`

---

#### C4. 统一 work-order / main.tsx / dispatcher-hook

- [ ] **修改** `src/agent/work-order.ts`

保留 `workerProfileSchema` 的 6 个值作为默认，但允许扩展。在 factory 函数中从 registry 获取 allowedTools：

```typescript
import { profileRegistry } from './profile-registry.js'

// createReadOnlyWorkOrder 和 createWriteWorkOrder 中：
const profileDef = profileRegistry.get(profile)
const allowedTools = profileDef?.allowedTools ?? (isReadOnly ? [...READ_ONLY_WORKER_TOOLS] : [...WRITE_WORKER_TOOLS])
```

- [ ] **修改** `src/agent/hooks/dispatcher-hook.ts:70-74`

`inferWorkerProfile` 改为从 registry 的 `defaultKind` 反查：

```typescript
function inferWorkerProfile(domain: string): string {
  // 先按 domain 查匹配的 profile
  for (const p of profileRegistry.list()) {
    if (p.defaultKind === domain) return p.name
  }
  // 兜底
  if (domain === 'tests') return 'verifier'
  if (domain === 'docs') return 'doc_scout'
  return 'code_scout'
}
```

- [ ] **修改** `src/main.tsx:433-435`

将硬编码 `writeProfiles` 改为从 registry 推导：

```typescript
const writeProfiles = profileRegistry.listWriteProfiles()
```

**验证：** `npx tsc --noEmit && npm exec -- tsx --test src/agent/__tests__/work-order.test.ts src/agent/__tests__/coordinator.test.ts` → pass
**提交：** `refactor(agent): unify work-order/dispatcher/main to use ProfileRegistry`

---

## Verification

### 每步验证命令

```bash
# Phase A
npx tsx --test src/agent/__tests__/plan-mode.test.ts           # → 4 tests pass
npx tsc --noEmit                                                # → clean

# Phase B
npx tsx --test src/agent/__tests__/approval-risk.test.ts       # → all pass (原有 + 新增)
npx tsx --test src/tools/__tests__/bash.test.ts                # → all pass (原有 + 新增)

# Phase C
npx tsx --test src/agent/__tests__/profile-registry.test.ts    # → 8 tests pass
npx tsx --test src/agent/__tests__/coordination-policy.test.ts # → existing pass
npx tsx --test src/agent/__tests__/worker-prompts.test.ts      # → existing pass
npx tsx --test src/agent/__tests__/coordinator.test.ts         # → existing pass

# 全量回归
npx tsc --noEmit                                                # → clean
npm exec -- tsx --test src/**/__tests__/*.test.ts               # → no regressions
```

### 预期结果

- Phase A: 新增 2 文件，修改 4 文件，4 个新测试
- Phase B: 修改 2 文件，新增 ~15 个 pattern，3 组新测试
- Phase C: 新增 2 文件，修改 6 文件，8 个新测试

---

## Self-check

### 1. Spec Coverage

| 需求 | 任务 | 状态 |
|------|------|------|
| Plan Mode 只读拦截 | A1 + A2 | ✅ |
| Plan Mode prompt 注入 | A3 | ✅ |
| Plan Mode TUI 集成 | A4 | ✅ |
| 命令注入检测 (6 patterns) | B1 | ✅ |
| 扩展破坏性命令 (8 patterns) | B1 | ✅ |
| sed 绕过检测 | B1 | ✅ |
| 环境变量清洗 | B2 | ✅ |
| ProfileDefinition 接口 | C1 | ✅ |
| .rivet/agents/ 加载 | C1 | ✅ |
| 统一 6 处散落逻辑 | C2-C4 | ✅ |

### 2. Placeholder Scan

无 TODO / TBD / 待定 / 后续实现 / 补充细节 禁止词。

### 3. Type Consistency

- `PlanModeState`: `'off' | 'planning' | 'approved'` — 在 plan-mode.ts 定义，loop.ts 和 tool-pipeline.ts 消费
- `AgentRole`: `'brain' | 'hands' | 'readonly'` — 在 profile-registry.ts 定义，coordination-policy.ts 消费
- `ProfileDefinition` 接口：在 profile-registry.ts 定义，所有 Phase C 文件消费
- `INJECTION_PATTERNS` / `DESTRUCTIVE_EXTENDED_PATTERNS` / `SED_BYPASS_PATTERNS`：在 approval-risk.ts 导出，同文件内消费

---

## Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/p1-trio-plan-mode-bash-security-agent-ext.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个 Task 调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
