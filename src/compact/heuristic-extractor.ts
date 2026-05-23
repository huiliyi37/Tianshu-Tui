/**
 * Heuristic extractor — generates structured rules from compaction context using DeepSeek Flash.
 *
 * Replaces the regex-based decision/finding extraction in task-state.ts with
 * LLM-powered reflection that produces higher-quality, cross-session-reusable rules.
 */
import type { StreamClient } from '../api/stream-client.js'
import type { HeuristicRule } from './heuristic-store.js'

const EXTRACTION_PROMPT = `You are a coding agent reflection system. Analyze the following tool execution trajectory and extract reusable heuristic rules.

For each rule, output a JSON object with:
- pattern: a concise, actionable insight (1-2 sentences)
- antiPattern: what to avoid (optional, 1 sentence)
- category: one of "file-edit", "test", "api-call", "debug", "search", "build", "git"

Output a JSON array of rules. Extract 1-5 rules maximum. Only extract genuinely reusable insights, not task-specific facts.

Example output:
[{"pattern":"When editing TypeScript files, always run tsc --noEmit after to catch type errors early","antiPattern":"Don't assume edits are correct without type-checking","category":"file-edit"}]

Trajectory:
`

export interface ExtractionInput {
  /** Recent tool calls with their results (summarized). */
  toolCycles: { tool: string; target: string; resultSummary: string; success: boolean }[]
  /** The session ID for provenance. */
  sessionId?: string
}

export interface ExtractorConfig {
  client: StreamClient
  model?: string
}

/** Collect full text response from a streaming client. */
async function streamToText(client: StreamClient, request: Parameters<StreamClient['stream']>[0]): Promise<string> {
  let text = ''
  await client.stream(request, {
    onTextDelta: (chunk: string) => { text += chunk },
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
    onError: () => {},
  })
  return text
}

/**
 * Extract heuristic rules from a compaction trajectory using Flash.
 * Returns empty array on failure (graceful degradation).
 */
export async function extractHeuristics(
  input: ExtractionInput,
  config: ExtractorConfig,
): Promise<Omit<HeuristicRule, 'id' | 'hitCount' | 'createdAt'>[]> {
  if (input.toolCycles.length === 0) return []

  const trajectoryText = input.toolCycles
    .map((tc, i) => `${i + 1}. ${tc.tool}(${tc.target}) → ${tc.success ? '✓' : '✗'} ${tc.resultSummary.slice(0, 200)}`)
    .join('\n')

  try {
    const text = await streamToText(config.client, {
      model: config.model ?? 'deepseek-chat',
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT + trajectoryText },
        { role: 'user', content: 'Extract reusable heuristic rules from this trajectory. Output only the JSON array.' },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    })

    // Parse JSON from response (handle markdown code blocks)
    const trimmed = text.trim()
    const jsonStr = trimmed.startsWith('[') ? trimmed : (trimmed.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
    const parsed = JSON.parse(jsonStr) as Array<{ pattern: string; antiPattern?: string; category: string }>

    return parsed
      .filter(r => r.pattern && r.category)
      .slice(0, 5)
      .map(r => ({
        pattern: r.pattern.slice(0, 200),
        antiPattern: r.antiPattern?.slice(0, 150),
        category: r.category,
        confidence: 0.5,
        source: 'compaction' as const,
        sessionId: input.sessionId,
      }))
  } catch {
    return []
  }
}
