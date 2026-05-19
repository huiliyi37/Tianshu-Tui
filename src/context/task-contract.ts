export type ContractStatus =
  | 'exploring'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'blocked'
  | 'ready_to_deliver'

export interface TaskContract {
  id: string
  objective: string
  scope: {
    mentionedFiles: string[]
  }
  constraints: string[]
  successCriteria: string[]
  status: ContractStatus
  createdAtTurn: number
  updatedAtTurn: number
  isActionable: boolean
}

const FILE_PATTERN = /(?:^|\s)((?:src|lib|test|tests|pkg|cmd|internal|docs|scripts)\/[\w./-]+\.\w+)/g
const CONSTRAINT_MARKER_PATTERN = /\b(?:don'?t|must(?:n'?t)?|never)\b|不要|禁止|必须|不可以|不能/i
const CLAUSE_SPLIT_PATTERN = /[。.!?！？]+|[\n\r]+/g
const NON_ACTIONABLE_PATTERN = /^(?:hi|hello|hey|你好|您好|谢谢|多谢|ok|okay|了解|收到|辛苦了|thanks|thank you)[。.!！\s]*$/i
const STATUS_RANK: Record<Exclude<ContractStatus, 'blocked'>, number> = {
  exploring: 0,
  planning: 1,
  executing: 2,
  verifying: 3,
  ready_to_deliver: 4,
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function normalizeObjective(userMessage: string): string {
  const firstLine = userMessage.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 200 ? firstLine.slice(0, 197).trimEnd() + '...' : firstLine
}

function makeContractId(objective: string, turn: number): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `task-${turn}-${slug || 'untitled'}`
}

function isActionableObjective(objective: string, mentionedFiles: string[], constraints: string[]): boolean {
  if (mentionedFiles.length > 0 || constraints.length > 0) return true
  if (objective.length < 8) return false
  return !NON_ACTIONABLE_PATTERN.test(objective)
}

function defaultSuccessCriteria(objective: string): string[] {
  if (!objective) return []
  return [
    'requested behavior addressed',
    'relevant verification completed or explicitly marked unverified',
  ]
}

function extractConstraints(userMessage: string): string[] {
  const constraints: string[] = []
  for (const rawClause of userMessage.split(CLAUSE_SPLIT_PATTERN)) {
    const clause = rawClause.trim()
    if (!clause || !CONSTRAINT_MARKER_PATTERN.test(clause)) continue
    const text = clause.slice(0, 120)
    if (!constraints.includes(text)) constraints.push(text)
  }
  return constraints
}

export function extractTaskContract(userMessage: string, turn: number = 0): TaskContract {
  const objective = normalizeObjective(userMessage)

  const mentionedFiles: string[] = []
  for (const match of userMessage.matchAll(FILE_PATTERN)) {
    const file = match[1]
    if (file && !mentionedFiles.includes(file)) mentionedFiles.push(file)
  }

  const constraints = extractConstraints(userMessage)

  return {
    id: makeContractId(objective, turn),
    objective,
    scope: { mentionedFiles },
    constraints,
    successCriteria: defaultSuccessCriteria(objective),
    status: 'exploring',
    createdAtTurn: turn,
    updatedAtTurn: turn,
    isActionable: isActionableObjective(objective, mentionedFiles, constraints),
  }
}

export function advanceContractStatus(contract: TaskContract, nextStatus: ContractStatus, turn: number = contract.updatedAtTurn): TaskContract {
  if (contract.status === nextStatus) return contract
  if (nextStatus === 'blocked') return { ...contract, status: 'blocked', updatedAtTurn: turn }
  if (contract.status === 'blocked') return { ...contract, status: nextStatus, updatedAtTurn: turn }

  const currentRank = STATUS_RANK[contract.status]
  const nextRank = STATUS_RANK[nextStatus]
  if (nextRank < currentRank) return contract
  return { ...contract, status: nextStatus, updatedAtTurn: turn }
}

export function contractStatusFromPhaseClass(phaseClass: string): ContractStatus | undefined {
  switch (phaseClass) {
    case 'explore': return 'exploring'
    case 'plan': return 'planning'
    case 'execute': return 'executing'
    case 'verify': return 'verifying'
    case 'deliver': return 'ready_to_deliver'
    default: return undefined
  }
}

export function renderContractProjection(contract: TaskContract): string {
  if (!contract.isActionable) return ''

  const parts = [`<task-contract id="${escapeXml(contract.id)}" status="${contract.status}">`]
  parts.push(`  <objective>${escapeXml(contract.objective)}</objective>`)
  if (contract.scope.mentionedFiles.length > 0) {
    parts.push(`  <scope>${contract.scope.mentionedFiles.map(escapeXml).join(', ')}</scope>`)
  }
  for (const constraint of contract.constraints.slice(0, 3)) {
    parts.push(`  <constraint>${escapeXml(constraint)}</constraint>`)
  }
  for (const criterion of contract.successCriteria.slice(0, 2)) {
    parts.push(`  <success>${escapeXml(criterion)}</success>`)
  }
  parts.push('</task-contract>')
  return parts.join('\n')
}
