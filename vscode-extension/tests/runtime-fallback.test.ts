import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runtimeVersionCandidates } from '../src/sidecar/runtime-versions.ts'

test('runtime 候选：当前版本在前，已发布回退去重接后', () => {
  assert.deepEqual(runtimeVersionCandidates('3.5.2', ['3.4.0']), ['3.5.2', '3.4.0'])
  assert.deepEqual(runtimeVersionCandidates('3.4.0', ['3.4.0']), ['3.4.0'])
  assert.deepEqual(runtimeVersionCandidates('3.5.2', ['3.5.2', '3.4.0', '']), ['3.5.2', '3.4.0'])
})
