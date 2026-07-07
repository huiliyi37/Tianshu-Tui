/**
 * VSW: run_tests two-phase (Phase A isolated + Phase B integration) tagging.
 *
 * Both phases run in the same temp dir here — the worktree build itself is
 * covered by verification-snapshot.test.ts; this validates that run_tests
 * produces an isolated primary verification tagged with snapshotRef, plus an
 * integration extra verification, and that Phase A governs isError.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import type { ToolCallParams } from '../types.js'

const tempDirs: string[] = []
function makeProject(testBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-2p-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { test: 'tsx --test' },
  }))
  mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
  writeFileSync(join(dir, 'src', '__tests__', 'sample.test.js'), testBody)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function params(dir: string, over: Partial<ToolCallParams> = {}): ToolCallParams {
  return {
    input: { filter: 'src/__tests__/sample.test.js' },
    toolUseId: 'tu-1',
    cwd: dir,
    ...over,
  }
}

/**
 * run_tests spawns a child `node --test`. When THIS suite runs under the
 * node:test runner, NODE_TEST_CONTEXT=child-v8 is inherited by that child,
 * making it run in nested-child mode (exits 0, serializer output) instead of
 * actually running + failing. Production never spawns run_tests under a test
 * runner; strip the var around the call so the child behaves normally.
 */
async function runTool(p: ToolCallParams) {
  const saved = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  try {
    return await RUN_TESTS_TOOL.execute(p)
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved
  }
}

const PASSING = `import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('ok', () => { assert.equal(1, 1) })\n`
// Module-load throw → non-zero exit regardless of nested node:test runner
// context (a passing/failing assertion inside test() is suppressed when this
// suite spawns a child under the parent test runner; a load error is not).
const FAILING = `throw new Error('module load failure')\n`

describe('run_tests VSW two-phase', () => {
  it('tags Phase A isolated + Phase B integration with the snapshotRef when both pass', async () => {
    const dir = makeProject(PASSING)
    const result = await runTool(params(dir, {
      verificationSnapshot: { path: dir, snapshotRef: 'head+diff123' },
    }))

    assert.equal(result.isError ?? false, false)
    assert.equal(result.verification?.verificationPhase, 'isolated')
    assert.equal(result.verification?.snapshotRef, 'head+diff123')
    assert.ok(result.extraVerifications && result.extraVerifications.length === 1)
    assert.equal(result.extraVerifications![0]!.verificationPhase, 'integration')
    assert.equal(result.extraVerifications![0]!.snapshotRef, 'head+diff123')
    assert.match(result.content, /Phase A · isolated snapshot/)
    assert.match(result.content, /Phase B · integration on current HEAD\] passed/)
  })

  it('Phase A failure governs isError (blocking gate)', async () => {
    const dir = makeProject(FAILING)
    const result = await runTool(params(dir, {
      verificationSnapshot: { path: dir, snapshotRef: 'r1' },
    }))
    assert.equal(result.isError, true)
    assert.equal(result.verification?.verificationPhase, 'isolated')
    assert.equal(result.verification?.snapshotRef, 'r1')
    assert.notEqual(result.verification?.status, 'passed')
  })

  it('without a verificationSnapshot plan, runs a single in-place phase (no tagging)', async () => {
    const dir = makeProject(PASSING)
    const result = await runTool(params(dir))
    assert.equal(result.isError ?? false, false)
    assert.equal(result.verification?.verificationPhase, undefined)
    assert.equal(result.verification?.snapshotRef, undefined)
    assert.equal(result.extraVerifications, undefined)
  })
})
