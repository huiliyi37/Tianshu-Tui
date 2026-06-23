/**
 * Smart Code Folding — signature extraction + body collapse for large source files.
 *
 * When read_file encounters a large source file, instead of returning head+tail
 * fragments (which lose structural context), foldCode extracts the signature
 * skeleton: imports, type declarations, and function/class signatures with
 * their bodies collapsed to `{ … }`.
 *
 * Strategy: regex-based signature detection + brace-depth tracking. No native
 * AST dependency. Covers TS/JS/TSX/JSX/Python/JSON/Markdown. Unknown languages
 * fall back to existing head+tail truncation (wasFolded=false).
 */

import { extname } from 'node:path'

// ─── Types ───

type FoldableLanguage = 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'json' | 'md' | 'unknown'

export interface FoldOptions {
  filePath: string
  /** Soft line limit for the folded output. Default 200. */
  maxLines?: number
}

export interface FoldResult {
  /** Folded text (signature skeleton with collapsed bodies). */
  folded: string
  /** Original line count. */
  originalLines: number
  /** Folded output line count. */
  foldedLines: number
  /** Extracted signatures (for logging/debugging). */
  signatures: string[]
  /** Whether folding was actually performed. */
  wasFolded: boolean
}

// ─── Constants ───

const DEFAULT_MAX_LINES = 200
const MIN_LINES_TO_FOLD = 50
const MAX_SCAN_LINES = 3000
const TAIL_KEEP = 20

// ─── Language detection ───

function detectLanguage(filePath: string): FoldableLanguage {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, FoldableLanguage> = {
    '.ts': 'ts', '.tsx': 'tsx',
    '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py', '.pyi': 'py',
    '.json': 'json',
    '.md': 'md', '.mdx': 'md',
  }
  return map[ext] ?? 'unknown'
}

// ─── Brace counting (string/char-literal aware) ───

/**
 * Count net brace change in a line, ignoring braces inside string/char literals.
 * Does NOT handle regex literals or template literal interpolations — covers ~90%
 * of real-world cases. Misparses here cause at worst a wasFolded=false fallback.
 */
function countNetBraces(line: string): number {
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!

    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }

    if (inString) {
      if (ch === inString) inString = null
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }

  return depth
}

// ─── Signature classification (TS/JS family) ───

type LineClass = 'signature' | 'structural' | 'import' | 'other'

// Declarations with implementation bodies worth folding
const FUNCTION_LIKE = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s*\*?\s+\w+|const\s+\w+\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\(|class\s+\w+|get\s+\w+|set\s+\w+|constructor\s*\()/

// Structural declarations — keep body (it IS the type info)
const STRUCTURAL_DECL = /^\s*(export\s+)?(abstract\s+)?(interface\s+\w+|type\s+\w+\s*=|enum\s+\w+)/

// Import / re-export lines
const IMPORT_EXPORT = /^\s*(import\s|export\s(?:\{|\*|type|default))/

function classifyLine(line: string): LineClass {
  if (IMPORT_EXPORT.test(line)) return 'import'
  if (STRUCTURAL_DECL.test(line)) return 'structural'
  if (FUNCTION_LIKE.test(line)) return 'signature'
  return 'other'
}

/** Truncate a signature line for the signatures[] debug array. */
function truncateSig(line: string): string {
  const t = line.trim()
  return t.length > 120 ? t.slice(0, 117) + '...' : t
}

// ─── TS/JS/TSX/JSX folding ───

function foldTsLike(lines: string[], originalLines: number, maxLines: number): FoldResult {
  const output: string[] = []
  const signatures: string[] = []

  const scanLimit = Math.min(lines.length, MAX_SCAN_LINES)
  let braceDepth = 0
  let hadFold = false

  let i = 0
  while (i < scanLimit) {
    const line = lines[i]!
    const cls = classifyLine(line)
    const netBraces = countNetBraces(line)

    if (cls === 'import') {
      output.push(line)
      i++
      continue
    }

    if (cls === 'signature') {
      signatures.push(truncateSig(line))
      output.push(line)

      // Determine if a foldable block starts here
      const entryDepth = braceDepth
      let blockStartDepth: number | null = null

      if (netBraces > 0) {
        // Block opens on the same line: `function foo() {`
        blockStartDepth = braceDepth
        braceDepth += netBraces
        // If the line self-closes (net 0 after inner braces), don't fold
        if (braceDepth <= entryDepth) blockStartDepth = null
      } else if (i + 1 < scanLimit) {
        const nextLine = lines[i + 1]!
        const nextNet = countNetBraces(nextLine)
        if (nextLine.trim().startsWith('{') && nextNet > 0) {
          // Block opens on the next line
          blockStartDepth = braceDepth
          braceDepth += nextNet
          i++ // consume the `{` line
        }
      }

      if (blockStartDepth !== null && braceDepth > blockStartDepth) {
        hadFold = true
        // Scan forward until braces close back to entry depth
        while (i + 1 < scanLimit && braceDepth > blockStartDepth) {
          i++
          braceDepth += countNetBraces(lines[i]!)
        }
        braceDepth = Math.max(0, braceDepth)
        output.push('  { … }')
      }

      i++
      continue
    }

    if (cls === 'structural') {
      signatures.push(truncateSig(line))
      output.push(line)
      braceDepth += netBraces
      braceDepth = Math.max(0, braceDepth)
      i++
      continue
    }

    // other: top-level statements, or structural-body lines
    output.push(line)
    braceDepth += netBraces
    braceDepth = Math.max(0, braceDepth)
    i++
  }

  // Unscanned remainder
  if (scanLimit < originalLines) {
    output.push(`  … (${originalLines - scanLimit} more lines not scanned) …`)
  }

  // maxLines soft limit — head + omitted marker + tail
  if (output.length > maxLines) {
    const headCount = maxLines - TAIL_KEEP - 1
    const headPart = output.slice(0, headCount)
    const tailPart = output.slice(-TAIL_KEEP)
    const omitted = output.length - headCount - TAIL_KEEP
    output.length = 0
    output.push(...headPart, `  … (${omitted} lines omitted) …`, ...tailPart)
  }

  const folded = output.join('\n')

  return {
    folded,
    originalLines,
    foldedLines: output.length,
    signatures,
    wasFolded: hadFold && output.length < originalLines,
  }
}

// ─── Python folding ───

const PY_DEF = /^\s*(async\s+)?def\s+\w+/
const PY_CLASS = /^\s*class\s+\w+/
const PY_DECORATOR = /^\s*@/

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else break
  }
  return n
}

function foldPython(lines: string[], originalLines: number, maxLines: number): FoldResult {
  const output: string[] = []
  const signatures: string[] = []
  let hadFold = false

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // Decorator — keep, then check the def/class below
    if (PY_DECORATOR.test(line)) {
      output.push(line)
      i++
      continue
    }

    if (PY_DEF.test(line) || PY_CLASS.test(line)) {
      signatures.push(truncateSig(line))
      output.push(line)
      const defIndent = indentOf(line)

      // Fold the body (all lines with indent > defIndent)
      let bodyStart = i + 1
      let bodyEnd = bodyStart
      while (bodyEnd < lines.length) {
        const bodyLine = lines[bodyEnd]!
        if (bodyLine.trim() === '') { bodyEnd++; continue }
        if (indentOf(bodyLine) <= defIndent) break
        bodyEnd++
      }

      if (bodyEnd > bodyStart) {
        hadFold = true
        output.push('  { … }')
        i = bodyEnd
        continue
      }
      i++
      continue
    }

    output.push(line)
    i++
  }

  // maxLines truncation
  if (output.length > maxLines) {
    const headCount = maxLines - TAIL_KEEP - 1
    const headPart = output.slice(0, headCount)
    const tailPart = output.slice(-TAIL_KEEP)
    const omitted = output.length - headCount - TAIL_KEEP
    output.length = 0
    output.push(...headPart, `  … (${omitted} lines omitted) …`, ...tailPart)
  }

  return {
    folded: output.join('\n'),
    originalLines,
    foldedLines: output.length,
    signatures,
    wasFolded: hadFold && output.length < originalLines,
  }
}

// ─── JSON folding ───

function foldJson(content: string, originalLines: number): FoldResult {
  // For JSON, try to extract key structure
  try {
    const parsed = JSON.parse(content)
    const summary = JSON.stringify(jsonSkeleton(parsed), null, 2)
    const lines = summary.split('\n')
    return {
      folded: summary,
      originalLines,
      foldedLines: lines.length,
      signatures: [],
      wasFolded: lines.length < originalLines,
    }
  } catch {
    // Not valid JSON — don't fold
    return { folded: content, originalLines, foldedLines: originalLines, signatures: [], wasFolded: false }
  }
}

function jsonSkeleton(value: unknown, depth = 0): unknown {
  if (depth > 2) return '…'
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    return [`(${value.length} items)`, jsonSkeleton(value[0], depth + 1)]
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key]
      if (Array.isArray(v)) {
        result[key] = v.length > 0 ? `[${v.length} items]` : []
      } else if (v !== null && typeof v === 'object') {
        result[key] = depth < 1 ? jsonSkeleton(v, depth + 1) : '{ … }'
      } else {
        result[key] = typeof v
      }
    }
    return result
  }
  return typeof value
}

// ─── Markdown folding ───

function foldMarkdown(lines: string[], originalLines: number, maxLines: number): FoldResult {
  const output: string[] = []
  let hadFold = false

  for (const line of lines) {
    // Keep headings
    if (/^#{1,6}\s/.test(line)) {
      output.push(line)
      continue
    }
    // Keep first line after a heading (topic sentence)
    if (output.length > 0 && /^#{1,6}\s/.test(output[output.length - 1]!)) {
      output.push(line)
      continue
    }
    // Keep code fence markers
    if (line.trim().startsWith('```')) {
      output.push(line)
      continue
    }
    // Skip body text
    if (line.trim() !== '') {
      hadFold = true
    }
  }

  if (!hadFold || output.length >= originalLines) {
    return { folded: lines.join('\n'), originalLines, foldedLines: originalLines, signatures: [], wasFolded: false }
  }

  if (output.length > maxLines) {
    const headCount = maxLines - TAIL_KEEP - 1
    const headPart = output.slice(0, headCount)
    const tailPart = output.slice(-TAIL_KEEP)
    const omitted = output.length - headCount - TAIL_KEEP
    output.length = 0
    output.push(...headPart, `  … (${omitted} lines omitted) …`, ...tailPart)
  }

  return {
    folded: output.join('\n'),
    originalLines,
    foldedLines: output.length,
    signatures: [],
    wasFolded: true,
  }
}

// ─── Main entry point ───

/**
 * Fold source code into a signature skeleton with collapsed bodies.
 *
 * - TS/JS/TSX/JSX: brace-depth tracking, signature extraction
 * - Python: indentation tracking, def/class body collapse
 * - JSON: key structure skeleton
 * - Markdown: headings + topic sentences
 * - Unknown / short files: wasFolded=false (caller falls back to head+tail)
 */
export function foldCode(content: string, options: FoldOptions): FoldResult {
  const filePath = options.filePath
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const lang = detectLanguage(filePath)
  const lines = content.split('\n')
  const originalLines = lines.length

  if (originalLines < MIN_LINES_TO_FOLD) {
    return { folded: content, originalLines, foldedLines: originalLines, signatures: [], wasFolded: false }
  }

  switch (lang) {
    case 'unknown':
      return { folded: content, originalLines, foldedLines: originalLines, signatures: [], wasFolded: false }
    case 'json':
      return foldJson(content, originalLines)
    case 'md':
      return foldMarkdown(lines, originalLines, maxLines)
    case 'py':
      return foldPython(lines, originalLines, maxLines)
    default:
      return foldTsLike(lines, originalLines, maxLines)
  }
}
