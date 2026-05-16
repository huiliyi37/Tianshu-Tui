export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'SubagentStop' | 'UserPromptSubmit' | 'PreCompact'

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

export interface UserPromptSubmitInput {
  prompt: string
}

export interface PreCompactInput {
  turnCount: number
  messageCount: number
}

export type HookInput<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseInput :
  E extends 'PostToolUse' ? PostToolUseInput :
  E extends 'Notification' ? NotificationInput :
  E extends 'SubagentStop' ? SubagentStopInput :
  E extends 'UserPromptSubmit' ? UserPromptSubmitInput :
  E extends 'PreCompact' ? PreCompactInput :
  never

export interface PreToolUseResult {
  input?: Record<string, unknown>
  block?: boolean
  reason?: string
}

export interface PostToolUseResult {
  result?: string
}

export interface UserPromptSubmitResult {
  prompt?: string
  block?: boolean
  reason?: string
}

export type HookResult<E extends HookEvent> =
  E extends 'PreToolUse' ? PreToolUseResult :
  E extends 'PostToolUse' ? PostToolUseResult :
  E extends 'UserPromptSubmit' ? UserPromptSubmitResult :
  Record<string, never>

export type HookHandler<E extends HookEvent> = (input: HookInput<E>) => HookResult<E>
