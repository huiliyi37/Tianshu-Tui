import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkPlanMode, PLAN_MODE_ALLOWED_TOOLS, type PlanModeState } from '../plan-mode.js'

describe('checkPlanMode', () => {
  it('off state allows all tools', () => {
    assert.deepEqual(checkPlanMode('off', 'write_file'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'bash'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'edit_file'), { allowed: true })
  })

  it('approved state allows all tools', () => {
    assert.deepEqual(checkPlanMode('approved', 'edit_file'), { allowed: true })
    assert.deepEqual(checkPlanMode('approved', 'write_file'), { allowed: true })
  })

  it('planning state allows read-only tools', () => {
    const allowedTools = ['read_file', 'read_section', 'grep', 'glob', 'repo_map', 'inspect_project', 'todo', 'delegate_task', 'delegate_batch', 'diff', 'related_tests']
    for (const tool of allowedTools) {
      assert.deepEqual(checkPlanMode('planning', tool), { allowed: true }, `${tool} should be allowed`)
    }
  })

  it('planning state blocks write tools', () => {
    const blockedTools = ['write_file', 'edit_file', 'bash', 'run_tests']
    for (const tool of blockedTools) {
      const result = checkPlanMode('planning', tool)
      assert.equal(result.allowed, false, `${tool} should be blocked`)
      assert.ok(result.reason, `${tool} should have a reason`)
      assert.ok(result.reason!.includes('Plan Mode'), `${tool} reason should mention Plan Mode`)
    }
  })

  it('PLAN_MODE_ALLOWED_TOOLS is a frozen set', () => {
    assert.ok(PLAN_MODE_ALLOWED_TOOLS instanceof Set)
    assert.ok(PLAN_MODE_ALLOWED_TOOLS.has('read_file'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('write_file'))
  })
})
