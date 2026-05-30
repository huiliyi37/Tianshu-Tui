/**
 * Agent Profile 定义 — 替代 6 处散落的硬编码逻辑
 *
 * 将 WorkerProfile 的角色映射、工具集、prompt 文本、evidence 分类
 * 统一到单一数据源，同时支持 .rivet/agents/ 目录加载用户自定义 profile。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type AgentRole = 'brain' | 'hands' | 'readonly'

/** 单个 Profile 的完整定义 */
export interface ProfileDefinition {
  /** Profile 名称（唯一标识，对应 WorkerProfile） */
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

/** 内置只读工具集 */
const READ_ONLY_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests'] as const

/** 内置写入工具集 */
const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'edit_file', 'write_file', 'bash', 'run_tests'] as const

/** 内置 profile 定义 — 与当前硬编码逻辑完全一致 */
const BUILTIN_PROFILES: ProfileDefinition[] = [
  {
    name: 'code_scout',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
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
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a documentation scout. Locate and read documentation files. Report findings accurately.`,
    builtIn: true,
  },
  {
    name: 'planner',
    role: 'brain',
    allowedTools: ['delegate_task', 'delegate_batch'],
    expertisePrompt: `You are a planner. Analyze the task, decompose it, and delegate to appropriate workers. You have access to delegation tools only.`,
    defaultKind: 'plan',
    builtIn: true,
  },
  {
    name: 'reviewer',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a code reviewer. Read the code carefully, identify issues, and provide actionable feedback.`,
    builtIn: true,
  },
  {
    name: 'verifier',
    role: 'hands',
    allowedTools: [...WRITE_TOOLS],
    expertisePrompt: `You are a verifier. Run tests, check type errors, and verify changes work correctly. You may write and edit test files.`,
    defaultMaxTokens: 16384,
    defaultKind: 'verify',
    builtIn: true,
  },
  {
    name: 'patcher',
    role: 'hands',
    allowedTools: [...WRITE_TOOLS],
    expertisePrompt: `You are a patcher. Apply code changes precisely. Follow edit instructions exactly, preserving indentation and context.`,
    defaultMaxTokens: 16384,
    defaultKind: 'patch_proposal',
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

  /** Get all known profile names (for validation) */
  getProfileNames(): string[] {
    return [...this.profiles.keys()]
  }
}

/** 解析 .rivet/agents/*.md 格式：YAML frontmatter + body as expertisePrompt */
function parseAgentMarkdown(content: string): ProfileDefinition {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) throw new Error('Missing YAML frontmatter (--- delimiters)')

  const raw = frontmatterMatch[1]!
  const expertisePrompt = frontmatterMatch[2]!.trim()

  // Simple YAML parse for our flat schema
  const fm: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) {
      const key = m[1]!
      const val = m[2]!.trim()
      if (val.startsWith('[')) {
        try {
          fm[key] = JSON.parse(val.replace(/'/g, '"'))
        } catch {
          // Array parsing failed — report error instead of silently corrupting
          throw new Error(`Failed to parse array for field "${key}": "${val}". Use JSON array syntax: ["item1", "item2"]`)
        }
      } else {
        fm[key] = val
      }
    }
  }

  // Validate required fields
  if (typeof fm.name !== 'string' || !fm.name) throw new Error('Missing required field: name')
  if (fm.role !== 'brain' && fm.role !== 'hands' && fm.role !== 'readonly') {
    throw new Error(`Invalid role "${String(fm.role)}". Must be: brain, hands, or readonly`)
  }
  if (!Array.isArray(fm.tools) || fm.tools.length === 0) {
    throw new Error('tools must be a non-empty array')
  }

  return {
    name: fm.name,
    role: fm.role as AgentRole,
    allowedTools: fm.tools as string[],
    expertisePrompt,
    defaultKind: typeof fm.defaultKind === 'string' ? fm.defaultKind : undefined,
    defaultMaxTokens: typeof fm.maxTokens === 'number' ? fm.maxTokens
      : typeof fm.maxTokens === 'string' ? (Number(fm.maxTokens) > 0 ? Number(fm.maxTokens) : undefined)
      : undefined,
  }
}

/** 全局单例 */
export const profileRegistry = new ProfileRegistry()
