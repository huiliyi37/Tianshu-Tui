import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkAskMode, ASK_MODE_ALLOWED_TOOLS } from '../ask-mode.js'

describe('checkAskMode', () => {
  it('off state allows all tools', () => {
    assert.deepEqual(checkAskMode('off', 'write_file'), { allowed: true })
    assert.deepEqual(checkAskMode('off', 'bash'), { allowed: true })
    assert.deepEqual(checkAskMode('off', 'edit_file'), { allowed: true })
    assert.deepEqual(checkAskMode('off', 'plan'), { allowed: true })
  })

  it('asking state allows read-only and clarifying tools', () => {
    for (const tool of ASK_MODE_ALLOWED_TOOLS) {
      assert.deepEqual(checkAskMode('asking', tool), { allowed: true }, `${tool} should be allowed`)
    }
  })

  it('asking state blocks write / execute / plan / delegate', () => {
    const blocked = [
      'write_file', 'edit_file', 'apply_patch', 'hash_edit', 'bash',
      'plan', 'delegate_task', 'delegate_batch', 'run_tests',
    ]
    for (const tool of blocked) {
      const result = checkAskMode('asking', tool)
      assert.equal(result.allowed, false, `${tool} should be blocked`)
      assert.match(result.reason ?? '', /Ask Mode/)
    }
  })
})
