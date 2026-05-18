export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'analyzing'
  | 'tool'
  | 'mcp'
  | 'compacting'
  | 'preflight'
  | 'waiting'

export type ActivityLifecycleStatus =
  | 'idle'
  | 'active'
  | 'stale'
  | 'completed'
  | 'failed'

export interface ActivityState {
  readonly phase: ActivityPhase
  readonly label?: string
  readonly startedAt: number
  readonly lastEventAt: number
  readonly completedAt?: number
  readonly sizeHint?: string
  readonly status: ActivityLifecycleStatus
}

export interface HeartbeatOptions {
  readonly label?: string
  readonly sizeHint?: string
}

export function createIdleActivity(now: number): ActivityState {
  return {
    phase: 'idle',
    startedAt: now,
    lastEventAt: now,
    status: 'idle',
  }
}

export function beginActivity(
  _state: ActivityState,
  phase: Exclude<ActivityPhase, 'idle'>,
  label: string,
  now: number,
  sizeHint?: string,
): ActivityState {
  return {
    phase,
    label,
    startedAt: now,
    lastEventAt: now,
    sizeHint,
    status: 'active',
  }
}

export function heartbeatActivity(
  state: ActivityState,
  now: number,
  options: HeartbeatOptions = {},
): ActivityState {
  if (state.phase === 'idle') {
    return state
  }

  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    lastEventAt: now,
    status: 'active',
  }
}

export function completeActivity(
  state: ActivityState,
  now: number,
  options: HeartbeatOptions = {},
): ActivityState {
  if (state.phase === 'idle') {
    return state
  }

  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    completedAt: now,
    lastEventAt: now,
    status: 'completed',
  }
}

export function failActivity(
  state: ActivityState,
  now: number,
  options: HeartbeatOptions = {},
): ActivityState {
  if (state.phase === 'idle') {
    return state
  }

  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    completedAt: now,
    lastEventAt: now,
    status: 'failed',
  }
}

export function clearActivity(
  _state: ActivityState,
  now: number,
): ActivityState {
  return {
    phase: 'idle',
    startedAt: now,
    lastEventAt: now,
    status: 'idle',
  }
}

// ── Display formatting helpers ────────────────────────────────────────

export function formatActivityDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

export function formatThinkingSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  const k = chars / 1000
  // Drop trailing .0
  return `${k}k`.replace(/\.0k$/, 'k')
}

const PHASE_LABELS: Record<ActivityPhase, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  streaming: 'Streaming answer',
  analyzing: 'Analyzing tool results',
  tool: 'Running tool',
  mcp: 'Waiting for MCP',
  compacting: 'Compacting context',
  preflight: 'Restoring session',
  waiting: 'Waiting for LLM',
}

export function activityPhaseLabel(phase: ActivityPhase): string {
  return PHASE_LABELS[phase]
}

const STALE_THRESHOLD_MS = 10_000

export function formatActivitySummary(
  activity: ActivityState,
  now: number,
): string | undefined {
  if (activity.status === 'idle') return undefined

  const label = activity.label ?? activityPhaseLabel(activity.phase)

  if (activity.status === 'completed') {
    const elapsed = (activity.completedAt ?? now) - activity.startedAt
    const sizePart = activity.sizeHint ? ` (${activity.sizeHint})` : ''
    return `${label} completed in ${formatActivityDuration(elapsed)}${sizePart}`
  }

  if (activity.status === 'failed') {
    const elapsed = (activity.completedAt ?? now) - activity.startedAt
    return `${label} failed after ${formatActivityDuration(elapsed)}`
  }

  // active or stale
  const elapsed = now - activity.startedAt
  const timeSinceEvent = now - activity.lastEventAt
  const parts: string[] = [`${label}… ${formatActivityDuration(elapsed)}`]

  if (timeSinceEvent >= STALE_THRESHOLD_MS) {
    parts.push(`no update ${formatActivityDuration(timeSinceEvent)}`)
  }

  if (activity.sizeHint) {
    parts.push(activity.sizeHint)
  }

  return parts.join(' · ')
}

// ── Projection cadence guard ──────────────────────────────────────────

export interface ProjectionDecisionInput {
  previousText?: string
  nextText?: string
  previousAt: number
  now: number
}

export function shouldProjectActivity(input: ProjectionDecisionInput): boolean {
  if (input.previousText !== input.nextText) return true
  return input.now - input.previousAt >= 1000
}

// ── Tool classification helpers ───────────────────────────────────────

export function classifyToolActivity(
  name: string,
  label?: string,
): { phase: Exclude<ActivityPhase, 'idle'>; label: string } {
  if (name.startsWith('mcp__')) {
    const segments = name.split('__')
    // mcp__<server>__<tool> — server is second segment, default to "server"
    const server = segments[1] ?? 'server'
    return { phase: 'mcp', label: `Waiting for MCP ${server}` }
  }
  return { phase: 'tool', label: label ?? 'Running tool' }
}

const ANALYZING_TOOLS = new Set(['read_file', 'bash'])
const ANALYZING_THRESHOLD = 12_000

export function shouldBeginAnalyzing({
  toolName,
  resultLength,
}: {
  toolName: string
  resultLength: number
}): boolean {
  return ANALYZING_TOOLS.has(toolName) && resultLength >= ANALYZING_THRESHOLD
}

// ── Tool activity labels ──────────────────────────────────────────────

export function toolActivityLabel(name: string, fallbackLabel: string): string {
  switch (name) {
    case 'read_file': return `Reading ${fallbackLabel.replace(/^read\s+/, '')}`
    case 'write_file': return `Writing ${fallbackLabel.replace(/^write\s+/, '')}`
    case 'edit_file': return `Editing ${fallbackLabel.replace(/^edit\s+/, '')}`
    case 'bash': return `Running ${fallbackLabel}`
    case 'grep':
    case 'glob':
    case 'diff': return `Searching ${fallbackLabel}`
    case 'run_tests': return 'Running tests'
    case 'delegate_task': case 'delegate_batch': return `Delegating ${fallbackLabel}`
    default: return `Running ${fallbackLabel || name}`
  }
}

export function analysisLabelForTool(name: string, label: string): string {
  if (name === 'read_file') return `Analyzing ${label.replace(/^read\s+/, '')}`
  return 'Analyzing tool results'
}
