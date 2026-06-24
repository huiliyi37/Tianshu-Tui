import { transformSync } from 'esbuild'
import { extname } from 'path'

/**
 * Language-agnostic syntax and structural integrity check for written files.
 *
 * Runs after write in edit_file / write_file / hash_edit.
 * Catches syntax errors (missing bracket, broken JSX, unbalanced braces,
 * truncated JSON, unclosed HTML tags) in ~2ms per file and embeds the
 * warning directly into the ToolResult — so the model sees the error
 * immediately instead of discovering it 2–3 turns later.
 *
 * Supported: .ts .tsx .js .jsx (esbuild parser), .css (brace balance),
 * .html (tag balance), .json (JSON.parse).
 *
 * Returns null if clean or unsupported extension.
 * Returns a warning string if an integrity issue is detected.
 */
export function syntaxCheck(filePath: string, content: string): string | null {
  const ext = extname(filePath)

  // ── TypeScript/JavaScript via esbuild parser ──
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    const loaderMap: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
      '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    }
    const loader = loaderMap[ext] ?? 'js'
    try {
      transformSync(content, { loader, target: 'esnext', jsx: 'automatic' })
      return null
    } catch (err) {
      if (!(err instanceof Error)) return null
      const lines = err.message.split('\n')
      const errorLines = lines.filter(l => /ERROR:|error:/i.test(l))
      const detail = errorLines.length > 0
        ? errorLines.join('\n')
        : lines.slice(1).join('\n')
      const cleaned = detail.replace(/<stdin>:/g, '')
      return `⚠️ Syntax error detected in ${ext}:\n${cleaned}\n\nFix this before proceeding — the file was written but will fail at runtime.`
    }
  }

  // ── CSS: brace balance check ──
  if (ext === '.css') {
    let depth = 0
    let inString = false
    let stringChar = ''
    let inComment = false
    for (let i = 0; i < content.length; i++) {
      const c = content[i]
      const prev = content[i - 1] ?? ''
      if (inComment) {
        if (c === '/' && prev === '*') inComment = false
        continue
      }
      if (c === '/' && content[i + 1] === '*') { inComment = true; i++; continue }
      if (inString) {
        if (c === stringChar && prev !== '\\') inString = false
        continue
      }
      if (c === '"' || c === "'") { inString = true; stringChar = c; continue }
      if (c === '{') depth++
      if (c === '}') depth--
      if (depth < 0) {
        return `⚠️ CSS brace mismatch: unmatched '}' at position ${i}. Remove the extra closing brace.`
      }
    }
    if (depth > 0) {
      return `⚠️ CSS brace mismatch: ${depth} unmatched '{' (missing closing '}'). Check for unclosed blocks like @media or rule sets.`
    }
    return null
  }

  // ── HTML: basic tag balance ──
  if (ext === '.html' || ext === '.htm') {
    // Tags that don't need closing
    const voids = new Set([
      'area','base','br','col','embed','hr','img','input','link','meta',
      'param','source','track','wbr',
    ])
    const openTagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g
    const stack: { tag: string; pos: number }[] = []
    let match
    while ((match = openTagRe.exec(content)) !== null) {
      const full = match[0]
      const tag = match[1]!.toLowerCase()
      const isClose = full.startsWith('</')
      const isSelfClose = full.endsWith('/>')
      if (isSelfClose || voids.has(tag)) continue
      if (isClose) {
        if (stack.length === 0 || stack[stack.length - 1]!.tag !== tag) {
          const expected = stack.length > 0 ? stack[stack.length - 1]!.tag : 'nothing'
          return `⚠️ HTML tag mismatch: unexpected </${tag}> at position ${match.index} (expected </${expected}>)`
        }
        stack.pop()
      } else {
        stack.push({ tag, pos: match.index })
      }
    }
    if (stack.length > 0) {
      const unclosed = stack.map(s => `<${s.tag}>`).join(', ')
      return `⚠️ HTML tag mismatch: ${stack.length} unclosed tag(s): ${unclosed}. Add the missing closing tags.`
    }
    return null
  }

  // ── JSON: parse check ──
  if (ext === '.json') {
    try {
      JSON.parse(content)
      return null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `⚠️ Invalid JSON: ${msg}`
    }
  }

  return null
}
