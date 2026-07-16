import type { WorkerSessionConfig } from '../../worker-session.js'
import { createReadOnlyWorkOrder } from '../../work-order.js'
import { PromptEngine } from '../../../prompt/engine.js'
import { ToolRegistry } from '../../../tools/registry.js'
import type { StreamClient } from '../../../api/stream-client.js'

export function makeWorkerConfig(
  over: Partial<WorkerSessionConfig>,
): WorkerSessionConfig {
  const promptEngine = new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/tmp' },
  })

  const toolRegistry = new ToolRegistry()

  return {
    order: createReadOnlyWorkOrder({
      parentTurnId: 'test-turn-1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'trace the authentication flow across multiple files in the codebase',
      scope: { files: ['a.ts'] },
      // Generous budget: under full-suite CPU contention a 5s wall-clock budget
      // gets eaten by event-loop starvation and the hard abort timer flips
      // results to blocked. Tests that exercise timeouts override this.
      budget: { timeoutMs: 60_000, maxRetries: 1, maxTurns: 2, maxTokens: 2048 },
    }),
    client: (over.client ?? makeNoopClient()) as StreamClient,
    promptEngine,
    toolRegistry,
    cwd: '/tmp',
    maxTurns: 2,
    contextWindow: 32_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    ...over,
  }
}

function makeNoopClient(): StreamClient {
  return {
    async stream(_req, cb, _signal) {
      cb.onTextDelta('{}')
      cb.onContentBlock({ type: 'text', text: '{}' } as never)
      cb.onStopReason('stop', {})
    },
  }
}
