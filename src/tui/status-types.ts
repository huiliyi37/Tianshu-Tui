export type CacheStatus = 'healthy' | 'degraded' | 'recovering' | 'stale'

export interface InterviewState {
  intent: string
  clarity: number
  round: number
  maxRounds: number
  tokensUsed: number
  confirmed: boolean
}
