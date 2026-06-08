import { STAR_DOMAINS, type StarDomainId } from '../agent/star-domain.js'
import type { TeamRunSummary } from '../agent/team-orchestrator.js'
import type { TeamTask } from '../agent/team-plan.js'
import type { TeamWave } from '../agent/team-grouping.js'
import type { WorkerResult } from '../agent/work-order.js'

export const TEAM_PANEL_UI_PREFIX = 'rivet:team-panel:v1:'

export type TeamPanelStatus = 'waiting' | 'running' | 'done' | 'blocked' | 'failed'

export interface TeamPanelTask {
  id: string
  title: string
  authority: string
  profile: string
  kind: string
  dependsOn: string[]
  riskTier: 'low' | 'medium' | 'high'
  files: string[]
  status: TeamPanelStatus
  /** Named partner-star identity when a worker explicitly carries one. */
  identity?: {
    name: string
    glyph: string
  }
  summary?: string
}

export interface TeamPanelWave {
  id: string
  taskIds: string[]
  risk: 'low' | 'medium' | 'high'
  reason: string
}

export interface TeamPanelModel {
  mode: 'standard' | 'max'
  currentWave: number
  totalWaves: number
  dispatched: number
  blocked: string[]
  waves: TeamPanelWave[]
  tasks: TeamPanelTask[]
  reviewVerdict?: string
}

function authorityForTask(task: Pick<TeamTask, 'profile' | 'objective'>): string {
  if (task.profile === 'patcher') return 'tianliang'
  if (task.profile === 'reviewer' || task.profile === 'adversarial_verifier') return 'tianquan'
  const lower = task.objective.toLowerCase()
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.keywords.some(keyword => lower.includes(keyword.toLowerCase()))) return id
  }
  return 'tianliang'
}

function partnerIdentityForTask(task: Pick<TeamTask, 'profile' | 'title' | 'objective'>): TeamPanelTask['identity'] | undefined {
  const text = `${task.title}\n${task.objective}`.toLowerCase()
  if (task.profile === 'adversarial_verifier' || /瑶光|yaoguang|↻|复现|verification/.test(text)) {
    return { name: '瑶光', glyph: '↻' }
  }
  if (/贪狼|tanlang|⊕|勘探|prospect|prospecting/.test(text)) {
    return { name: '贪狼', glyph: '⊕' }
  }
  return undefined
}

function matchesResult(taskId: string, result: WorkerResult): boolean {
  return result.workOrderId === `team:${taskId}`
    || result.workOrderId.endsWith(`:${taskId}`)
    || result.workOrderId === taskId
}

function taskStatus(taskId: string, currentWave: TeamWave | undefined, runResults: readonly WorkerResult[] | undefined): TeamPanelStatus {
  const result = runResults?.find(r => matchesResult(taskId, r))
  if (result) {
    if (result.status === 'passed') return 'done'
    if (result.status === 'blocked') return 'blocked'
    return 'failed'
  }
  return currentWave?.taskIds.includes(taskId) ? 'running' : 'waiting'
}

function taskSummary(taskId: string, runResults: readonly WorkerResult[] | undefined): string | undefined {
  return runResults?.find(r => matchesResult(taskId, r))?.summary
}

export function buildTeamPanelModel(summary: TeamRunSummary, currentWave = 0, reviewVerdict?: string): TeamPanelModel {
  const current = summary.waves[currentWave]
  return {
    mode: summary.mode,
    currentWave,
    totalWaves: summary.waves.length,
    dispatched: summary.dispatched,
    blocked: summary.blocked,
    waves: summary.waves.map(w => ({ id: w.id, taskIds: [...w.taskIds], risk: w.risk, reason: w.reason })),
    tasks: summary.tasks.map(task => ({
      id: task.id,
      title: task.title,
      authority: authorityForTask(task),
      profile: task.profile,
      kind: task.kind,
      dependsOn: [...task.dependsOn],
      riskTier: task.riskTier,
      files: [...task.files],
      status: taskStatus(task.id, current, summary.run?.results),
      identity: partnerIdentityForTask(task),
      summary: taskSummary(task.id, summary.run?.results),
    })),
    reviewVerdict,
  }
}

export function encodeTeamPanelModel(model: TeamPanelModel): string {
  return `${TEAM_PANEL_UI_PREFIX}${JSON.stringify(model)}`
}

export function decodeTeamPanelModel(value: string): TeamPanelModel | null {
  if (!value.startsWith(TEAM_PANEL_UI_PREFIX)) return null
  try {
    const parsed = JSON.parse(value.slice(TEAM_PANEL_UI_PREFIX.length)) as TeamPanelModel
    if (!parsed || !Array.isArray(parsed.waves) || !Array.isArray(parsed.tasks)) return null
    return parsed
  } catch {
    return null
  }
}

export function starFor(authority: string): { name: string; glyph: string; colorKey: 'primary' | 'secondary' | 'success' | 'warning' | 'error' } {
  const domain = STAR_DOMAINS[authority as StarDomainId]
  if (!domain) return { name: authority || '未知', glyph: '☆', colorKey: 'secondary' }
  return { name: domain.name, glyph: domain.uiPersona.glyph, colorKey: domain.uiPersona.accent }
}
