import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRAIN_TOOLS,
  HANDS_READ_TOOLS,
  HANDS_WRITE_TOOLS,
  HANDS_ALL_TOOLS,
  isBrainTool,
  isHandsTool,
  classifyProfile,
  type AgentRole,
} from '../coordination-policy.js'

describe('coordination policy', () => {
  it('Brain tools include delegate_task, delegate_batch, and exclude all concrete tools', () => {
    for (const t of ['delegate_task', 'delegate_batch']) {
      assert.ok((BRAIN_TOOLS as readonly string[]).includes(t), `Brain must include ${t}`)
    }
    for (const t of ['bash', 'edit_file', 'write_file', 'run_tests', 'read_file', 'grep', 'glob']) {
      assert.ok(!(BRAIN_TOOLS as readonly string[]).includes(t), `Brain must NOT include ${t}`)
    }
  })

  it('Hands read tools include all read-only primitives', () => {
    for (const t of ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests']) {
      assert.ok((HANDS_READ_TOOLS as readonly string[]).includes(t), `Hands read must include ${t}`)
    }
    assert.ok(!(HANDS_READ_TOOLS as readonly string[]).includes('delegate_task'), 'Hands must NOT include delegate_task')
  })

  it('Hands write tools include edit/write/bash/run_tests', () => {
    for (const t of ['edit_file', 'write_file', 'bash', 'run_tests']) {
      assert.ok((HANDS_WRITE_TOOLS as readonly string[]).includes(t), `Hands write must include ${t}`)
    }
  })

  it('HANDS_ALL_TOOLS is the union of read + write', () => {
    const union = [...HANDS_READ_TOOLS, ...HANDS_WRITE_TOOLS].sort()
    const all = [...HANDS_ALL_TOOLS].sort()
    assert.deepEqual(all, union)
  })

  it('classifyProfile returns "brain" for planner, "hands" for patcher/verifier, "readonly" for scouts', () => {
    assert.equal(classifyProfile('planner'), 'brain')
    assert.equal(classifyProfile('patcher'), 'hands')
    assert.equal(classifyProfile('verifier'), 'hands')
    assert.equal(classifyProfile('code_scout'), 'readonly')
    assert.equal(classifyProfile('reviewer'), 'readonly')
    assert.equal(classifyProfile('doc_scout'), 'readonly')
  })

  it('isBrainTool / isHandsTool gates correctly', () => {
    assert.equal(isBrainTool('delegate_task'), true)
    assert.equal(isBrainTool('delegate_batch'), true)
    assert.equal(isBrainTool('bash'), false)
    assert.equal(isBrainTool('edit_file'), false)
    assert.equal(isHandsTool('bash'), true)
    assert.equal(isHandsTool('edit_file'), true)
    assert.equal(isHandsTool('read_file'), true)
    assert.equal(isHandsTool('delegate_task'), false)
  })
})
