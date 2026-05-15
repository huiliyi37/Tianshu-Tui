export interface SymbolEntry {
  name: string
  kind: 'function' | 'class' | 'type'
  file: string
  line: number
  exported: boolean
}

const SYMBOL_PATTERNS: Array<{ kind: SymbolEntry['kind']; regex: RegExp }> = [
  { kind: 'function', regex: /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', regex: /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: 'class', regex: /^(export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', regex: /^(export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/ },
]

export function buildSymbolIndexFromText(file: string, text: string): SymbolEntry[] {
  const entries: SymbolEntry[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    for (const pattern of SYMBOL_PATTERNS) {
      const match = trimmed.match(pattern.regex)
      if (match) {
        entries.push({
          name: match[2]!,
          kind: pattern.kind,
          file,
          line: i + 1,
          exported: Boolean(match[1]),
        })
        break
      }
    }
  }
  return entries
}
