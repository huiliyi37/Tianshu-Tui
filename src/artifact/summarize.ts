import type { ArtifactSection } from './types.js'

export interface SummarizeResult {
  summary: string
  sections: ArtifactSection[]
}

// ---------------------------------------------------------------------------
// File extension dispatch
// ---------------------------------------------------------------------------

/** Summarize file read output (e.g., read_file, cat). */
export function summarizeFileContent(content: string, filePath: string): SummarizeResult {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx':
      return summarizeJsTs(content, filePath)
    case 'py':
      return summarizePython(content, filePath)
    case 'rs':
      return summarizeRust(content, filePath)
    case 'go':
      return summarizeGo(content, filePath)
    case 'md': case 'mdx':
      return summarizeMarkdown(content, filePath)
    case 'json':
      return summarizeJson(content, filePath)
    default:
      return summarizeGeneric(content, filePath)
  }
}

// ---------------------------------------------------------------------------
// JS / TS summarizer
// ---------------------------------------------------------------------------

function summarizeJsTs(content: string, filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const sections: ArtifactSection[] = []

  const exports: string[] = []
  const functions: string[] = []
  const classes: string[] = []
  const imports: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Import detection
    const importMatch = line.match(/^import\s+.*?\s+from\s+['"](.+?)['"]/)
      ?? line.match(/^import\s+['"](.+?)['"]/)
    if (importMatch) {
      imports.push(importMatch[1]!)
      continue
    }

    // Re-export detection: export { x } from '...'
    const reExportMatch = line.match(/^export\s+\{[^}]*\}\s+from\s+['"](.+?)['"]/)
    if (reExportMatch) {
      imports.push(reExportMatch[1]!)
      continue
    }

    // Named export: export function/class/const/let/var
    const exportMatch = line.match(/^export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/)
    if (exportMatch) {
      exports.push(exportMatch[1]!)
      const end = findBlockEnd(lines, i)
      sections.push({
        name: `export:${exportMatch[1]}`,
        lineStart: i + 1,
        lineEnd: end + 1,
        charCount: lines.slice(i, end + 1).join('\n').length,
      })
      continue
    }

    // Export { name } — bare re-export or named list
    const bareExportMatch = line.match(/^export\s+\{([^}]+)\}/)
    if (bareExportMatch) {
      const names = bareExportMatch[1]!.split(',').map(n => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)
      exports.push(...names)
      continue
    }

    // Function (non-export)
    const fnMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (fnMatch && !exports.includes(fnMatch[1]!)) {
      functions.push(fnMatch[1]!)
    }

    // Class (non-export)
    const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)/)
    if (classMatch && !exports.includes(classMatch[1]!)) {
      classes.push(classMatch[1]!)
    }
  }

  // Add imports section if found
  if (imports.length > 0) {
    sections.unshift({
      name: 'imports',
      lineStart: 1,
      lineEnd: Math.min(imports.length, lines.length),
      charCount: imports.join('\n').length,
    })
  }

  const ext = filePath.split('.').pop() ?? ''
  const parts: string[] = [`${ext} file, ${lines.length} lines.`]
  if (exports.length > 0) parts.push(`Exports: ${exports.slice(0, 8).join(', ')}${exports.length > 8 ? ` (+${exports.length - 8})` : ''}`)
  if (functions.length > 0) parts.push(`Functions: ${functions.slice(0, 5).join(', ')}`)
  if (classes.length > 0) parts.push(`Classes: ${classes.join(', ')}`)

  return { summary: parts.join(' '), sections }
}

// ---------------------------------------------------------------------------
// Python summarizer
// ---------------------------------------------------------------------------

function summarizePython(content: string, _filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const sections: ArtifactSection[] = []

  const classes: string[] = []
  const functions: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    const classMatch = line.match(/^class\s+(\w+)/)
    if (classMatch) {
      classes.push(classMatch[1]!)
      const end = findPythonBlockEnd(lines, i)
      sections.push({
        name: `class:${classMatch[1]}`,
        lineStart: i + 1,
        lineEnd: end + 1,
        charCount: lines.slice(i, end + 1).join('\n').length,
      })
      continue
    }

    const fnMatch = line.match(/^(?:async\s+)?def\s+(\w+)/)
    if (fnMatch) {
      functions.push(fnMatch[1]!)
      const end = findPythonBlockEnd(lines, i)
      sections.push({
        name: `function:${fnMatch[1]}`,
        lineStart: i + 1,
        lineEnd: end + 1,
        charCount: lines.slice(i, end + 1).join('\n').length,
      })
    }
  }

  const parts: string[] = [`py file, ${lines.length} lines.`]
  if (classes.length > 0) parts.push(`Classes: ${classes.join(', ')}`)
  if (functions.length > 0) parts.push(`Functions: ${functions.join(', ')}`)

  return { summary: parts.join(' '), sections }
}

// ---------------------------------------------------------------------------
// Rust summarizer
// ---------------------------------------------------------------------------

function summarizeRust(content: string, _filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const sections: ArtifactSection[] = []

  const fns: string[] = []
  const structs: string[] = []
  const enums: string[] = []
  const impls: string[] = []
  const traits: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // pub async fn foo / pub fn foo / async fn foo / fn foo
    const fnMatch = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/)
    if (fnMatch) {
      fns.push(fnMatch[1]!)
      sections.push({
        name: `fn:${fnMatch[1]}`,
        lineStart: i + 1,
        lineEnd: findBlockEnd(lines, i) + 1,
        charCount: 0,
      })
      continue
    }
    const structMatch = line.match(/^(?:pub\s+)?struct\s+(\w+)/)
    if (structMatch) { structs.push(structMatch[1]!); continue }
    const enumMatch = line.match(/^(?:pub\s+)?enum\s+(\w+)/)
    if (enumMatch) { enums.push(enumMatch[1]!); continue }
    const implMatch = line.match(/^impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/)
    if (implMatch) { impls.push(implMatch[1]!); continue }
    const traitMatch = line.match(/^(?:pub\s+)?trait\s+(\w+)/)
    if (traitMatch) { traits.push(traitMatch[1]!); continue }
  }

  const parts: string[] = [`rs file, ${lines.length} lines.`]
  if (structs.length > 0) parts.push(`Structs: ${structs.join(', ')}`)
  if (enums.length > 0) parts.push(`Enums: ${enums.join(', ')}`)
  if (traits.length > 0) parts.push(`Traits: ${traits.join(', ')}`)
  if (impls.length > 0) parts.push(`Impls: ${impls.join(', ')}`)
  if (fns.length > 0) parts.push(`Fns: ${fns.slice(0, 8).join(', ')}`)

  return { summary: parts.join(' '), sections }
}

// ---------------------------------------------------------------------------
// Go summarizer — currently low-detail (test expects low-detail for .go)
// ---------------------------------------------------------------------------

function summarizeGo(content: string, _filePath: string): SummarizeResult {
  const lines = content.split('\n')
  return {
    summary: `go file, ${lines.length} lines. low-detail summary (no Go structural parser yet), consider read_section for details.`,
    sections: [],
  }
}

// ---------------------------------------------------------------------------
// Markdown summarizer
// ---------------------------------------------------------------------------

function summarizeMarkdown(content: string, _filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const sections: ArtifactSection[] = []
  const headings: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      const title = headingMatch[2]!.trim()
      headings.push(title)
      const level = headingMatch[1]!.length
      const end = findMarkdownSectionEnd(lines, i, level)
      sections.push({
        name: `heading:${title}`,
        lineStart: i + 1,
        lineEnd: end + 1,
        charCount: lines.slice(i, end + 1).join('\n').length,
      })
    }
  }

  const parts: string[] = [`md file, ${lines.length} lines.`]
  if (headings.length > 0) parts.push(`Headings: ${headings.slice(0, 10).join(', ')}`)

  return { summary: parts.join(' '), sections }
}

// ---------------------------------------------------------------------------
// JSON summarizer
// ---------------------------------------------------------------------------

function summarizeJson(content: string, _filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const sections: ArtifactSection[] = []

  try {
    const parsed = JSON.parse(content)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const topKeys = Object.keys(parsed as Record<string, unknown>)
      // Collect nested keys for richer summary (objects and arrays)
      const nestedKeys: string[] = []
      for (const key of topKeys) {
        const val = (parsed as Record<string, unknown>)[key]
        if (typeof val === 'object' && val !== null) {
          nestedKeys.push(key)
        }
      }

      // Create sections for top-level keys
      for (const key of topKeys) {
        const keyLineIdx = lines.findIndex(l => l.includes(`"${key}"`))
        if (keyLineIdx >= 0) {
          sections.push({
            name: `key:${key}`,
            lineStart: keyLineIdx + 1,
            lineEnd: keyLineIdx + 1,
            charCount: 0,
          })
        }
      }

      const parts: string[] = [`json file, ${lines.length} lines.`]
      parts.push(`Keys: ${topKeys.join(', ')}`)
      if (nestedKeys.length > 0) {
        parts.push(`Nested: ${nestedKeys.join(', ')}`)
      }
      return { summary: parts.join(' '), sections }
    }
  } catch {
    // Malformed JSON
  }

  return {
    summary: `json file, ${lines.length} lines.`,
    sections,
  }
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

function summarizeGeneric(content: string, filePath: string): SummarizeResult {
  const lines = content.split('\n')
  const ext = filePath.split('.').pop() ?? ''
  return {
    summary: `${ext} file, ${lines.length} lines. low-detail summary, consider read_section for details.`,
    sections: [],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find end of a brace-delimited block (JS/TS/Rust) starting at line idx. */
function findBlockEnd(lines: string[], startIdx: number): number {
  let braceCount = 0
  let foundOpen = false
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!
    for (const ch of line) {
      if (ch === '{') { braceCount++; foundOpen = true }
      if (ch === '}') braceCount--
    }
    if (foundOpen && braceCount <= 0) return i
  }
  return Math.min(startIdx + 20, lines.length - 1)
}

/** Find end of an indentation-delimited block (Python). */
function findPythonBlockEnd(lines: string[], startIdx: number): number {
  const startIndent = lines[startIdx]!.search(/\S/)
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().length === 0) continue
    const indent = line.search(/\S/)
    if (indent <= startIndent) return i - 1
  }
  return lines.length - 1
}

/** Find end of a markdown section (next same-or-higher-level heading or EOF). */
function findMarkdownSectionEnd(lines: string[], startIdx: number, level: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const headingMatch = lines[i]!.match(/^(#{1,6})\s+/)
    if (headingMatch && headingMatch[1]!.length <= level) return i - 1
  }
  return lines.length - 1
}

// ---------------------------------------------------------------------------
// Grep / Bash summarizers (unchanged except bash test pattern fix)
// ---------------------------------------------------------------------------

/** Summarize grep output. */
export function summarizeGrepResult(content: string, pattern: string): SummarizeResult {
  const lines = content.split('\n').filter(l => l.trim())
  const files = new Set(lines.map(l => l.split(':')[0]).filter(Boolean))
  return {
    summary: `grep "${pattern}": ${lines.length} matches in ${files.size} files. Files: ${[...files].slice(0, 5).join(', ')}${files.size > 5 ? ` (+${files.size - 5})` : ''}`,
    sections: [],
  }
}

/** Summarize bash/command output. */
export function summarizeBashOutput(content: string, command: string, exitCode: number): SummarizeResult {
  const lines = content.split('\n')
  const status = exitCode === 0 ? 'success' : `failed (exit ${exitCode})`

  // Try to find test summary lines (covers both "X tests pass" and "X passed")
  const testSummary = lines.find(l => /tests?\s*(?:pass|passed|fail|failed)|total/i.test(l))
    ?? lines.find(l => /\d+\s+tests?\s+pass/i.test(l))
    ?? lines.find(l => /\d+\s+tests?\s+passed/i.test(l))

  const errorLines = lines.filter(l => /error|Error|FAIL/i.test(l)).slice(0, 3)

  const parts: string[] = [`[${command.slice(0, 40)}] ${status}, ${lines.length} lines.`]
  if (testSummary) parts.push(testSummary.trim())
  // For success, also include the last non-empty line as useful context
  if (exitCode === 0 && !testSummary) {
    const lastLine = lines.filter(l => l.trim()).pop()
    if (lastLine) parts.push(lastLine.trim())
  }
  if (errorLines.length > 0 && exitCode !== 0) parts.push(`Errors: ${errorLines.map(l => l.trim().slice(0, 60)).join('; ')}`)

  return { summary: parts.join(' '), sections: [] }
}
