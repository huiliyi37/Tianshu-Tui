export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'SubagentStop'

export interface PreToolUseInput {
  toolName: string
  input: Record<string, unknown>
}

export interface PostToolUseInput {
  toolName: string
  input: Record<string, unknown>
  result: string
  isError: boolean
}

export interface NotificationInput {
  message: string
  level: 'info' | 'warn' | 'error'
}

export interface SubagentStopInput {
  workOrderId: string
  status: string
}

export type HookInput<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseInput :
  E extends 'PostToolUse' ? PostToolUseInput :
  E extends 'Notification' ? NotificationInput :
  E extends 'SubagentStop' ? SubagentStopInput :
  never

export interface PreToolUseResult {
  input?: Record<string, unknown>
  block?: boolean
  reason?: string
}

export interface PostToolUseResult {
  result?: string
}

export type HookResult<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseResult :
  E extends 'PostToolUse' ? PostToolUseResult :
  Record<string, never>

export type HookHandler<E extends HookEvent> = (input: HookInput<E>) => HookResult<E>
