import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkflow, resolveVars, topoSort, runWorkflow, loadWorkflow, formatTrace, type WorkflowStep } from '../workflow-runner.js'

// ── parseWorkflow ──────────────────────────────────────────────

test('parseWorkflow: parses name + steps', () => {
  const yaml = `
name: safe-deliver
steps:
  - id: plan
    tool: council_convene
    input:
      objective: test
  - id: execute
    tool: team_orchestrate
    depends_on: [plan]
`
  const def = parseWorkflow(yaml)
  assert.equal(def.name, 'safe-deliver')
  assert.equal(def.steps.length, 2)
  assert.equal(def.steps[0]!.id, 'plan')
  assert.equal(def.steps[0]!.tool, 'council_convene')
  assert.equal(def.steps[1]!.id, 'execute')
  assert.deepEqual(def.steps[1]!.depends_on, ['plan'])
})

test('parseWorkflow: throws on missing name', () => {
  assert.throws(() => parseWorkflow('steps:\n  - id: a\n    tool: x'), /name/)
})

test('parseWorkflow: throws on step without tool', () => {
  assert.throws(() => parseWorkflow('name: t\nsteps:\n  - id: a'), /tool/)
})

// ── resolveVars ────────────────────────────────────────────────

test('resolveVars: resolves ${input} from ctx.inputs', () => {
  const ctx = { inputs: { objective: 'refactor auth' }, stepResults: {}, cwd: '/tmp' }
  assert.equal(resolveVars('do: ${objective}', ctx), 'do: refactor auth')
})

test('resolveVars: resolves ${step.field} from stepResults', () => {
  const ctx = { inputs: {}, stepResults: { plan: { planJson: '{"a":1}' } }, cwd: '/tmp' }
  assert.equal(resolveVars('${plan.planJson}', ctx), '{"a":1}')
})

test('resolveVars: leaves unknown refs as-is', () => {
  const ctx = { inputs: {}, stepResults: {}, cwd: '/tmp' }
  assert.equal(resolveVars('${unknown}', ctx), '${unknown}')
})

test('resolveVars: handles nested objects', () => {
  const ctx = { inputs: { x: 'val' }, stepResults: {}, cwd: '/tmp' }
  const result = resolveVars({ a: '${x}', b: ['${x}', 'static'] }, ctx)
  assert.deepEqual(result, { a: 'val', b: ['val', 'static'] })
})

// ── topoSort ───────────────────────────────────────────────────

test('topoSort: orders by dependencies', () => {
  const steps: WorkflowStep[] = [
    { id: 'c', tool: 't', depends_on: ['b'] },
    { id: 'a', tool: 't' },
    { id: 'b', tool: 't', depends_on: ['a'] },
  ]
  const sorted = topoSort(steps)
  const ids = sorted.map(s => s.id)
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('topoSort: detects circular dependency', () => {
  const steps: WorkflowStep[] = [
    { id: 'a', tool: 't', depends_on: ['b'] },
    { id: 'b', tool: 't', depends_on: ['a'] },
  ]
  assert.throws(() => topoSort(steps), /Circular/)
})

test('topoSort: throws on missing dependency', () => {
  const steps: WorkflowStep[] = [
    { id: 'a', tool: 't', depends_on: ['nonexistent'] },
  ]
  assert.throws(() => topoSort(steps), /unknown step/)
})

// ── runWorkflow ────────────────────────────────────────────────

test('runWorkflow: executes steps in order, resolves vars between steps', async () => {
  const calls: { tool: string; input: Record<string, unknown> }[] = []
  const def = parseWorkflow(`
name: chain
steps:
  - id: step1
    tool: tool_a
    input:
      msg: hello
  - id: step2
    tool: tool_b
    input:
      result: "\${step1.output}"
`)
  const executor = async (tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input })
    return { output: `${tool}-result` }
  }
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.tool, 'tool_a')
  assert.equal(calls[1]!.tool, 'tool_b')
  // step2 input should have step1's output resolved
  assert.equal(calls[1]!.input.result, 'tool_a-result')
  assert.equal(trace.finalStatus, 'done')
})

test('runWorkflow: stops on failure and records error', async () => {
  const def = parseWorkflow(`
name: fail-chain
steps:
  - id: a
    tool: fail_tool
    input: {}
  - id: b
    tool: never_runs
    depends_on: [a]
    input: {}
`)
  const executor = async () => ({ output: '', error: 'boom' })
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  assert.equal(trace.finalStatus, 'failed')
  assert.equal(trace.steps.length, 1) // b never runs
  assert.equal(trace.steps[0]!.status, 'failed')
  assert.equal(trace.steps[0]!.error, 'boom')
})

test('runWorkflow: skips steps with false condition', async () => {
  const def = parseWorkflow(`
name: conditional
steps:
  - id: always
    tool: t
    input: {}
  - id: maybe
    tool: t
    condition: false
    input: {}
`)
  const executor = async () => ({ output: 'ok' })
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  assert.equal(trace.finalStatus, 'done')
  const maybeStep = trace.steps.find(s => s.stepId === 'maybe')!
  assert.equal(maybeStep.status, 'skipped')
})

test('runWorkflow: records durationMs per step', async () => {
  const def = parseWorkflow('name: t\nsteps:\n  - id: a\n    tool: t\n    input: {}')
  const executor = async () => ({ output: 'ok' })
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  const step = trace.steps[0]!
  assert.ok(typeof step.durationMs === 'number')
  assert.ok(step.durationMs! >= 0)
})

test('runWorkflow: onProgress callback fires for each step', async () => {
  const def = parseWorkflow('name: t\nsteps:\n  - id: a\n    tool: t\n    input: {}')
  const progress: { stepId: string; status: string }[] = []
  const executor = async () => ({ output: 'ok' })
  await runWorkflow(def, {}, '/tmp', executor, (stepId, status) => progress.push({ stepId, status }))
  assert.equal(progress.length, 2) // running + done
  assert.equal(progress[0]!.status, 'running')
  assert.equal(progress[1]!.status, 'done')
})

test('runWorkflow: handles step without input field (no undefined leak)', async () => {
  const calls: { tool: string; input: Record<string, unknown> }[] = []
  const def = parseWorkflow(`
name: no-input
steps:
  - id: bare
    tool: tool_x
`)
  const executor = async (tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input })
    return { output: 'ok' }
  }
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  assert.equal(trace.finalStatus, 'done')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.input, {}, 'input should be empty object, not undefined')
})

test('runWorkflow: on_failure loops back and retries target step', async () => {
  let verifyCalls = 0
  const def = parseWorkflow(`
name: retry-loop
steps:
  - id: build
    tool: build_tool
    input: {}
  - id: verify
    tool: verify_tool
    depends_on: [build]
    on_failure: build
    input: {}
`)
  const executor = async (tool: string) => {
    if (tool === 'build_tool') return { output: 'built' }
    // verify_tool fails first time, succeeds second time
    verifyCalls++
    if (verifyCalls === 1) return { output: '', error: 'tests failed' }
    return { output: 'all green' }
  }
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  // build ran twice (initial + retry), verify ran twice (fail then pass)
  const builds = trace.steps.filter(s => s.stepId === 'build')
  const verifies = trace.steps.filter(s => s.stepId === 'verify')
  assert.equal(builds.length, 2, 'build should run twice (initial + loop-back)')
  assert.equal(verifies.length, 2, 'verify should run twice (fail then success)')
  assert.equal(verifyCalls, 2)
  assert.equal(trace.finalStatus, 'done')
})

test('runWorkflow: on_failure stops after MAX_RETRIES exhausted', async () => {
  const def = parseWorkflow(`
name: retry-exhaust
steps:
  - id: flaky
    tool: always_fail
    on_failure: flaky
    input: {}
`)
  const executor = async () => ({ output: '', error: 'never works' })
  const trace = await runWorkflow(def, {}, '/tmp', executor)
  assert.equal(trace.finalStatus, 'failed')
  // flaky runs MAX_RETRIES + 1 times: initial + 3 loop-backs
  const runs = trace.steps.filter(s => s.stepId === 'flaky')
  assert.equal(runs.length, 4, 'should run 4 times (initial + 3 retries)')
})

// ── formatTrace ────────────────────────────────────────────────

test('formatTrace: renders workflow name and step status', () => {
  const trace = {
    workflowName: 'test-wf',
    traceId: 'wf-test-abc',
    startedAt: Date.now(),
    endedAt: Date.now() + 1000,
    totalDurationMs: 1000,
    inputs: {},
    steps: [
      { stepId: 'a', tool: 't', status: 'done' as const, startedAt: Date.now(), durationMs: 500 },
      { stepId: 'b', tool: 't', status: 'failed' as const, startedAt: Date.now(), durationMs: 200, error: 'oops' },
    ],
    finalStatus: 'failed' as const,
  }
  const text = formatTrace(trace)
  assert.ok(text.includes('test-wf'))
  assert.ok(text.includes('✓ a'))
  assert.ok(text.includes('✗ b'))
  assert.ok(text.includes('oops'))
})

test('formatTrace: shows skipped steps with ⊘', () => {
  const trace = {
    workflowName: 't',
    traceId: 'wf-t',
    startedAt: Date.now(),
    inputs: {},
    steps: [{ stepId: 's', tool: 't', status: 'skipped' as const, startedAt: Date.now() }],
    finalStatus: 'done' as const,
  }
  assert.ok(formatTrace(trace).includes('⊘ s'))
})
