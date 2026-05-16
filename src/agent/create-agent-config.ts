import { createDeepSeekClient } from '../api/deepseek.js'
import { PromptEngine } from '../prompt/engine.js'
import type { AgentConfig } from './loop.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../api/types.js'

export interface ModelSpec {
  id: string
  maxTokens: number
  contextWindow: number
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
}

export interface AgentConfigInput {
  apiKey: string
  model: ModelSpec
  cwd: string
  compact: CompactionConfig
  sessionId: string
  toolDefinitions: ToolDefinition[]
  compactModel?: ModelSpec
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual'
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'compactClient' | 'compactModel' | 'sessionId' | 'approvalMode' | 'autoReasoning'
> {
  const { model, apiKey, cwd } = input
  const thinkingBudget = model.reasoningEffort === 'max'
    ? 64000
    : Math.min(16000, Math.floor(model.contextWindow * 0.02))

  const client = createDeepSeekClient({
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
    thinkingBudget,
  })

  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { tools: input.toolDefinitions },
    volatileCtx: { cwd, sessionMemoryBlock: input.sessionMemoryBlock },
  })

  let compactClient: AgentConfig['compactClient']
  let compactModelId: string | undefined
  if (input.compactModel) {
    compactClient = createDeepSeekClient({
      apiKey,
      model: input.compactModel.id,
      reasoningEffort: input.compactModel.reasoningEffort,
      maxTokens: Math.min(2048, input.compactModel.maxTokens),
      thinkingBudget: 1024,
    })
    compactModelId = input.compactModel.id
  }

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    compactClient,
    compactModel: compactModelId,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    autoReasoning: true,
  }
}
