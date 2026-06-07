import type { WorkOrderKind, WorkerProfile } from './work-order.js'

export interface TeamTaskDraft {
  id: string
  title: string
  objective: string
  files: string[]
  profile: WorkerProfile
  kind: WorkOrderKind
  verification: string[]
}

interface Section {
  id: string
  title: string
  content: string[]
}

const TASK_HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:\*\*)?(?:(Task\s+\d+[A-Za-z]?|T\d+[A-Za-z]?|Step\s+\d+[A-Za-z]?)(?:\s*[:：.\-–—]\s*|\s+)(.*)|((?:Task|Step)\s+\d+[A-Za-z]?|T\d+[A-Za-z]?))\*?\*?\s*$/i
const FILE_PATH_RE = /(?:`([^`]+)`|\b((?:src|docs|specs|test|tests|\.rivet)\/[\w./@+-]+(?:\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|css|scss))?))/g

function normalizeTaskId(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function stripLineNoise(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}|[-*]|\d+\.)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractFiles(text: string): string[] {
  const files: string[] = []
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const candidate = (match[1] ?? match[2] ?? '').trim()
    if (!candidate) continue
    if (!/^(src|docs|specs|test|tests|\.rivet)\//.test(candidate)) continue
    files.push(candidate.replace(/[),.;:]+$/g, ''))
  }
  return unique(files)
}

function classifyTask(text: string): Pick<TeamTaskDraft, 'profile' | 'kind'> {
  const lower = text.toLowerCase()
  if (/审查|验收|review|squadron|inspector/.test(lower)) {
    return { profile: 'reviewer', kind: 'review' }
  }
  if (/验证|测试|test|tsc|typecheck|verify|verification/.test(lower)) {
    return { profile: 'adversarial_verifier', kind: 'verify' }
  }
  if (/调研|搜索|查找|read|grep|scout|research|定位/.test(lower)) {
    return { profile: 'code_scout', kind: 'code_search' }
  }
  return { profile: 'patcher', kind: 'patch_proposal' }
}

function extractVerification(lines: string[]): string[] {
  return unique(lines
    .map(stripLineNoise)
    .filter(line => /\b(?:npm|npx|node|tsx|tsc)\b|验证|测试|typecheck|run_tests/i.test(line)))
}

function sectionToDraft(section: Section): TeamTaskDraft {
  const content = section.content.join('\n').trim()
  const objective = [section.title, content].filter(Boolean).join('\n').trim() || section.id
  const classification = classifyTask(objective)
  return {
    id: section.id,
    title: section.title || section.id,
    objective,
    files: extractFiles(objective),
    profile: classification.profile,
    kind: classification.kind,
    verification: extractVerification(section.content),
  }
}

export function parseTeamTaskDrafts(markdown: string): TeamTaskDraft[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(TASK_HEADING_RE)
    if (match) {
      if (current) sections.push(current)
      const rawId = match[1] ?? match[3] ?? 'Task'
      const tail = (match[2] ?? '').trim()
      const id = normalizeTaskId(rawId)
      current = { id, title: tail || id, content: [] }
      continue
    }
    if (current) current.content.push(line)
  }

  if (current) sections.push(current)
  return sections.map(sectionToDraft)
}

export function hasOverlappingFiles(a: TeamTaskDraft, b: TeamTaskDraft): boolean {
  if (a.files.length === 0 || b.files.length === 0) return false
  const bFiles = new Set(b.files)
  return a.files.some(file => bFiles.has(file))
}
