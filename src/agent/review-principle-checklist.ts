/**
 * Review Principle Checklist — 从 project memory 提取 review_principle 条目，
 * 按 changed files 生成非阻塞检查清单。
 *
 * 设计意图：
 * - 只提取 Kind 中包含 review_principle 的条目
 * - 按 Evidence path 匹配 changed files
 * - 生成的 checklist 不影响 Delivery Gate 判定
 *
 * @module review-principle-checklist
 */

export interface ReviewPrinciple {
  title: string
  claim: string
  appliesWhen: string[]
  reviewRule?: string
  evidence: string[]
}

export interface ReviewChecklistItem {
  source: string
  question: string
  reason: string
}

interface BuildChecklistInput {
  knowledgeMarkdown: string
  changedFiles: string[]
  maxItems?: number
}

export function extractReviewPrinciples(markdown: string): ReviewPrinciple[] {
  const entries = markdown.split(/(?=^### )/m).filter(entry => entry.trim())
  const principles: ReviewPrinciple[] = []
  for (const entry of entries) {
    const kind = extractField(entry, 'Kind')
    if (!kind || !kind.includes('review_principle')) continue
    const heading = entry.match(/^###\s+\d{4}-\d{2}-\d{2}\s+\u2014\s+(.+)$/m)
    const title = heading?.[1]?.trim()
    const claim = extractField(entry, 'Claim')
    if (!title || !claim) continue
    principles.push({
      title,
      claim,
      appliesWhen: extractListSection(entry, 'Applies when'),
      reviewRule: extractField(entry, 'Review rule'),
      evidence: extractCodePaths(extractListSection(entry, 'Evidence')),
    })
  }
  return principles
}

export function buildReviewPrincipleChecklist(input: BuildChecklistInput): ReviewChecklistItem[] {
  const changed = new Set(input.changedFiles.map(normalizePath))
  const items: ReviewChecklistItem[] = []
  for (const principle of extractReviewPrinciples(input.knowledgeMarkdown)) {
    const matchedEvidence = principle.evidence.find(path => changed.has(normalizePath(path)))
    if (!matchedEvidence) continue
    const rule = principle.reviewRule ?? principle.claim
    items.push({
      source: principle.title,
      question: rule,
      reason: `Changed file matches review-principle evidence path: ${matchedEvidence}`,
    })
  }
  return items.slice(0, input.maxItems ?? 5)
}

function extractField(entry: string, label: string): string | undefined {
  const re = new RegExp(`^\\*\\*${escapeRegExp(label)}\\*\\*:\\s*(.+)$`, 'im')
  return entry.match(re)?.[1]?.trim()
}

function extractListSection(entry: string, label: string): string[] {
  const escapedLabel = escapeRegExp(label)
  const startRe = new RegExp(`^\\*\\*${escapedLabel}\\*\\*:\\s*$`, 'im')
  const startMatch = entry.match(startRe)
  if (!startMatch?.[0]) return []
  
  const startIndex = entry.indexOf(startMatch[0]) + startMatch[0].length
  const remaining = entry.slice(startIndex)
  
  const lines: string[] = []
  for (const line of remaining.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^\*\*[^*]+\*\*:/.test(trimmed) || /^### /.test(trimmed)) break
    if (trimmed.startsWith('-')) {
      lines.push(trimmed.replace(/^-\s*/, '').trim())
    }
  }
  return lines.filter(Boolean)
}

function extractCodePaths(lines: string[]): string[] {
  return lines.map(line => line.match(/`([^`]+)`/)?.[1] ?? line).filter(path => path.includes('/'))
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
