export type PromptMode = 'chat' | 'task'

export const DEFAULT_MODE: PromptMode = 'task'

export function shouldInjectCvm(mode: PromptMode): boolean {
  return mode === 'task'
}

export function shouldInjectDynamicAppendix(mode: PromptMode): boolean {
  return mode === 'task'
}

export function parsePromptMode(value: string | undefined): PromptMode | null {
  if (value === 'chat' || value === 'task') return value
  return null
}
