/**
 * Constellation text formatters — pure, ANSI-free, render-layer only.
 *
 * These produce plain strings for the TUI static log / overlay. They are NEVER
 * fed back into the model context or system prompt, so they cannot perturb the
 * prefix cache.
 */
import type { ProjectConstellation, Milestone, MilestoneVerification } from './schema.js'

const VERIFY_GLYPH: Record<MilestoneVerification, string> = {
  verified: '✓',
  blocked: '⚠',
  failed: '✗',
  unverified: '·',
}

const TYPE_GLYPH: Record<Milestone['type'], string> = {
  feature: '✦',
  fix: '🔧',
  refactor: '♻',
  architecture: '◈',
  milestone: '●',
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mon = Math.floor(day / 30)
  return `${mon}mo ago`
}

function markLabel(m: Milestone): string {
  const { agentMark } = m
  return `${agentMark.domain ? agentMark.domain + '·' : ''}#${agentMark.numericId}·${agentMark.symbol}`
}

export function formatMilestoneLine(m: Milestone, now = Date.now()): string {
  const type = TYPE_GLYPH[m.type] ?? '●'
  const verify = VERIFY_GLYPH[m.verificationStatus] ?? '·'
  const files = m.filesChanged.length > 0 ? ` (${m.filesChanged.length}f)` : ''
  return `${type} ${verify} ${m.summary}${files} — ${markLabel(m)}, ${relativeTime(m.timestamp, now)}`
}

/** Render the full constellation view: skeleton + recent milestones. */
export function formatConstellationView(
  c: ProjectConstellation,
  opts: { recent?: number; now?: number; recognitionLine?: string } = {},
): string {
  const now = opts.now ?? Date.now()
  const recent = opts.recent ?? 10
  const lines: string[] = []

  lines.push(`✶ Constellation — ${c.name}`)
  lines.push('═'.repeat(Math.min(48, Math.max(20, c.name.length + 18))))

  // Skeleton
  const sk = c.skeleton
  if (sk.modules.length || sk.entryPoints.length || sk.techStack.length) {
    lines.push('')
    lines.push('Skeleton')
    if (sk.entryPoints.length) lines.push(`  entry: ${sk.entryPoints.join(', ')}`)
    if (sk.modules.length) {
      const mods = sk.modules.slice(0, 12).map(m => (m.role ? `${m.path} (${m.role})` : m.path))
      lines.push(`  modules: ${mods.join(', ')}${sk.modules.length > 12 ? ` …+${sk.modules.length - 12}` : ''}`)
    }
    if (sk.techStack.length) lines.push(`  stack: ${sk.techStack.join(', ')}`)
    if (sk.keyAbstractions.length) lines.push(`  abstractions: ${sk.keyAbstractions.join(', ')}`)
  }

  // Milestones
  lines.push('')
  lines.push(`Milestones (${c.milestones.length})`)
  if (c.milestones.length === 0) {
    lines.push('  (none yet — finish a session or use /constellation update)')
  } else {
    const tail = c.milestones.slice(-recent).reverse()
    for (const m of tail) lines.push(`  ${formatMilestoneLine(m, now)}`)
    if (c.milestones.length > recent) lines.push(`  … ${c.milestones.length - recent} earlier (use /constellation history)`)
  }

  if (c.architectureShifts.length) {
    lines.push('')
    lines.push(`Architecture shifts: ${c.architectureShifts.length}`)
    const lastShift = c.architectureShifts[c.architectureShifts.length - 1]!
    lines.push(`  latest: ${lastShift.summary} (${relativeTime(lastShift.timestamp, now)})`)
  }

  // Recent travelers — emergent recognition hints (no similarity computation).
  // If the caller didn't pass a recognitionLine, auto-generate from milestones.
  const recognition = opts.recognitionLine ?? formatRecentTravelers(c, 5)
  if (recognition) {
    lines.push('')
    lines.push(recognition)
  }

  return lines.join('\n')
}

/** Format recent travelers — last N milestones as symbol+domain+summary.
 *  Lets the agent emergently recognise familiar marks without computing similarity. */
function formatRecentTravelers(c: ProjectConstellation, count: number): string {
  if (c.milestones.length === 0) return ''
  const recent = c.milestones.slice(-count).reverse()
  const lines = recent.map(m => {
    const mark = m.agentMark
    const id = mark ? `#${mark.numericId}·${mark.symbol}` : ''
    const domain = mark?.domain ? `${mark.domain}` : ''
    const tag = [domain, id].filter(Boolean).join('·')
    return `  ${tag ? tag + ' — ' : ''}${m.summary.slice(0, 80)}`
  })
  return `Recent travelers:\n${lines.join('\n')}`
}

/** Render a longer history listing of milestones, newest first. */
export function formatConstellationHistory(
  c: ProjectConstellation,
  opts: { limit?: number; now?: number } = {},
): string {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 30
  if (c.milestones.length === 0) return 'No milestones recorded yet.'
  const lines: string[] = [`✶ Constellation history — ${c.name} (${c.milestones.length} total)`, '']
  const tail = c.milestones.slice(-limit).reverse()
  for (const m of tail) lines.push(formatMilestoneLine(m, now))
  if (c.milestones.length > limit) {
    lines.push('', `… ${c.milestones.length - limit} older milestones archived in .rivet/constellation.archive.jsonl`)
  }
  return lines.join('\n')
}
