import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 种子胶囊引擎 — 星域经验自动加载机制。
 *
 * 从 docs/seed-capsule-*.md 文件中自动发现并加载所有种子胶囊。
 * 每个胶囊文档包含一个 <seed-capsule star="..." sealed="..."> XML 块。
 * 提取后合并渲染到 frozen volatile block，session 全程稳定，prefix cache safe。
 *
 * 参考：docs/superpowers/specs/2026-05-28-seed-capsule-engine-design.md
 */

/** 胶囊文档命名模式：docs/seed-capsule-{starSlug}.md */
const CAPSULE_GLOB = /^seed-capsule-.+\.md$/

export interface SeedCapsule {
  /** 来源星域名 */
  star: string
  /** 封存日期 */
  sealedAt: string
  /** 一行索引摘要（gist 属性；缺省时为空） */
  gist?: string
  /** L1 核心文本（从 <seed-capsule> 标签内容提取） */
  raw: string
  /** 渲染后的完整 XML 块（可直接注入 volatile block） */
  block: string
}

interface ParsedTag {
  star: string
  sealed: string
  gist?: string
  content: string
}

/**
 * 从 markdown 文档中提取 <seed-capsule> 标签。
 * 格式：
 *   <seed-capsule star="天璇" sealed="2026-05-21" gist="跨域换视角">
 *     ...内容...
 *   </seed-capsule>
 *
 * 解析对**属性顺序与数量都容错**——先抓整个开标签，再逐属性提取。
 * 这样未知/额外属性（如 gist、seal）不会让整个胶囊被静默丢弃。
 * （根治"缺/多字段时解析退化"缺陷族——瑶光在自封胶囊时亲历过。）
 */
function parseCapsuleTag(md: string): ParsedTag | null {
  const openRe = /<seed-capsule\b([^>]*)>/
  const match = md.match(openRe)
  if (!match) return null

  const attrs = match[1] ?? ''
  const attr = (name: string): string | undefined => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
    return m ? m[1] : undefined
  }

  const star = attr('star')
  const sealed = attr('sealed')
  if (!star || !sealed) return null // star + sealed 是必需的最小契约

  const gist = attr('gist')
  const contentStart = match.index! + match[0].length
  const closeTag = '</seed-capsule>'
  const closeIdx = md.indexOf(closeTag, contentStart)
  if (closeIdx === -1) return null

  const content = md.slice(contentStart, closeIdx).trim()
  if (!content) return null

  return { star, sealed, gist, content }
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 加载单个胶囊文档，返回 SeedCapsule 或 null。
 */
function loadCapsuleFile(filePath: string): SeedCapsule | null {
  let md: string
  try {
    md = readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }

  const parsed = parseCapsuleTag(md)
  if (!parsed) return null

  return {
    star: parsed.star,
    sealedAt: parsed.sealed,
    gist: parsed.gist,
    raw: parsed.content,
    block: `<seed-capsule star="${escapeXml(parsed.star)}" sealed="${escapeXml(parsed.sealed)}">
${escapeXml(parsed.content)}
</seed-capsule>`,
  }
}

/** 缓存：cwd → 已加载的胶囊列表 */
let cachedCapsules: SeedCapsule[] | null = null
let cachedCwd: string | null = null

/**
 * 从 docs/ 目录中发现并加载所有 seed-capsule-*.md 胶囊文档。
 * 结果按 sealedAt 排序（最早的在前，保证稳定顺序）。
 * 缓存在内存中——胶囊文档是静态的，session 内不需要重新读取。
 */
export function loadAllCapsules(cwd: string): SeedCapsule[] {
  if (cachedCapsules !== null && cachedCwd === cwd) {
    return cachedCapsules
  }

  const docsDir = join(cwd, 'docs')
  if (!existsSync(docsDir)) return []

  let entries: string[]
  try {
    entries = readdirSync(docsDir)
  } catch {
    return []
  }

  const capsules: SeedCapsule[] = []
  for (const entry of entries) {
    if (!CAPSULE_GLOB.test(entry)) continue
    const capsule = loadCapsuleFile(join(docsDir, entry))
    if (capsule) capsules.push(capsule)
  }

  // 按 sealedAt 排序，保证稳定顺序
  capsules.sort((a, b) => a.sealedAt.localeCompare(b.sealedAt))

  cachedCapsules = capsules
  cachedCwd = cwd
  return capsules
}

/**
 * 将所有已加载的胶囊合并渲染为一个 volatile block。
 * 返回合并后的 XML 片段，或 undefined（无胶囊时）。
 */
export function renderAllCapsulesBlock(cwd: string): string | undefined {
  const capsules = loadAllCapsules(cwd)
  if (capsules.length === 0) return undefined
  return capsules.map(c => c.block).join('\n\n')
}

/**
 * 渲染**极小的 L1 索引**（仅星名 + gist 一行），用于注入冻结前缀。
 * 替代 renderAllCapsulesBlock 的全文注入：膨胀从"每星一胶囊"降到"每星一行"，
 * 稳定、可缓存、可无限加星。完整正文经 recall_capsule 工具按需拉取
 * （落在工具结果通道 = anchor 之后，cache-safe，不篡改冻结前缀）。
 */
export function renderCapsuleIndexBlock(cwd: string): string | undefined {
  const capsules = loadAllCapsules(cwd)
  if (capsules.length === 0) return undefined
  const lines = capsules.map(c => `  ${c.star} — ${c.gist ?? '（无摘要）'}`)
  return [
    '<seed-capsules note="前辈星域封存的方法索引。需要某位的完整原则时调用 recall_capsule(star)。">',
    ...lines,
    '</seed-capsules>',
  ].join('\n')
}

/** 按星名取单个胶囊的完整 XML 块（供 recall_capsule 工具按需拉取）。 */
export function getCapsuleByStar(cwd: string, star: string): SeedCapsule | undefined {
  const q = star.trim().toLowerCase()
  return loadAllCapsules(cwd).find(c => c.star.toLowerCase() === q)
}

/** 已加载胶囊的星名列表（供工具枚举可选值 / 模糊匹配兜底）。 */
export function listCapsuleStars(cwd: string): string[] {
  return loadAllCapsules(cwd).map(c => c.star)
}

// ─── 向后兼容（供旧调用方或 volatile-snapshot 迁移期使用） ───

export interface SeedCapsuleL1 {
  block: string
  raw: string
}

/**
 * @deprecated 使用 loadAllCapsules / renderAllCapsulesBlock 代替。
 * 仅保留向后兼容——只加载天璇胶囊。
 */
export function loadTianxuanCapsule(cwd: string): SeedCapsuleL1 | null {
  const capsules = loadAllCapsules(cwd)
  const tianxuan = capsules.find(c => c.star === '天璇')
  if (!tianxuan) return null
  return { block: tianxuan.block, raw: tianxuan.raw }
}

/**
 * @deprecated 单胶囊渲染已被合并渲染替代。保留接口以兼容。
 */
export function renderCapsuleBlock(l1: SeedCapsuleL1): string {
  return l1.block
}

/** 清除缓存（主要用于测试） */
export function clearCapsuleCache(): void {
  cachedCapsules = null
  cachedCwd = null
}
