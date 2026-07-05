import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_TESTS_TOOL, parseOutput } from '../run-tests.js'
import { makeTestDir, cleanupTestDir } from './_test-tmp.js'

// output-store.ts 的 rawDir() 使用 os.tmpdir()，沙箱下无写权限。
// rawDir() 懒加载且受 TMPDIR 环境变量控制——在 import 后覆盖即可。
const FAKE_TMP = mkdtempSync(join(process.cwd(), '.test-tmp', 'fake-tmp-'))
process.env.TMPDIR = FAKE_TMP
process.env.TMP = FAKE_TMP
process.env.TEMP = FAKE_TMP

after(() => {
  rmSync(FAKE_TMP, { recursive: true, force: true })
})

function makeParams(input: Record<string, unknown>, cwd: string) {
  return {
    input,
    toolUseId: 'test-run',
    cwd,
  }
}

function setupProject(testScript: string, testFile: string): string {
  const dir = makeTestDir('run-tests-')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: { test: testScript },
  }))
  writeFileSync(join(dir, 'src', 'example.test.ts'), testFile)
  return dir
}

function setupPythonProject(options: { withTests?: boolean; withFakePytest?: boolean } = {}): string {
  const dir = makeTestDir('run-tests-python-')
  writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
  if (options.withTests) {
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'test_example.py'), 'def test_ok():\n    assert 1 + 1 == 2\n')
  }
  if (options.withFakePytest) {
    const binDir = join(dir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const pytestPath = join(binDir, 'pytest')
    writeFileSync(pytestPath, '#!/usr/bin/env node\nconsole.log("1 passed in 0.01s")\n')
    chmodSync(pytestPath, 0o755)
  }
  return dir
}

function setupHangingProject(): string {
  const dir = makeTestDir('run-tests-hanging-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'hanging-project',
    scripts: { test: 'node -e "setInterval(() => {}, 1000)"' },
  }))
  return dir
}

describe('RUN_TESTS_TOOL', () => {
  let passingDir: string
  let failingDir: string

  before(() => {
    const passingTest = `import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('passing', () => {
  it('adds numbers', () => { assert.equal(1 + 1, 2) })
  it('concatenates strings', () => { assert.equal('a' + 'b', 'ab') })
})`

    const failingTest = `import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('mixed', () => {
  it('passes', () => { assert.equal(1, 1) })
  it('fails', () => { assert.equal(1, 2) })
})`

    passingDir = setupProject('tsx --test src/example.test.ts', passingTest)
    failingDir = setupProject('tsx --test src/example.test.ts', failingTest)
  })

  after(() => {
    rmSync(passingDir, { recursive: true, force: true })
    rmSync(failingDir, { recursive: true, force: true })
  })

  it('detects test command from package.json', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    // Success output is either a one-liner summary (when parse succeeds)
    // or a multi-line fallback (when parse can't match the test runner output)
    assert.ok(result.content.includes('passed'), 'should include passed count')
    assert.ok(!result.content.includes('FAILURES'), 'success should not include FAILURES')
    assert.ok(result.verification)
    assert.equal(result.verification!.status, 'passed')
    assert.equal(result.verification!.scope, 'full')
  })

  it('runs and reports success for passing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    // Phase 1 deterministic trimming: success output is either a one-liner ✓
    // or a multi-line fallback when parse fails (pre-existing limitation)
    assert.ok(result.content.includes('passed'), 'should include passed count')
    assert.ok(!result.content.includes('FAILURES'))
  })

  it('reports failure output for failing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, failingDir))
    assert.ok(result.content.length > 0)
    assert.ok(result.verification)
    // verification metadata is always present
    assert.ok(typeof result.verification!.passed === 'number')
    assert.ok(typeof result.verification!.failed === 'number')
  })

  it('filter restricts which tests run with targeted scope', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'src/example.test.ts' }, passingDir),
    )
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('passed'), 'should include passed count')
    assert.ok(result.verification)
    assert.equal(result.verification!.scope, 'targeted')
    assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
  })

  it('runs targeted tsx tests without npx npm-command ambiguity', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'src/example.test.ts' }, passingDir),
    )

    assert.equal(result.isError, false)
    assert.equal(result.verification!.command.startsWith('npx '), false)
    assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
  })

  it('treats scripts/run-node-tests.ts projects as node-test for targeted filters', async () => {
    const dir = setupProject('tsx scripts/run-node-tests.ts', `import { it } from 'node:test'
import assert from 'node:assert/strict'
it('works', () => assert.equal(2 + 2, 4))`)
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'src/example.test.ts' }, dir))

      assert.equal(result.isError, false)
      assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
      assert.equal(result.verification!.scope, 'targeted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not default to npm test when package.json is absent', async () => {
    const dir = makeTestDir('run-tests-empty-')
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.failureKind, 'tool_invocation_failure')
      assert.equal(result.verification!.command, '(auto-detect tests)')
      assert.match(result.content, /Unable to infer test command/i)
      assert.match(result.content, /Use bash/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects Python projects and recommends pytest without tests directory', async () => {
    const dir = setupPythonProject()
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.recommendedCommand, 'pytest')
      assert.equal(result.verification!.command, '(auto-detect tests)')
      assert.match(result.content, /Unable to infer test command/i)
      assert.match(result.content, /pytest/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs pytest for Python projects with tests directory', async () => {
    const dir = setupPythonProject({ withTests: true, withFakePytest: true })
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, false)
      assert.equal(result.verification!.command, 'pytest')
      assert.equal(result.verification!.status, 'passed')
      assert.equal(result.verification!.scope, 'full')
      assert.equal(result.verification!.passed, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses pytest filter directly for Python targeted runs', async () => {
    const dir = setupPythonProject({ withTests: true, withFakePytest: true })
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'tests/test_example.py' }, dir))

      assert.equal(result.isError, false)
      assert.equal(result.verification!.command, 'pytest tests/test_example.py')
      assert.equal(result.verification!.scope, 'targeted')
      assert.equal(result.verification!.targetFiles?.[0], 'tests/test_example.py')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unknown npm runner with filter does not synthesize npm test arguments', async () => {
    const dir = makeTestDir('run-tests-unknown-filter-')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'unknown-runner',
        scripts: { test: 'custom-test-runner' },
      }))
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'foo' }, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.command, '(auto-detect tests)')
      assert.equal(result.verification!.recommendedCommand, 'npm test')
      assert.doesNotMatch(result.content, /npm test -- foo/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('node-test runner with unresolved filter does not fall back to npm test arguments', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'missing-test-name' }, passingDir))

    assert.equal(result.isError, true)
    assert.equal(result.verification!.status, 'blocked')
    assert.equal(result.verification!.command, '(auto-detect tests)')
    assert.equal(result.verification!.recommendedCommand, 'npm test')
    assert.doesNotMatch(result.content, /npm test -- missing-test-name/)
  })

  it('surfaces raw runner output when the run fails without parseable test counts', async () => {
    // Simulates a test file that dies at import time (e.g. bad import):
    // exit != 0 but the runner reports no test counts. The model must see the
    // actual error text, not just "0 passed, 0 failed" (session 05e1500e).
    const dir = makeTestDir('run-tests-invocation-fail-')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'invocation-fail',
        scripts: { test: 'node -e "console.error(\'SyntaxError: The requested module does not provide an export named boom\'); process.exit(1)"' },
      }))
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.blockedReason, 'invocation_failure')
      assert.match(result.content, /does not provide an export named boom/, 'raw error must be visible to the model')
      assert.match(result.content, /测试运行器启动失败或崩溃/, 'guidance must be included')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies run_tests timeout as tool invocation failure', async () => {
    const dir = setupHangingProject()
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ timeout: 50 }, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.failureKind, 'tool_invocation_failure')
      assert.equal(result.verification!.command, 'npm test')
      assert.match(result.content, /timed out/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requiresApproval returns false', () => {
    assert.equal(RUN_TESTS_TOOL.requiresApproval(makeParams({}, '/tmp')), false)
  })

  it('sets outer tool timeout above requested test timeout', () => {
    assert.equal(RUN_TESTS_TOOL.timeoutMs?.(makeParams({ timeout: 50 }, passingDir)), 5050)
    assert.equal(RUN_TESTS_TOOL.timeoutMs?.(makeParams({}, passingDir)), 125000)
  })

  it('isConcurrencySafe returns false', () => {
    assert.equal(RUN_TESTS_TOOL.isConcurrencySafe(), false)
  })

  it('isEnabled returns true', () => {
    assert.equal(RUN_TESTS_TOOL.isEnabled(), true)
  })
})
