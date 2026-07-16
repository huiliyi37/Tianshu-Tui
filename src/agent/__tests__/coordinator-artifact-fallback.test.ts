import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamClient } from '../../api/stream-client.js'
import { ArtifactStore } from '../../artifact/store.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import { DelegationCoordinator, type WorkerRuntimeFactory } from '../coordinator.js'
import { profileRegistry } from '../profile-registry.js'
import { deriveWorkerSessionId, READ_ONLY_WORKER_TOOLS } from '../work-order.js'

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry() {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  // Mirror the production base registry: every tool any built-in profile can
  // allowlist must exist, otherwise filterToolRegistry throws.
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

const cards: ModelCapabilityCard[] = [
  {
    model: 'fast-json',
    toolUseReliability: 0.6,
    jsonStability: 0.95,
    editSuccessRate: 0.4,
    testRepairRate: 0.5,
    contextWindow: 128_000,
    cacheEconomics: 'medium',
    recommendedTasks: ['code_search'],
  },
]

describe('DelegationCoordinator artifact fallback', () => {
  it('registers worker artifact session so primary store can read worker artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coordinator-artifact-fallback-'))
    try {
      const primaryStore = new ArtifactStore(dir, 'primary-session', {
        idGenerator: () => 'primary-id',
      })

      const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => ({
        order,
        client: {} as unknown as StreamClient,
        promptEngine: new PromptEngine({
          model: card.model,
          maxTokens: 1024,
          staticCtx: { tools: workerRegistry.getDefinitions() },
          volatileCtx: { cwd: '/repo' },
        }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      })

      let workerArtifactId: string | undefined
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 2,
        runtimeFactory,
        artifactStore: primaryStore,
        runWorker: async (config) => {
          // Same derivation as production runWorkerSession — nonce included,
          // so this test also guards the coordinator/worker sync contract.
          const workerSessionId = deriveWorkerSessionId(config.order.id, config.sessionNonce)
          const workerStore = new ArtifactStore(dir, workerSessionId, {
            idGenerator: () => 'worker-id',
          })
          workerArtifactId = await workerStore.save({
            tool: 'read_file',
            target: '/src/worker.ts',
            rawContent: 'worker result',
            summary: 'Worker artifact',
            sections: [],
          })
          return {
            result: {
              workOrderId: config.order.id,
              status: 'passed' as const,
              summary: 'completed',
              findings: [],
              artifacts: [],
              changedFiles: [],
              risks: [],
              nextActions: [],
              evidenceStatus: 'verified' as const,
            },
            transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
            session: { getTurnCount: () => 1 } as never,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }
        },
      })

      await coordinator.delegate({
        parentTurnId: 'turn-1',
        objective: 'Explore the codebase for relevant symbols and patterns',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/a.ts', 'src/b.ts'] },
      })

      assert.ok(workerArtifactId, 'worker artifact should have been saved')
      const resolved = primaryStore.get(workerArtifactId)
      assert.ok(resolved, 'primary store should resolve worker artifact via fallback')
      assert.equal(await primaryStore.readRaw(workerArtifactId), 'worker result')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
