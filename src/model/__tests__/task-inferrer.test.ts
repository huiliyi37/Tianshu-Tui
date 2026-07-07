import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inferTaskType } from '../task-inferrer.js'

describe('inferTaskType', () => {
  it('returns null for empty input', () => {
    assert.equal(inferTaskType([]), null)
  })

  it('returns null for unmatched patterns', () => {
    assert.equal(inferTaskType([{ name: 'bash', isError: false }]), null)
  })

  it('infers code_edit from edit_file', () => {
    const result = inferTaskType([{ name: 'edit_file', isError: false }])
    assert.deepEqual(result?.task, 'code_edit')
    assert.ok(result!.reason.includes('edit'))
  })

  it('infers test_failure_diagnosis from failed run_tests', () => {
    const result = inferTaskType([
      { name: 'run_tests', isError: true },
    ])
    assert.deepEqual(result?.task, 'test_failure_diagnosis')
  })

  it('infers risky_refactor from multi-file edit + test', () => {
    const result = inferTaskType([
      { name: 'edit_file', isError: false },
      { name: 'edit_file', isError: false },
      { name: 'run_tests', isError: false },
    ])
    assert.deepEqual(result?.task, 'risky_refactor')
  })

  it('prefers test_failure_diagnosis over code_edit when both match', () => {
    const result = inferTaskType([
      { name: 'edit_file', isError: false },
      { name: 'run_tests', isError: true },
    ])
    assert.deepEqual(result?.task, 'test_failure_diagnosis')
  })

  it('infers repo_summarization from search-heavy pattern', () => {
    const result = inferTaskType([
      { name: 'grep', isError: false },
      { name: 'glob', isError: false },
      { name: 'read_file', isError: false },
    ])
    assert.deepEqual(result?.task, 'repo_summarization')
  })

  it('does not infer repo_summarization with edits', () => {
    const result = inferTaskType([
      { name: 'grep', isError: false },
      { name: 'glob', isError: false },
      { name: 'read_file', isError: false },
      { name: 'edit_file', isError: false },
    ])
    assert.equal(result?.task, 'code_edit')
  })
})
