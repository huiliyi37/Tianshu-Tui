export interface Diagnostic {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

const TSC_PATTERN = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$/

export function parseDiagnosticOutput(output: string, _lang: string): Diagnostic[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const m = TSC_PATTERN.exec(line)
      if (!m) return null
      return {
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        col: parseInt(m[3]!, 10),
        severity: m[4] as 'error' | 'warning',
        message: m[5]!,
      }
    })
    .filter((d): d is NonNullable<typeof d> => d !== null) as Diagnostic[]
}

export function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return ''
  return diags.map(d => `${d.file}:${d.line}:${d.col} ${d.severity}: ${d.message}`).join('\n')
}
