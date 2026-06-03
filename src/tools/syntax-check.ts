import { transformSync } from 'esbuild'
import { extname } from 'path'

/**
 * esbuild parse-only syntax check for .ts/.tsx files.
 *
 * Runs after writeFileSync in edit_file / write_file / hash_edit.
 * Catches syntax errors (missing bracket, broken JSX, incomplete expression)
 * in ~2ms and embeds the warning directly into the ToolResult —
 * so the model sees the error immediately and can fix it in the next turn,
 * instead of discovering it 2–3 turns later via tsc.
 *
 * Returns null if the file is clean or not a .ts/.tsx file.
 * Returns a warning string if a syntax error is detected.
 */
export function syntaxCheck(filePath: string, content: string): string | null {
  const ext = extname(filePath)
  if (ext !== '.ts' && ext !== '.tsx') return null

  const loader = ext === '.tsx' ? 'tsx' : 'ts'
  try {
    transformSync(content, {
      loader,
      target: 'esnext',
      jsx: 'automatic',
    })
    return null
  } catch (err) {
    if (!(err instanceof Error)) return null

    // esbuild errors look like:
    //   Transform failed with 1 error:
    //   <stdin>:5:8: ERROR: Unexpected "}"
    // Extract just the useful lines.
    const lines = err.message.split('\n')
    // Find the line with "ERROR:" — that's the actionable part
    const errorLines = lines.filter(l => l.includes('ERROR:') || l.includes('error:'))
    const detail = errorLines.length > 0
      ? errorLines.join('\n')
      : lines.slice(1).join('\n') // skip "Transform failed with N error(s):"

    // Strip "<stdin>:" prefix to show just the location
    const cleaned = detail.replace(/<stdin>:/g, '')

    return `⚠️ Syntax error detected:\n${cleaned}\n\nFix this before proceeding — the file was written but will fail type checking.`
  }
}
