export interface PayloadSectionStat {
  id: string
  chars: number
  estimatedTokens: number
  lines: number
  present: boolean
}

export interface PayloadWasteCandidate {
  id: string
  reason: string
  chars: number
  recommendation: string
}

export interface VolatilePayloadReport {
  totalChars: number
  estimatedTokens: number
  sections: PayloadSectionStat[]
  wasteCandidates: PayloadWasteCandidate[]
}

const SECTION_RE = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/\1>)/g

export function estimateContextTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  return text.split('\n').length
}

function countActiveClaims(section: string): number | null {
  const match = section.match(/<active-claims\b[^>]*\bcount="(\d+)"/)
  if (!match) return null
  return Number.parseInt(match[1]!, 10)
}

function wasteCandidatesForSection(stat: PayloadSectionStat, sectionText: string): PayloadWasteCandidate[] {
  const candidates: PayloadWasteCandidate[] = []
  if (!stat.present) return candidates

  if (stat.id === 'project-instructions' && stat.chars > 6000) {
    candidates.push({
      id: stat.id,
      chars: stat.chars,
      reason: 'large stable volatile section',
      recommendation: 'split project instructions into always-on core plus task-routed details',
    })
  }

  if (stat.id === 'active-claims') {
    const count = countActiveClaims(sectionText) ?? 0
    if (stat.chars > 2500 || count > 8) {
      candidates.push({
        id: stat.id,
        chars: stat.chars,
        reason: count > 8 ? `${count} claims injected` : 'large active claims section',
        recommendation: 'apply active-claim relevance gate and keep only current-task claims',
      })
    }
  }

  if (stat.id === 'git-status' && stat.chars > 1200) {
    candidates.push({
      id: stat.id,
      chars: stat.chars,
      reason: 'large git status section',
      recommendation: 'summarize dirty file counts and show only task-relevant files by default',
    })
  }

  if (stat.id === 'historical-lessons' && stat.chars > 800) {
    candidates.push({
      id: stat.id,
      chars: stat.chars,
      reason: 'large historical lessons section',
      recommendation: 'rank playbook lessons by current task relevance before injection',
    })
  }

  return candidates
}

function stripOuterContext(block: string): string {
  const trimmed = block.trim()
  const match = trimmed.match(/^<context>\s*([\s\S]*?)\s*<\/context>$/)
  return match ? match[1]! : block
}

export function analyzeVolatilePayload(block: string): VolatilePayloadReport {
  const body = stripOuterContext(block)
  const sections = new Map<string, { id: string; text: string }>()
  for (const match of body.matchAll(SECTION_RE)) {
    const id = match[1]!
    if (id === 'context') continue
    const text = match[0]
    const existing = sections.get(id)
    if (existing) {
      sections.set(id, { id, text: `${existing.text}\n${text}` })
    } else {
      sections.set(id, { id, text })
    }
  }

  const stats = [...sections.values()]
    .map(section => ({
      id: section.id,
      chars: section.text.length,
      estimatedTokens: estimateContextTokens(section.text),
      lines: lineCount(section.text),
      present: true,
    }))
    .sort((a, b) => b.chars - a.chars || a.id.localeCompare(b.id))

  const wasteCandidates = stats.flatMap(stat => wasteCandidatesForSection(stat, sections.get(stat.id)?.text ?? ''))
  if (block.length > 12000) {
    wasteCandidates.push({
      id: 'total',
      chars: block.length,
      reason: 'large volatile payload',
      recommendation: 'enable context hygiene gates for claims, git status, lessons, and project instructions',
    })
  }

  return {
    totalChars: block.length,
    estimatedTokens: estimateContextTokens(block),
    sections: stats,
    wasteCandidates,
  }
}

function formatCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

export function formatVolatilePayloadReport(report: VolatilePayloadReport): string {
  const lines = [
    'Context Payload',
    `Total: ${formatCount(report.totalChars)} chars (~${formatCount(report.estimatedTokens)} tokens)`,
  ]

  if (report.sections.length === 0) {
    lines.push('Sections: none')
  } else {
    lines.push('Sections:')
    for (const section of report.sections) {
      lines.push(`  ${section.id.padEnd(22)} ${formatCount(section.chars).padStart(7)} chars  ~${formatCount(section.estimatedTokens).padStart(6)} tok  ${section.lines} lines`)
    }
  }

  if (report.wasteCandidates.length > 0) {
    lines.push('Waste candidates:')
    for (const candidate of report.wasteCandidates) {
      lines.push(`  ${candidate.id}: ${candidate.reason}; ${candidate.recommendation}`)
    }
  } else {
    lines.push('Waste candidates: none')
  }

  return lines.join('\n')
}
