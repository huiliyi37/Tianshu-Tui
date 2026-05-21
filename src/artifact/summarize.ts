import type { ArtifactSection } from './types.js'

export interface SummarizeResult {
  summary: string
  sections: ArtifactSection[]
}

interface NamedSpan {
  name: string
  lineIndex: number
}

const MAX_NAMES = 8

export function summarizeFileContent(content: string, filePath: string): SummarizeResult {
  const ext = extensionOf(filePath)
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return summarizeJsTs(content, filePath)
    case 'py':
      return summarizePython(content, filePath)
    case 'md':
    case 'markdown':
    case 'mdx':
      return summarizeMarkdown(content, filePath)
    case 'json':
      return summarizeJson(content, filePath)
    default:
      return summarizeFallback(content, filePath)
  }
}

export function summarizeGrepResult(content: string, pattern: string): SummarizeResult {
  const matches = content.split('\n').filter((line) => line.trim().length > 0)
  const files = unique(matches
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((file) => file.length > 0))

  const parts = [`grep "${pattern}": ${matches.length} matches in ${files.length} files.`]
  if (files.length > 0) {
    parts.push(`Files: ${formatList(files)}.`)
  }
  return { summary: parts.join(' '), sections: [] }
}

export function summarizeBashOutput(content: string, command: string, exitCode: number): SummarizeResult {
  const lines = content.length === 0 ? [] : content.split('\n')
  const status = exitCode === 0 ? 'success' : `failed (exit ${exitCode})`
  const parts = [`[${truncate(command, 60)}] ${status}, ${lines.length} lines.`]

  const testSummary = lines.find((line) => /(?:tests?|suites?).*(?:pass|fail|total)|(?:pass|fail).*(?:tests?|suites?)/i.test(line))
  if (testSummary) parts.push(truncate(testSummary.trim(), 120))

  if (exitCode !== 0) {
    const errorLines = lines
      .filter((line) => /\b(?:error|fail|failed|exception|traceback)\b/i.test(line))
      .slice(0, 3)
      .map((line) => truncate(line.trim(), 100))
    if (errorLines.length > 0) parts.push(`Errors: ${errorLines.join('; ')}`)
  }

  return { summary: parts.join(' '), sections: [] }
}

function summarizeJsTs(content: string, filePath: string): SummarizeResult {
  const lines = splitLines(content)
  const sections: ArtifactSection[] = []
  const exports: string[] = []
  const functions: string[] = []
  const classes: string[] = []
  const interfaces: string[] = []
  const imports = collectImportSection(lines)
  if (imports) sections.push(imports)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    const exportMatch = line.match(/^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/)
    if (exportMatch?.[1]) {
      exports.push(exportMatch[1])
      sections.push(sectionFor(lines, `export:${exportMatch[1]}`, i, findBlockEnd(lines, i)))
    }

    const namedExportMatch = line.match(/^export\s*\{([^}]+)\}/)
    if (namedExportMatch?.[1]) {
      for (const name of parseNamedExportList(namedExportMatch[1])) exports.push(name)
      sections.push(sectionFor(lines, 'exports', i, i))
    }

    const functionMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (functionMatch?.[1] && !exports.includes(functionMatch[1])) functions.push(functionMatch[1])

    const arrowFunctionMatch = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/)
    if (arrowFunctionMatch?.[1] && !exports.includes(arrowFunctionMatch[1])) functions.push(arrowFunctionMatch[1])

    const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/)
    if (classMatch?.[1] && !exports.includes(classMatch[1])) classes.push(classMatch[1])

    const interfaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/)
    if (interfaceMatch?.[1] && !exports.includes(interfaceMatch[1])) interfaces.push(interfaceMatch[1])
  }

  const ext = extensionOf(filePath) || 'text'
  const parts = [`${ext} file, ${lines.length} lines.`]
  if (exports.length > 0) parts.push(`Exports: ${formatList(unique(exports))}.`)
  if (functions.length > 0) parts.push(`Functions: ${formatList(unique(functions), 5)}.`)
  if (classes.length > 0) parts.push(`Classes: ${formatList(unique(classes))}.`)
  if (interfaces.length > 0) parts.push(`Interfaces: ${formatList(unique(interfaces))}.`)

  return { summary: parts.join(' '), sections }
}

function summarizePython(content: string, filePath: string): SummarizeResult {
  const lines = splitLines(content)
  const sections: ArtifactSection[] = []
  const imports = collectPythonImportSection(lines)
  if (imports) sections.push(imports)

  const classes: string[] = []
  const functions: string[] = []
  const asyncFunctions: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const classMatch = line.match(/^class\s+([A-Za-z_]\w*)/)
    if (classMatch?.[1]) {
      classes.push(classMatch[1])
      sections.push(sectionFor(lines, `class:${classMatch[1]}`, i, findPythonBlockEnd(lines, i)))
      continue
    }

    const fnMatch = line.match(/^(async\s+)?def\s+([A-Za-z_]\w*)/)
    if (fnMatch?.[2]) {
      if (fnMatch[1]) asyncFunctions.push(fnMatch[2])
      else functions.push(fnMatch[2])
      sections.push(sectionFor(lines, `function:${fnMatch[2]}`, i, findPythonBlockEnd(lines, i)))
    }
  }

  const parts = [`py file, ${lines.length} lines.`]
  if (classes.length > 0) parts.push(`Classes: ${formatList(classes)}.`)
  if (functions.length > 0) parts.push(`Functions: ${formatList(functions)}.`)
  if (asyncFunctions.length > 0) parts.push(`Async functions: ${formatList(asyncFunctions)}.`)
  if (parts.length === 1) parts.push('(language: py, low-detail summary — consider read_section)')

  return { summary: parts.join(' '), sections }
}

function summarizeMarkdown(content: string, filePath: string): SummarizeResult {
  const lines = splitLines(content)
  const headings: NamedSpan[] = []
  const title = lines.find((line) => line.trim().startsWith('# '))?.replace(/^#\s+/, '').trim()

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i]?.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch?.[2]) {
      headings.push({ name: headingMatch[2].trim(), lineIndex: i })
    }
  }

  const sections = headings.slice(0, MAX_NAMES).map((heading, index) => {
    const next = headings[index + 1]
    const end = next ? Math.max(heading.lineIndex, next.lineIndex - 1) : heading.lineIndex
    return sectionFor(lines, `heading:${heading.name}`, heading.lineIndex, end)
  })

  const parts = [`markdown file, ${lines.length} lines.`]
  if (title) parts.push(`Title: ${title}.`)
  if (headings.length > 0) parts.push(`Headings: ${formatList(headings.map((heading) => heading.name))}.`)
  if (headings.length === 0) parts.push('(language: markdown, low-detail summary — consider read_section)')

  return { summary: parts.join(' '), sections }
}

function summarizeJson(content: string, filePath: string): SummarizeResult {
  const lines = splitLines(content)
  try {
    const parsed = JSON.parse(content) as unknown
    const parts = [`json file, ${lines.length} lines.`]
    if (Array.isArray(parsed)) {
      parts.push(`Array with ${parsed.length} items.`)
      const sample = parsed[0]
      if (isPlainObject(sample)) parts.push(`Item keys: ${formatList(Object.keys(sample))}.`)
    } else if (isPlainObject(parsed)) {
      const keys = Object.keys(parsed)
      parts.push(`Keys: ${formatList(keys)}.`)
      const nested = keys
        .filter((key) => isPlainObject(parsed[key]) || Array.isArray(parsed[key]))
        .slice(0, MAX_NAMES)
      if (nested.length > 0) parts.push(`Nested: ${nested.join(', ')}.`)
    } else {
      parts.push(`Value type: ${typeof parsed}.`)
    }
    return { summary: parts.join(' '), sections: jsonSections(lines, parsed) }
  } catch {
    return {
      summary: `json file, ${lines.length} lines. Invalid JSON (language: json, low-detail summary — consider read_section)`,
      sections: [],
    }
  }
}

function summarizeFallback(content: string, filePath: string): SummarizeResult {
  const lines = splitLines(content)
  const ext = extensionOf(filePath) || 'unknown'
  const preview = lines
    .slice(0, 30)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('#'))
    .slice(0, 3)
    .map((line) => truncate(line, 80))

  const parts = [`${ext} file, ${lines.length} lines.`]
  if (preview.length > 0) parts.push(`Preview: ${preview.join(' | ')}.`)
  parts.push(`(language: ${ext}, low-detail summary — consider read_section)`)
  return { summary: parts.join(' '), sections: [] }
}

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  return content.split('\n')
}

function extensionOf(filePath: string): string {
  const baseName = filePath.split(/[\\/]/).pop() ?? filePath
  const index = baseName.lastIndexOf('.')
  return index >= 0 ? baseName.slice(index + 1).toLowerCase() : ''
}

function collectImportSection(lines: string[]): ArtifactSection | null {
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? ''
    if (/^(?:import\b|export\s+\{.*\}\s+from\b)/.test(trimmed)) {
      if (start === -1) start = i
      end = i
    } else if (start !== -1 && trimmed.length > 0) {
      break
    }
  }
  return start === -1 ? null : sectionFor(lines, 'imports', start, end)
}

function collectPythonImportSection(lines: string[]): ArtifactSection | null {
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? ''
    if (/^(?:from\s+\S+\s+import\s+|import\s+)/.test(trimmed)) {
      if (start === -1) start = i
      end = i
    } else if (start !== -1 && trimmed.length > 0) {
      break
    }
  }
  return start === -1 ? null : sectionFor(lines, 'imports', start, end)
}

function findBlockEnd(lines: string[], start: number): number {
  let depth = 0
  let sawBrace = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') {
        depth++
        sawBrace = true
      } else if (ch === '}') {
        depth--
        if (sawBrace && depth <= 0) return i
      }
    }
    if (!sawBrace && i > start && (lines[i]?.trim().length ?? 0) === 0) return i - 1
  }
  return Math.min(start + 20, Math.max(lines.length - 1, start))
}

function findPythonBlockEnd(lines: string[], start: number): number {
  const startLine = lines[start] ?? ''
  const baseIndent = indentationOf(startLine)
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) continue
    if (indentationOf(line) <= baseIndent) return i - 1
  }
  return lines.length - 1
}

function indentationOf(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0
}

function sectionFor(lines: string[], name: string, startIndex: number, endIndex: number): ArtifactSection {
  const safeEnd = Math.max(startIndex, Math.min(endIndex, lines.length - 1))
  return {
    name,
    lineStart: startIndex + 1,
    lineEnd: safeEnd + 1,
    charCount: lines.slice(startIndex, safeEnd + 1).join('\n').length,
  }
}

function jsonSections(lines: string[], parsed: unknown): ArtifactSection[] {
  if (!isPlainObject(parsed)) return []
  const sections: ArtifactSection[] = []
  const keys = Object.keys(parsed).slice(0, MAX_NAMES)
  for (const key of keys) {
    const lineIndex = lines.findIndex((line) => line.includes(`"${key}"`))
    if (lineIndex >= 0) sections.push(sectionFor(lines, `key:${key}`, lineIndex, lineIndex))
  }
  return sections
}

function parseNamedExportList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim() ?? '')
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part))
}

function formatList(items: string[], max = MAX_NAMES): string {
  const visible = items.slice(0, max).join(', ')
  return items.length > max ? `${visible} (+${items.length - max})` : visible
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
