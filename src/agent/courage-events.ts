export type CourageType = 'risk-warning' | 'path-suggestion' | 'requirement-challenge' | 'direction-correction'
export type CourageOutcome = 'adopted' | 'rejected-reasonable' | 'rejected-proven-right' | 'marked-noise'

export interface CourageEvent {
  ts: number
  turn: number
  kind: 'courage-expressed'
  source: string
  detail: {
    type: CourageType
    outcome: CourageOutcome
  }
}

export function createCourageEvent(
  turn: number,
  type: CourageType,
  outcome: CourageOutcome,
  now: () => number = Date.now,
): CourageEvent {
  return {
    ts: now(),
    turn,
    kind: 'courage-expressed',
    source: 'local',
    detail: { type, outcome },
  }
}

export function computeBrightnessChange(outcome: CourageOutcome): number {
  switch (outcome) {
    case 'adopted':
      return 1
    case 'rejected-reasonable':
      return 0
    case 'rejected-proven-right':
      return 2
    case 'marked-noise':
      return -1
  }
}
