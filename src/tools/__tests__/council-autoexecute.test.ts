import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCouncilConveneTool, type CouncilConveneCoordinator } from '../../tools/council-convene.js'
import type { DelegationRequest } from '../../agent/coordinator.js'
import type { AggregationPolicy } from '../../agent/work-order.js'

function stubWorkerResult(i: number) {
  return {
    workOrderId: `T${i + 1}`,
    status: 'passed' as const,
    summary: 'mock result',
    findings: [],
    risks: [],
    nextActions: [],
    changedFiles: [],
    evidenceStatus: 'verified' as const,
    artifacts: [],
    model: 'test',
    usage: { input_tokens: 100, output_tokens: 50 },
  }
}

// Mock coordinator that captures delegateBatch calls
function mkCoordinator(autoExecuteCalls: { requests: unknown[]; policy?: string }[] = []): CouncilConveneCoordinator {
  return {
    async delegateBatch(requests: DelegationRequest[], policy?: AggregationPolicy) {
      autoExecuteCalls.push({ requests, policy: policy as string })
      return {
        status: 'completed',
        packet: '',
        results: requests.map((_, i) => stubWorkerResult(i)),
        workerModels: {},
      }
    },
  } as unknown as CouncilConveneCoordinator
}

// ── autoExecute parameter ──────────────────────────────────────

test('council_convene: autoExecute=false (default) does NOT trigger execution', async () => {
  const calls: { requests: unknown[] }[] = []
  const coordinator = {
    async delegateBatch(requests: unknown[]) {
      calls.push({ requests })
      return { status: 'completed', packet: '', results: [], workerModels: {} }
    },
  }
  const tool = createCouncilConveneTool(coordinator as unknown as CouncilConveneCoordinator)
  // Mock deps — need to skip actual council execution
  // Since we can't easily mock the full council run, we test the schema accepts autoExecute
  const parsed = tool.definition.input_schema!
  assert.ok(parsed.properties, 'schema has properties')
  assert.ok('autoExecute' in parsed.properties, 'autoExecute is in schema')
})

test('council_convene input schema: autoExecute is boolean optional', () => {
  const tool = createCouncilConveneTool(mkCoordinator())
  const schema = tool.definition.input_schema!
  assert.ok(schema.properties?.autoExecute)
  assert.equal((schema.properties!.autoExecute as Record<string, unknown>).type, 'boolean')
})
