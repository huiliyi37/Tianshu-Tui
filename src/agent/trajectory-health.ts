export type HealthSignal = 'healthy' | 'degrading' | 'escalate'

export interface TrajectoryHealthInput {
  recentEvents: Array<{ status: 'passed' | 'failed' | 'blocked'; turn: number }>
  currentTurn: number
  currentModel: 'flash' | 'pro'
}

export function assessTrajectoryHealth(input: TrajectoryHealthInput): HealthSignal {
  if (input.currentModel === 'pro') return 'healthy'

  const events = input.recentEvents
  if (events.length < 3) return 'healthy'

  const last5 = events.slice(-5)
  let consecutive = 0
  let maxConsecutive = 0
  for (const e of last5) {
    if (e.status === 'failed' || e.status === 'blocked') {
      consecutive++
      maxConsecutive = Math.max(maxConsecutive, consecutive)
    } else {
      consecutive = 0
    }
  }
  if (maxConsecutive >= 3) return 'escalate'

  const failCount5 = last5.filter(e => e.status === 'failed' || e.status === 'blocked').length
  if (failCount5 / last5.length > 0.8) return 'escalate'

  const last8 = events.slice(-8)
  const failCount8 = last8.filter(e => e.status === 'failed' || e.status === 'blocked').length
  if (last8.length >= 5 && failCount8 / last8.length > 0.6) return 'degrading'

  return 'healthy'
}
