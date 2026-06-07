import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeamOrchestrateTool } from '../team-orchestrate.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'

function stubRun(packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results: [], packet }
}

test('team_orchestrate dispatches a standard plan first wave', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('dispatched') },
  })
  const md = [
    '### Task 1: edit foo',
    'Modify `src/agent/foo.ts`',
    '### Task 2: edit bar',
    'Modify `src/agent/bar.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'execute the plan deliberately', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-1',
  })
  assert.equal(result.isError, false)
  assert.equal(captured.length, 2)
  assert.match(result.content, /2 dispatched/)
})

test('team_orchestrate blocks a planPath outside the project', async () => {
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => stubRun(),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'x', planPath: '/etc/passwd' },
    cwd: process.cwd(),
    toolUseId: 'tu-2',
  })
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project|blocked/i)
})
