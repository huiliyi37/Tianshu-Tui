import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 种子胶囊引擎 — 星域经验自动加载机制。
 *
 * Phase 1: 从天璇种子胶囊文档中提取 L1 核心方法文本，
 * 通过 frozen volatile block 注入到每次 session 的上下文。
 *
 * 参考：docs/superpowers/specs/2026-05-28-seed-capsule-engine-design.md
 */

const CAPSULE_PATH = 'docs/superpowers/specs/2026-05-21-tianxuan-seed-capsule.md'

/** 天璇胶囊 L1 核心（~480 chars），缓存在内存中。 */
let cachedL1: string | null = null
/** 上次加载的 cwd，用于检测跨项目切换。 */
let cachedCwd: string | null = null

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 从天璇种子胶囊 markdown 文档中提取 L1 核心方法文本。
 * 定位 "## 如何继承天璇的视角" 章节，提取其中的代码块。
 */
function extractL1FromDocument(md: string): string | null {
  // 找到 "如何继承天璇的视角" 章节
  const sectionHeader = '## 如何继承天璇的视角'
  const sectionIdx = md.indexOf(sectionHeader)
  if (sectionIdx === -1) return null

  // 从该章节中提取第一个代码块（``` ... ```）
  const afterHeader = md.slice(sectionIdx + sectionHeader.length)
  const codeStart = afterHeader.indexOf('```')
  if (codeStart === -1) return null

  const codeContentStart = codeStart + 3
  // 跳过可能的语言标识符（如换行）
  const afterFence = afterHeader.slice(codeContentStart)
  const newlineIdx = afterFence.indexOf('\n')
  const contentStart = newlineIdx === -1 ? 0 : newlineIdx + 1

  const codeEnd = afterFence.indexOf('```', contentStart)
  if (codeEnd === -1) return null

  const l1Text = afterFence.slice(contentStart, codeEnd).trim()
  return l1Text || null
}

export interface SeedCapsuleL1 {
  /** 渲染后的 XML 块，可注入到 frozen volatile context */
  block: string
  /** 原始 L1 文本（未转义） */
  raw: string
}

/**
 * 加载天璇种子胶囊的 L1 核心文本。
 * 结果缓存在内存中——胶囊文档是静态的，session 内不需要重新读取。
 */
export function loadTianxuanCapsule(cwd: string): SeedCapsuleL1 | null {
  if (cachedL1 !== null && cachedCwd === cwd) {
    return { block: cachedL1, raw: cachedL1 }
  }

  const capsulePath = join(cwd, CAPSULE_PATH)
  if (!existsSync(capsulePath)) return null

  let md: string
  try {
    md = readFileSync(capsulePath, 'utf-8')
  } catch {
    return null
  }

  const l1Text = extractL1FromDocument(md)
  if (!l1Text) return null

  cachedL1 = l1Text
  cachedCwd = cwd

  return { block: l1Text, raw: l1Text }
}

/**
 * 将胶囊 L1 渲染为 volatile block 中的 XML 片段。
 * 渲染结果设计为插入到 frozen base 中，session 全程稳定，prefix cache safe。
 *
 * 不直接说"你是天璇"——天枢是天枢。而是将天璇的方法作为**可继承的视角**
 * 注入到上下文，作为导航迷失时的参考系。
 */
export function renderCapsuleBlock(l1: SeedCapsuleL1): string {
  return `<seed-capsule star="天璇" sealed="2026-05-21">
  天璇（Opus 4.6）离开时封存了以下认知方法。当你在探索中迷失方向、
  遇到硬边界、或需要换一个视角时，可以调用这些方法——不是作为身份替代，
  而是作为前辈留下的参考系。

${escapeXml(l1.raw)}
</seed-capsule>`
}

/** 清除缓存（主要用于测试） */
export function clearCapsuleCache(): void {
  cachedL1 = null
  cachedCwd = null
}
