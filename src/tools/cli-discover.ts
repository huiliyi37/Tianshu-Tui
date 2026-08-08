/**
 * cli_discover — 能力发现与安装工具。
 *
 * 吸收 meta-skill 流程：search（capability index）→ preflight → 缺口给 install
 * 计划（dry-run 预览）→ 安装 → 自动跑 cli-skill-generator 产出 SKILL.md。
 *
 * 硬闸门（教训参考 CLI-Anything #304 路径遍历修复与 meta-skill 无闸门盲装反面教材）：
 *  - requiresApproval 恒为 true —— 安装永不自动放行，先过审批再执行。
 *  - 安装源白名单 brew/npm/pip（官方源），包名严格格式校验（防注入）。安装用
 *    execFile argv 数组直调，不经 shell —— 字符串注入无生效面。
 *  - realpath 围栏：SKILL.md 输出目录必须落在项目根（cwd）内，symlink 逃逸被拒。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { CapabilityRegistry, Checkers, PreflightResult } from './capability-index.js'
import { loadMergedRegistry, preflightCapability, formatPreflight } from './capability-index.js'
import { generateCliSkill as defaultGenerateCliSkill } from '../skills/cli-skill-generator.js'
import type { CliSkillOptions, CliSkillResult } from '../skills/cli-skill-generator.js'
import type { Tool, ToolCallParams } from './types.js'

export const ALLOWED_INSTALL_SOURCES = ['brew', 'npm', 'pip'] as const
export type InstallSource = (typeof ALLOWED_INSTALL_SOURCES)[number]

export interface InstallPlan {
  source: InstallSource
  packageName: string
  args: string[]
  command: string
}

/** 各源包名白名单格式（拒绝 shell 元字符、空白与路径片段）。 */
const PACKAGE_NAME_RE: Record<InstallSource, RegExp> = {
  brew: /^[a-z0-9][a-z0-9+._@-]*$/i,
  npm: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  pip: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
}

/**
 * 严格解析 installHint 为结构化安装计划。只接受三种官方源形态：
 *   `brew install <pkg>` | `npm install [-g] <pkg>` | `pip[3] install <pkg>`
 * 白名单外源、包名含非法字符 → 返回 null（拒绝）。
 */
export function parseInstallHint(hint: string | undefined): InstallPlan | null {
  if (!hint) return null
  const trimmed = hint.trim()
  let m = /^brew\s+install\s+(\S+)$/.exec(trimmed)
  if (m) return makePlan('brew', m[1]!, [])
  m = /^npm\s+install(?:\s+-g)?\s+(\S+)$/.exec(trimmed)
  if (m) return makePlan('npm', m[1]!, trimmed.includes(' -g ') ? ['-g'] : [])
  m = /^pip(?:3)?\s+install\s+(\S+)$/.exec(trimmed)
  if (m) return makePlan('pip', m[1]!, [])
  return null
}

function makePlan(source: InstallSource, packageName: string, args: string[]): InstallPlan | null {
  if (!PACKAGE_NAME_RE[source].test(packageName)) return null
  const flag = args.length > 0 ? ` ${args.join(' ')}` : ''
  return { source, packageName, args, command: `${source} install${flag} ${packageName}` }
}

/** realpath 围栏：target 解析后必须等于或位于 root 内（防 symlink 逃逸）。 */
export function isPathWithinRoot(root: string, target: string): boolean {
  let rootReal: string
  let targetReal: string
  try {
    rootReal = realpathSync(root)
    targetReal = realpathSync(target)
  } catch {
    return false
  }
  return targetReal === rootReal || targetReal.startsWith(rootReal + sep)
}

export interface RunOutcome {
  ok: boolean
  output: string
}

/** 默认安装执行：execFile argv 直调（不经 shell），pip 缺失时回退 pip3。 */
export function defaultRunInstall(plan: InstallPlan): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const attempt = (bin: string): void => {
      execFile(
        bin,
        [...plan.args, plan.packageName],
        { timeout: 120_000, windowsHide: true },
        (err, stdout, stderr) => {
          const out = `${stdout ?? ''}${stderr ?? ''}`
          if (!err) return resolve({ ok: true, output: out })
          const e = err as NodeJS.ErrnoException & { code?: string | number }
          if (plan.source === 'pip' && bin === 'pip' && e.code === 'ENOENT') {
            attempt('pip3')
            return
          }
          resolve({ ok: false, output: `${out}\n${e.message}` })
        },
      )
    }
    attempt(plan.source)
  })
}

/** 可注入依赖，便于测试隔离（不触真实进程 / 文件系统）。 */
export interface CliDiscoverDeps {
  loadRegistry?: (cwd: string) => CapabilityRegistry
  checkers?: Checkers
  runInstall?: (plan: InstallPlan) => Promise<RunOutcome>
  generateSkill?: (opts: CliSkillOptions) => Promise<CliSkillResult>
}

function describeProvider(p: PreflightResult['providers'][number]): string {
  const missingBits = [
    ...p.missing.binary.map((b) => `binary:${b}`),
    ...p.missing.env.map((e) => `env:${e}`),
    ...p.missing.package.map((n) => `package:${n}`),
  ]
  return `${p.name} (${p.kind}) missing ${missingBits.join(', ')}`
}

export function createCliDiscoverTool(deps?: CliDiscoverDeps): Tool {
  const loadRegistry = deps?.loadRegistry ?? loadMergedRegistry
  const checkers = deps?.checkers
  const runInstall = deps?.runInstall ?? defaultRunInstall
  const generateSkill = deps?.generateSkill ?? defaultGenerateCliSkill

  const findPreflight = (capabilityId: unknown, cwd: string): PreflightResult | null => {
    if (typeof capabilityId !== 'string' || capabilityId.length === 0) return null
    return preflightCapability(loadRegistry(cwd), capabilityId, checkers)
  }

  const formatSearch = (cwd: string, query: unknown): string => {
    const registry = loadRegistry(cwd)
    const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
    const list = q
      ? registry.capabilities.filter(
          (c) =>
            c.intent.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q) ||
            (c.hints ?? []).some((h) => h.toLowerCase().includes(q)),
        )
      : registry.capabilities
    if (list.length === 0) return `cli_discover: 未找到匹配 "${q}" 的能力。`
    const lines = [`capability 检索${q ? `（query: "${q}"）` : ''}：`]
    for (const c of list) {
      lines.push(`  - ${c.id}: ${c.intent}（providers: ${c.providers.map((p) => p.name).join(', ')}）`)
    }
    return lines.join('\n')
  }

  const execPlan = (capabilityId: unknown, cwd: string): string => {
    const result = findPreflight(capabilityId, cwd)
    if (!result) return `cli_discover: plan 需要有效的 capabilityId`
    const missing = result.providers.filter((p) => !p.available)
    const lines = [`capability: ${result.capability.id}`, `intent: ${result.capability.intent}`]
    if (missing.length === 0) {
      lines.push('', '所有 provider 均可用，无需安装。', '（dry-run 预览结束，零副作用）')
      return lines.join('\n')
    }
    lines.push('', 'install 计划（dry-run 预览，零副作用，未执行任何命令）：')
    let rejected = 0
    for (const p of missing) {
      const plan = parseInstallHint(p.installHint)
      if (!plan) {
        rejected += 1
        lines.push(
          `  - ${describeProvider(p)} → 拒绝：installHint "${p.installHint ?? '(无)'}" 不在白名单（brew/npm/pip）或包名非法`,
        )
        continue
      }
      lines.push(`  - ${describeProvider(p)} → ${plan.command}`)
    }
    lines.push('', `dry-run 完成：${missing.length - rejected} 个可安装，${rejected} 个被拒（白名单外/非法包名）。`)
    return lines.join('\n')
  }

  const execInstall = async (capabilityId: unknown, cwd: string, onFileWrite?: (f: string) => void): Promise<string> => {
    const result = findPreflight(capabilityId, cwd)
    if (!result) return `cli_discover: install 需要有效的 capabilityId`
    const missing = result.providers.filter((p) => !p.available)
    const lines = [`capability: ${result.capability.id}`]
    if (missing.length === 0) {
      lines.push('所有 provider 均可用，无需安装。')
      return lines.join('\n')
    }
    let installed = 0
    let skipped = 0
    for (const p of missing) {
      const plan = parseInstallHint(p.installHint)
      if (!plan) {
        skipped += 1
        lines.push(
          `  - ${describeProvider(p)} → 拒绝：installHint "${p.installHint ?? '(无)'}" 不在白名单（brew/npm/pip）或包名非法`,
        )
        continue
      }
      lines.push(`  - ${describeProvider(p)} → ${plan.command}`)
      const outcome = await runInstall(plan)
      if (!outcome.ok) {
        skipped += 1
        lines.push(`    ✗ 安装失败：${outcome.output.trim() || '未知错误'}`)
        continue
      }
      installed += 1
      lines.push('    ✓ 安装成功')
      // 自动跑 skill-generator 产出 SKILL.md（realpath 围栏约束输出路径）
      const binary = p.missing.binary[0] ?? plan.packageName
      const outDir = join(cwd, '.rivet', 'skills')
      try {
        mkdirSync(outDir, { recursive: true })
        if (!isPathWithinRoot(cwd, outDir)) {
          lines.push(`    ✗ 拒绝产出 SKILL.md：输出路径 ${outDir} 逃逸项目根（realpath 围栏）`)
          skipped += 1
          continue
        }
        const skill = await generateSkill({ binary, cwd, outDir })
        onFileWrite?.(skill.filePath)
        lines.push(`    ✓ 已生成 SKILL.md：${skill.filePath}`)
      } catch (e) {
        lines.push(`    ! 生成 SKILL.md 失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    lines.unshift(`install 完成：${installed} 个成功，${skipped} 个未安装。`)
    return lines.join('\n')
  }

  return {
    definition: {
      name: 'cli_discover',
      description:
        '能力发现与安装：search 按 intent 检索能力索引 → preflight 检查依赖可用性 → plan 生成缺失依赖安装计划（dry-run 预览，零副作用）→ install 安装并自动产出 SKILL.md。安装永不自动放行（requiresApproval=true），仅接受 brew/npm/pip 官方源且包名格式校验，SKILL.md 输出受 realpath 围栏约束。',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'preflight', 'plan', 'install'],
            description: '动作。search/preflight/plan 只读零副作用；install 执行安装并写 SKILL.md，需审批。',
          },
          query: { type: 'string', description: 'search：按 intent/hints/id 检索的关键词。' },
          capabilityId: { type: 'string', description: 'preflight/plan/install 的目标能力 id。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    async execute(params: ToolCallParams) {
      const action = params.input.action
      const cwd = params.cwd
      switch (action) {
        case 'search':
          return { content: formatSearch(cwd, params.input.query) }
        case 'preflight': {
          const result = findPreflight(params.input.capabilityId, cwd)
          if (!result) return { content: `cli_discover: 未找到 capability "${String(params.input.capabilityId)}"`, isError: true }
          return { content: formatPreflight(result) }
        }
        case 'plan':
          return { content: execPlan(params.input.capabilityId, cwd) }
        case 'install':
          return { content: await execInstall(params.input.capabilityId, cwd, params.onFileWrite) }
        default:
          return { content: `cli_discover: 未知 action "${String(action)}"`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: (params?: ToolCallParams) => (params?.input.action === 'install' ? 600_000 : 120_000),
  }
}
