import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_TESTS_TOOL, parseOutput } from '../run-tests.js'
import { invalidateVerifyConfig } from '../../config/verify-config.js'
import { makeTestDir } from './_test-tmp.js'

// output-store rawDir() 受 TMPDIR 控制（见 run-tests.test.ts 同款处理）。
const FAKE_TMP = mkdtempSync(join(process.cwd(), '.test-tmp', 'fake-tmp-declared-'))
process.env.TMPDIR = FAKE_TMP
process.env.TMP = FAKE_TMP
process.env.TEMP = FAKE_TMP

after(() => {
  rmSync(FAKE_TMP, { recursive: true, force: true })
  invalidateVerifyConfig()
})

function makeParams(input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return { input, toolUseId: `declared-${Math.random().toString(36).slice(2)}`, cwd }
}

/** Project with only a declared verify.test — no package.json, no python markers. */
function setupDeclaredProject(testCommand: string): string {
  const dir = makeTestDir('run-tests-declared-')
  writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ verify: { test: testCommand } }))
  invalidateVerifyConfig()
  return dir
}

describe('run_tests declared verify.test (A2)', () => {
  it('runs the declared command via shell and passes on exit 0', async () => {
    const dir = setupDeclaredProject('node -e "console.log(\'declared ok\')"')
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir) as never)
    assert.equal(result.isError, false, `expected pass, got: ${String(result.content).slice(0, 300)}`)
    assert.equal(result.verification?.status, 'passed')
    assert.match(result.verification?.command ?? '', /node -e/)
  })

  it('fails on non-zero exit from the declared command', async () => {
    const dir = setupDeclaredProject('node -e "process.exit(3)"')
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir) as never)
    assert.equal(result.isError, true)
    assert.equal(result.verification?.status, 'failed')
  })

  it('declared command beats package.json auto-detection', async () => {
    const dir = setupDeclaredProject('node -e "console.log(\'from declaration\')"')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }))
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir) as never)
    assert.equal(result.isError, false)
    assert.match(result.verification?.command ?? '', /from declaration/)
  })

  it('C3: retries in a snapshot on in-place failure and attributes pollution', async () => {
    // Live dir fails (no marker file); snapshot dir passes (marker present).
    const liveDir = setupDeclaredProject('node -e "require(\'node:fs\').accessSync(\'marker.txt\')"')
    const snapDir = makeTestDir('run-tests-snapshot-')
    writeFileSync(join(snapDir, '.rivet-config.json'), JSON.stringify({
      verify: { test: 'node -e "require(\'node:fs\').accessSync(\'marker.txt\')"' },
    }))
    writeFileSync(join(snapDir, 'marker.txt'), 'present')

    const params = {
      ...makeParams({}, liveDir),
      prepareRetrySnapshot: () => ({ path: snapDir, snapshotRef: 'test-ref' }),
    }
    const result = await RUN_TESTS_TOOL.execute(params as never)
    assert.equal(result.isError, false, 'snapshot-pass should override live-fail')
    assert.match(String(result.content), /C3 attribution retry/)
    assert.match(String(result.content), /workspace pollution/)
  })

  it('C3: both-fail keeps the failure and confirms code attribution', async () => {
    const liveDir = setupDeclaredProject('node -e "process.exit(1)"')
    const snapDir = makeTestDir('run-tests-snapshot-')
    writeFileSync(join(snapDir, '.rivet-config.json'), JSON.stringify({
      verify: { test: 'node -e "process.exit(1)"' },
    }))
    const params = {
      ...makeParams({}, liveDir),
      prepareRetrySnapshot: () => ({ path: snapDir, snapshotRef: 'test-ref' }),
    }
    const result = await RUN_TESTS_TOOL.execute(params as never)
    assert.equal(result.isError, true)
    assert.match(String(result.content), /Also FAILED in an isolated snapshot/)
  })
})

describe('parseOutput declared formats', () => {
  it('parses cargo test summaries (summing multiple targets)', () => {
    const out = [
      'test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured',
      'test result: FAILED. 3 passed; 2 failed; 0 ignored',
    ].join('\n')
    const r = parseOutput(out, 'declared')
    assert.equal(r.passed, 15)
    assert.equal(r.failed, 2)
    assert.equal(r.skipped, 1)
  })

  it('parses go test failures and package ok lines', () => {
    const out = ['--- FAIL: TestFoo', '--- FAIL: TestBar', 'ok  \texample.com/pkg\t0.5s'].join('\n')
    const r = parseOutput(out, 'declared')
    assert.equal(r.failed, 2)
    assert.equal(r.passed, 1)
  })

  it('falls back to zero counts for unrecognized output', () => {
    const r = parseOutput('some random build log', 'declared')
    assert.equal(r.passed, 0)
    assert.equal(r.failed, 0)
  })
})
