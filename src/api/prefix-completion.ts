export interface PrefixDecisionInput {
  provider: string
  hasToolChoice: boolean
  enabled: boolean
}

export function shouldInjectPrefix(input: PrefixDecisionInput): boolean {
  return input.enabled && input.provider === 'deepseek' && !input.hasToolChoice
}

export interface PrefixMessage {
  role: 'assistant'
  content: string
  prefix: true
}

export function buildPrefixMessage(): PrefixMessage {
  return { role: 'assistant', content: '', prefix: true }
}
