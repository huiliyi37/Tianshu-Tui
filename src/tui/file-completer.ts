import { execSync } from 'node:child_process'

export function extractAtToken(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^\s]*)$/)
  return match ? match[1]! : null
}

export function getCompletions(partial: string, cwd: string, limit: number): string[] {
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lower = partial.toLowerCase()
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter(f => f.toLowerCase().includes(lower))
      .sort((a, b) => {
        const aS = a.toLowerCase().startsWith(lower) ? 0 : 1
        const bS = b.toLowerCase().startsWith(lower) ? 0 : 1
        return aS - bS || a.length - b.length
      })
      .slice(0, limit)
  } catch {
    return []
  }
}

export function applyCompletion(text: string, cursorPos: number, completion: string): { text: string; cursor: number } {
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const atIdx = before.lastIndexOf('@')
  const newText = before.slice(0, atIdx) + '@' + completion + ' ' + after
  return { text: newText, cursor: atIdx + 1 + completion.length + 1 }
}
