/**
 * Plan Store — 计划文件持久化 (.rivet/plans/*.md)
 *
 * 职责：
 * - plan_submit tool 写入计划文件
 * - /plan-approve 列出/读取/批准计划
 * - 批准的 plan 载入 volatile context 供 agent 执行
 */

import { mkdir, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface PlanDocument {
  /** 文件名 slug (不含 .md) */
  slug: string
  /** 计划标题（从 markdown H1 提取） */
  title: string
  /** 完整 markdown 内容 */
  content: string
  /** 文件路径（相对于 project root） */
  path: string
  /** 创建时间 */
  createdAt: Date
  /** 状态 */
  status: 'submitted' | 'approved' | 'executed' | 'rejected'
  /** 批准时间 */
  approvedAt?: Date
  /** 多方案选项（submit 时持久化） */
  options?: PlanOption[]
}

export interface PlanOption {
  label: string
  description: string
}

const PLAN_OPTIONS_FRONTMATTER_RE = /^---\nrivet-options:\s*(\[[\s\S]*?\])\s*\n---\n/

/** .rivet/plans 相对于项目根目录的路径 */
const PLANS_DIR = '.rivet/plans'

function plansRoot(cwd: string): string {
  return join(cwd, PLANS_DIR)
}

function planFilePath(cwd: string, slug: string): string {
  return join(plansRoot(cwd), `${slug}.md`)
}

/** 确保 .rivet/plans 目录存在 */
async function ensurePlansDir(cwd: string): Promise<void> {
  const dir = plansRoot(cwd)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/** 从 slug 生成安全文件名 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'plan'
}

/** 从 markdown 内容提取 H1 标题 */
function extractTitle(content: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m?.[1]?.trim() || 'Untitled Plan'
}

/** 从计划 frontmatter 解析多方案选项 */
export function parsePlanOptions(content: string): PlanOption[] | undefined {
  const m = content.match(PLAN_OPTIONS_FRONTMATTER_RE)
  if (!m) return undefined
  try {
    const parsed = JSON.parse(m[1]!) as unknown
    if (!Array.isArray(parsed)) return undefined
    const options = parsed.filter(
      (item): item is PlanOption =>
        item !== null
        && typeof item === 'object'
        && typeof (item as PlanOption).label === 'string'
        && typeof (item as PlanOption).description === 'string',
    )
    return options.length > 0 ? options : undefined
  } catch {
    return undefined
  }
}

function buildPlanFrontmatter(options?: readonly PlanOption[]): string {
  if (!options || options.length === 0) return ''
  return `---\nrivet-options: ${JSON.stringify(options)}\n---\n\n`
}

/** 写计划文件。返回写入的文件路径（相对于 cwd） */
export async function writePlan(
  cwd: string,
  slug: string,
  content: string,
  options?: readonly PlanOption[],
): Promise<string> {
  await ensurePlansDir(cwd)
  const filePath = planFilePath(cwd, slug)
  const body = buildPlanFrontmatter(options) + content.replace(PLAN_OPTIONS_FRONTMATTER_RE, '')
  await writeFile(filePath, body, 'utf-8')
  return join(PLANS_DIR, `${slug}.md`)
}

/** 读单个计划 */
export async function readPlan(
  cwd: string,
  slug: string,
): Promise<PlanDocument | null> {
  const filePath = planFilePath(cwd, slug)
  try {
    const content = await readFile(filePath, 'utf-8')
    const s = await stat(filePath)
    const status = parsePlanStatus(content)
    return {
      slug,
      title: extractTitle(content),
      content,
      path: join(PLANS_DIR, `${slug}.md`),
      createdAt: s.birthtime,
      status,
      options: parsePlanOptions(content),
    }
  } catch {
    return null
  }
}

/** 列出所有计划 */
export async function listPlans(cwd: string): Promise<PlanDocument[]> {
  const dir = plansRoot(cwd)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const plans: PlanDocument[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const slug = entry.replace(/\.md$/, '')
    const plan = await readPlan(cwd, slug)
    if (plan) plans.push(plan)
  }

  return plans.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/** 标记计划为已批准（在文件头部插入状态标记） */
export async function approvePlan(cwd: string, slug: string): Promise<PlanDocument | null> {
  return markPlanStatus(cwd, slug, 'APPROVED')
}

/**
 * 拒绝计划:写入 REJECTED 状态标记而非删除文件,保留原稿供 agent 在其上修订。
 * 返回更新后的文档,计划不存在时返回 null。
 */
export async function rejectPlan(cwd: string, slug: string): Promise<PlanDocument | null> {
  return markPlanStatus(cwd, slug, 'REJECTED')
}

/** 在第一个 H1 前插入状态标记并回写,返回更新后的文档。 */
async function markPlanStatus(
  cwd: string,
  slug: string,
  status: 'APPROVED' | 'REJECTED' | 'EXECUTED',
): Promise<PlanDocument | null> {
  const plan = await readPlan(cwd, slug)
  if (!plan) return null

  const statusLine = `> **Status: ${status}** — ${new Date().toISOString()}\n\n`
  let newContent: string
  const h1Match = plan.content.match(/^#\s+.*$/m)
  if (h1Match) {
    const idx = plan.content.indexOf(h1Match[0])
    newContent = plan.content.slice(0, idx) + statusLine + plan.content.slice(idx)
  } else {
    newContent = statusLine + plan.content
  }

  await writePlan(cwd, slug, newContent)
  return readPlan(cwd, slug)
}

/** 删除计划 */
export async function deletePlan(cwd: string, slug: string): Promise<boolean> {
  const filePath = planFilePath(cwd, slug)
  try {
    await rm(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 从计划内容解析状态。
 * 查找 "Status: APPROVED" 等标记。
 */
function parsePlanStatus(content: string): PlanDocument['status'] {
  if (/Status:\s*EXECUTED/i.test(content)) return 'executed'
  if (/Status:\s*APPROVED/i.test(content)) return 'approved'
  if (/Status:\s*REJECTED/i.test(content)) return 'rejected'
  return 'submitted'
}
