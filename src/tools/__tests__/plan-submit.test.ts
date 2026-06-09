import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_SUBMIT_TOOL } from '../plan-submit.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(tmpdir(), 'opencode-plan-submit-tool-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('plan_submit tool', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('writes submitted plans into .rivet/plans', async () => {
    const result = await PLAN_SUBMIT_TOOL.execute(makeParams({
      title: 'Spec Workflow Upgrade',
      plan: '## Problem description\n\nNeed workflow support.',
    }))

    assert.equal(result.isError, undefined)
    assert.match(result.content, /Plan submitted/)
    assert.match(result.content, /\.rivet\/plans\/spec-workflow-upgrade\.md/)

    const file = join(TEST_DIR, '.rivet', 'plans', 'spec-workflow-upgrade.md')
    const content = readFileSync(file, 'utf-8')
    assert.match(content, /^# Spec Workflow Upgrade/m)
    assert.match(content, /Need workflow support/)
  })

  it('requires dataflow closure sections for complex spec plans', () => {
    const description = PLAN_SUBMIT_TOOL.definition.description

    assert.match(description, /Spec\/dataflow closure/)
    assert.match(description, /fact-flow map/)
    assert.match(description, /condition matrix/)
    assert.match(description, /counterexample test table/)
    assert.match(description, /RED→GREEN/)
  })
})
