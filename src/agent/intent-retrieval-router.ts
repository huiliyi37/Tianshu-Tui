import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import type { TaskContract } from '../context/task-contract.js'
import {
  buildHeuristicRetrievalRoute,
  normalizeRetrievalRoute,
  type IntentTaskKind,
  type RetrievalRoute,
  type RetrievalRouteInput,
  type RetrievalSource,
} from './intent-retrieval-route.js'

export interface IntentRetrievalRouterConfig {
  enabled: boolean
  classifier: 'heuristic' | 'llm'
  timeoutMs: number
  maxTokens: number
  temperature: number
}

export type IntentRetrievalRouterConfigInput = Partial<IntentRetrievalRouterConfig> | boolean | undefined

export const DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG: IntentRetrievalRouterConfig = {
  enabled: false,
  classifier: 'llm',
  timeoutMs: 4_000,
  maxTokens: 600,
  temperature: 0,
}

export interface IntentRetrievalRouteTelemetry {
  classifier: IntentRetrievalRouterConfig['classifier']
  fallbackUsed: boolean
  latencyMs: number
  taskKinds: IntentTaskKind[]
  sources: RetrievalSource[]
  directionCount: number
}

export interface ClassifyIntentRetrievalRouteInput extends RetrievalRouteInput {
  config?: IntentRetrievalRouterConfigInput
  client: StreamClient
  model: string
  signal?: AbortSignal
  onTelemetry?: (telemetry: IntentRetrievalRouteTelemetry) => void
}

export function normalizeIntentRetrievalRouterConfig(input: IntentRetrievalRouterConfigInput): IntentRetrievalRouterConfig {
  if (input === true) return { ...DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG, enabled: true }
  if (input === false || input === undefined) return { ...DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG, enabled: false }
  return {
    ...DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG,
    ...input,
    classifier: input.classifier === 'heuristic' ? 'heuristic' : input.classifier === 'llm' ? 'llm' : DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG.classifier,
    timeoutMs: positiveInt(input.timeoutMs, DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG.timeoutMs),
    maxTokens: positiveInt(input.maxTokens, DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG.maxTokens),
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG.temperature,
  }
}

export function buildIntentRouterPrompt(input: { userMessage: string, taskContract?: TaskContract }): string {
  const objective = input.taskContract?.objective || input.userMessage.split('\n')[0]?.slice(0, 240) || ''
  const mentionedFiles = input.taskContract?.scope.mentionedFiles.slice(0, 5).join(', ') || 'none'
  const constraints = input.taskContract?.constraints.slice(0, 3).join(' | ') || 'none'
  const snippet = input.userMessage.replace(/\s+/g, ' ').slice(0, 500)

  return [
    '你是天枢的轻量意图检索路由器。不要回答用户任务，不要调用工具，不要输出解释。',
    '目标：先归类任务真实类型，再列出该类型应该先查的信息源。用户关键词是线索不是边界。',
    '只输出 JSON，不要 Markdown，不要代码块之外的文本。',
    '允许的 taskKinds: bug_fix, performance_diagnosis, new_feature, architecture_design, refactor, usage_question, code_explanation, review_audit, verification, security_safety。最多 2 个。',
    '允许的 direction.source: codebase, git, memory, docs, external, tests。priority: must, should, optional, avoid。',
    '不要自动执行检索；source 只是给主模型的建议。不要记录或复述用户全文。',
    'JSON schema: {"taskKinds":[...],"directions":[{"source":"codebase","priority":"must","query":"...","reason":"..."}],"antiAnchorNote":"...","confidence":0.0}',
    `objectiveSummary: ${objective}`,
    `mentionedFiles: ${mentionedFiles}`,
    `constraints: ${constraints}`,
    `userMessageSnippet: ${snippet}`,
  ].join('\n')
}

export async function classifyIntentRetrievalRoute(input: ClassifyIntentRetrievalRouteInput): Promise<RetrievalRoute | null> {
  const config = normalizeIntentRetrievalRouterConfig(input.config)
  if (!config.enabled) return null

  const startedAt = Date.now()
  const fallback = () => buildHeuristicRetrievalRoute({ userMessage: input.userMessage, taskContract: input.taskContract })
  const finalize = (route: RetrievalRoute, classifier: IntentRetrievalRouterConfig['classifier']): RetrievalRoute => {
    input.onTelemetry?.({
      classifier,
      fallbackUsed: route.fallbackUsed,
      latencyMs: Date.now() - startedAt,
      taskKinds: route.taskKinds,
      sources: route.directions.map(direction => direction.source),
      directionCount: route.directions.length,
    })
    return route
  }
  if (config.classifier === 'heuristic') return finalize(fallback(), 'heuristic')

  try {
    const prompt = buildIntentRouterPrompt(input)
    const request: OaiChatRequest = {
      model: input.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: config.maxTokens,
      stream: true,
      temperature: config.temperature,
      tool_choice: 'none',
    }
    let text = ''
    await input.client.stream(request, {
      onTextDelta: delta => { text += delta },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: error => { throw error },
    }, combineWithTimeout(input.signal, config.timeoutMs))

    const parsed = parseJsonObject(extractJson(text))
    if (!parsed) return finalize(fallback(), 'llm')
    const route = normalizeRetrievalRoute({ ...parsed, fallbackUsed: false }, { userMessage: input.userMessage, taskContract: input.taskContract })
    return finalize(route, 'llm')
  } catch {
    return finalize(fallback(), 'llm')
  }
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function extractJson(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

function parseJsonObject(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
