/**
 * SurgicalShaper — 外科手术式上下文整形器
 *
 * 吸收 ContextBuilder（.rivet/scratch/scout/codegraph/src/context/index.ts）
 * 的多层机制，对候选代码块做结构化裁剪：
 *   1. maxNodes / maxCodeBlocks 总量上限
 *   2. per-file ≤20%（max(5, ceil(maxNodes*0.2))），防单文件垄断
 *   3. 测试/样例文件 ≤15%（max(3, ceil(maxNodes*0.15))），非测试查询时降权
 *   4. roots 与直接邻居优先保留（kind 优先级排序：class/interface > method/function > property）
 *   5. 低置信 LOW_CONFIDENCE 诚实标注——引导改用精确符号查询
 *   6. 与 src/compact/constants.ts 字符预算协同：先结构化裁剪，后单块字符截断
 *
 * 纯函数、无副作用、无 IO——便于单测与复用。
 */

import { INLINE_TOOL_RESULT_MAX_CHARS } from '../compact/constants.js'

/**
 * 稳定哨兵串：低置信标注的标题。消费方（如 MCP 层/调用方）可检测它来调整措辞。
 * 与 codegraph 参考实现的 markers.ts 保持同一文本，便于跨模块统一识别。
 * 修改本文案属于破坏性哨兵变更——发射方与本模块的常量引用须同步。
 */
export const LOW_CONFIDENCE_MARKER = '### ⚠️ Low-confidence match'

// ─── 类型 ─────────────────────────────────────────────────────────

export interface SurgicalBlock {
  id: string
  filePath: string
  name: string
  kind: string // 'class' | 'interface' | 'method' | 'function' | 'property' | 'field' | 'variable' | ...
  content: string
  isRoot?: boolean
  score?: number
}

export interface SurgicalShapeOptions {
  /** 节点总量上限（决定 per-file / test cap 的分母） */
  maxNodes: number
  /** 最终保留的代码块数上限 */
  maxCodeBlocks: number
  /** 单块内容字符上限（结构化裁剪之后的字符截断） */
  maxCodeBlockSize: number
  /** 总字符预算，默认取 src/compact/constants.ts 的 INLINE_TOOL_RESULT_MAX_CHARS */
  maxTotalChars?: number
  /** 查询文本——用于低置信判定 */
  query?: string
  /** 查询本身是测试/样例相关（跳过测试文件降权） */
  isTestQuery?: boolean
}

export interface ShapeResult {
  /** 保留的代码块（顺序 = 保留优先级从高到低） */
  blocks: SurgicalBlock[]
  /** 被裁剪掉的块 id */
  evicted: string[]
  confidence: 'high' | 'low'
  lowConfidenceNote: string | null
}

// ─── 内部工具 ─────────────────────────────────────────────────────

/** kind → 优先级。class/interface 等类型定义 > method/function > 属性/字段/变量。 */
const KIND_PRIORITY: Record<string, number> = {
  class: 3,
  interface: 3,
  struct: 3,
  trait: 3,
  protocol: 3,
  enum: 3,
  method: 1,
  function: 1,
  property: 0,
  field: 0,
  variable: 0,
}

function priorityOf(block: SurgicalBlock): number {
  const rootBonus = block.isRoot ? 10 : 0
  const kind = KIND_PRIORITY[block.kind] ?? 0
  return rootBonus + kind
}

/** 测试/样例文件判定（与 codegraph isTestFile 语义对齐的轻量版）。 */
export function isTestFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const fileName = lower.split('/').pop() ?? ''
  // 文件名模式：test_foo.py / foo.test.ts / foo_spec.rb / FooTest.kt
  if (
    fileName.startsWith('test_') ||
    fileName.startsWith('test.') ||
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(fileName) ||
    /(?:test|tests|spec|specs)\.[a-z0-9]+$/.test(fileName)
  ) return true
  // 目录模式：__tests__ / tests / spec / fixtures / samples
  return /(^|\/)(__tests__|tests?|specs?|fixtures?|examples?|samples?)(\/|$)/.test(lower)
}

/** 从查询中提取 ≥3 字符的词项（低置信判定的最小有意义单位）。 */
function extractTerms(query: string): string[] {
  return query.split(/[^a-zA-Z0-9_]+/).filter(t => t.length >= 3)
}

/** 判断某词是否为「强标识符」——含大写字母或下划线（如 ShardSearchRequest / snake_case）。 */
function isDistinctiveIdentifier(word: string): boolean {
  return /[A-Z]/.test(word) || word.includes('_')
}

// ─── 主入口 ───────────────────────────────────────────────────────

/**
 * 对候选代码块做外科手术式整形。
 *
 * 流程（先结构化，后字符）：
 *   A. 按优先级排序（roots +10、kind 分级、score 降序）
 *   B. per-file cap：每个文件最多 ceil(maxNodes*0.2)（下限 5）块
 *   C. 测试/样例文件 cap：非测试查询时最多 ceil(maxNodes*0.15)（下限 3）块
 *   D. maxCodeBlocks 总量截断
 *   E. 每块 content 截断到 maxCodeBlockSize，总体不超过 maxTotalChars
 *   F. 低置信判定：多词查询仅命中通用词、无强标识符佐证 → 低置信标注
 */
export function shapeSurgicalContext(
  blocks: SurgicalBlock[],
  options: SurgicalShapeOptions,
): ShapeResult {
  const maxTotalChars = options.maxTotalChars ?? INLINE_TOOL_RESULT_MAX_CHARS
  const perFileCap = Math.max(5, Math.ceil(options.maxNodes * 0.2))
  const testCap = Math.max(3, Math.ceil(options.maxNodes * 0.15))

  // A. 排序：优先级高在前；同优先级按 score 降序，保持输入稳定序。
  const sorted = [...blocks]
    .map((b, idx) => ({ b, idx }))
    .sort((x, y) => {
      const p = priorityOf(y.b) - priorityOf(x.b)
      if (p !== 0) return p
      const s = (y.b.score ?? 0) - (x.b.score ?? 0)
      if (s !== 0) return s
      return x.idx - y.idx
    })
    .map(e => e.b)

  // B + C + D. 单遍贪心选择：per-file 计数 → test 计数 → 总量截断。
  const kept: SurgicalBlock[] = []
  const evicted: string[] = []
  const fileCounts = new Map<string, number>()
  let testCount = 0
  const isTestQuery = options.isTestQuery ?? false

  for (const block of sorted) {
    if (kept.length >= options.maxCodeBlocks) {
      evicted.push(block.id)
      continue
    }
    const fileCount = fileCounts.get(block.filePath) ?? 0
    if (fileCount >= perFileCap) {
      evicted.push(block.id)
      continue
    }
    const isTest = isTestFilePath(block.filePath)
    if (isTest && !isTestQuery && testCount >= testCap) {
      evicted.push(block.id)
      continue
    }
    fileCounts.set(block.filePath, fileCount + 1)
    if (isTest) testCount++
    kept.push(block)
  }

  // E. 字符预算：先结构化裁剪后截断。单块 clip 到 maxCodeBlockSize。
  //    若总量仍超 maxTotalChars，从低优先级尾部逐块摘除（字符预算优先于块数）。
  const clipped: SurgicalBlock[] = []
  let totalChars = 0
  for (const block of kept) {
    const truncated = block.content.length > options.maxCodeBlockSize
      ? block.content.slice(0, options.maxCodeBlockSize) + '\n... (truncated) ...'
      : block.content
    const sized = { ...block, content: truncated }
    if (totalChars + sized.content.length > maxTotalChars) {
      evicted.push(block.id)
      continue
    }
    totalChars += sized.content.length
    clipped.push(sized)
  }

  // F. 低置信判定（对齐 codegraph：多词查询且无强标识符佐证）。
  let confidence: 'high' | 'low' = 'high'
  if (options.query) {
    const terms = extractTerms(options.query)
    if (terms.length >= 2 && clipped.length > 0) {
      const distinctive = new Set(terms.filter(isDistinctiveIdentifier).map(t => t.toLowerCase()))
      const anyStrong = clipped.some(b => {
        if (distinctive.has(b.name.toLowerCase())) return true
        const nameLower = b.name.toLowerCase()
        const dirSegs = b.filePath.toLowerCase().split('/')
        let hits = 0
        for (const t of terms) {
          if (nameLower.includes(t) || dirSegs.includes(t)) {
            if (++hits >= 2) return true
          }
        }
        return false
      })
      if (!anyStrong) confidence = 'low'
    }
  }

  const lowConfidenceNote = confidence === 'low'
    ? `${LOW_CONFIDENCE_MARKER}\n\n`
      + 'This query matched mostly on common words, so the blocks above may be '
      + 'off-target — treat them as a starting point, not a complete answer.\n'
      + 'For a reliable result, query with the exact symbol names you are after '
      + '(class / function / method names) instead of prose.\n'
      + 'Do not assume the list above is comprehensive.'
    : null

  return { blocks: clipped, evicted, confidence, lowConfidenceNote }
}
