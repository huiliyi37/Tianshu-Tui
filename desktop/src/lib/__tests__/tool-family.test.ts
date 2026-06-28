import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getToolFamilyDefaultLines, shouldDefaultOpen } from '../tool-family.js'

describe('getToolFamilyDefaultLines', () => {
  it('maps run-family tools to 8 lines', () => {
    assert.equal(getToolFamilyDefaultLines('bash'), 8)
    assert.equal(getToolFamilyDefaultLines('run_tests'), 8)
    assert.equal(getToolFamilyDefaultLines('delegate_task'), 8)
  })

  it('maps find-family tools to 6 lines', () => {
    assert.equal(getToolFamilyDefaultLines('grep'), 6)
    assert.equal(getToolFamilyDefaultLines('glob'), 6)
    assert.equal(getToolFamilyDefaultLines('repo_map'), 6)
  })

  it('maps write-family tools to 20 lines', () => {
    assert.equal(getToolFamilyDefaultLines('write_file'), 20)
    assert.equal(getToolFamilyDefaultLines('edit_file'), 20)
  })

  it('maps read-family tools to 8 lines', () => {
    assert.equal(getToolFamilyDefaultLines('read_file'), 8)
  })

  it('maps other tools to 4 lines', () => {
    assert.equal(getToolFamilyDefaultLines('todo'), 4)
    assert.equal(getToolFamilyDefaultLines('ask_user_question'), 4)
    assert.equal(getToolFamilyDefaultLines('unknown_tool'), 4)
  })
})

describe('shouldDefaultOpen', () => {
  it('opens short results within threshold', () => {
    assert.equal(shouldDefaultOpen('bash', 5), true)
    assert.equal(shouldDefaultOpen('read_file', 8), true)
    assert.equal(getToolFamilyDefaultLines('write_file'), 20)
    assert.equal(shouldDefaultOpen('write_file', 20), true)
  })

  it('collapses long results beyond threshold', () => {
    assert.equal(shouldDefaultOpen('bash', 9), false)
    assert.equal(shouldDefaultOpen('grep', 7), false)
    assert.equal(shouldDefaultOpen('write_file', 21), false)
  })
})
