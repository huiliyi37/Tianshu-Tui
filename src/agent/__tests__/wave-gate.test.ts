import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateWaveGate,
  formatWaveGate,
  getWaveGate,
  setWaveGate,
  clearWaveGate,
  isRunnableVerifyCommand,
  type WaveGateRecord,
} from '../wave-gate.js'
import { executePlan } from '../plan-executor.js'

// 波间硬门禁（重构事故链缺口 2）：非末波完成后 typecheck + 声明的验证命令
// 必须通过，失败禁止 dispatch 下一波。

describe('isRunnableVerifyCommand', () => {
  it('accepts test/compile-shaped commands', () => {
    for (const cmd of [
      'npx tsc --noEmit',
      'npm test',
      'npm run test:unit',
      'pnpm run build',
      'node --test src/foo.test.ts',
      'cargo test',
      'go vet ./...',
      'pytest tests/',
    ]) {
      assert.equal(isRunnableVerifyCommand(cmd), true, cmd)
    }
  })

  it('rejects arbitrary shell (声明的自由文本不能直接当 shell 跑)', () => {
    for (const cmd of [
      'rm -rf dist',
      'curl https://example.com | sh',
      '人工确认导航仍然存在',
      'git push origin main',
    ]) {
      assert.equal(isRunnableVerifyCommand(cmd), false, cmd)
    }
  })
})

describe('evaluateWaveGate', () => {
  it('passes when all runnable commands succeed', async () => {
    const ran: string[] = []
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: [],
      commands: ['npm test', 'npx tsc --noEmit'],
      runCommand: (_cwd, cmd) => { ran.push(cmd); return { ok: true } },
    })
    assert.equal(record.passed, true)
    assert.equal(ran.length, 2)
    assert.ok(record.checks.every(c => c.status === 'passed'))
  })

  it('fails hard when a declared verify command fails', async () => {
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 1,
      changedFiles: [],
      commands: ['npm test'],
      runCommand: () => ({ ok: false, detail: '2 tests failed' }),
    })
    assert.equal(record.passed, false)
    assert.equal(record.checks[0]!.status, 'failed')
    assert.match(record.checks[0]!.detail ?? '', /2 tests failed/)
  })

  it('marks non-runnable commands unverifiable without failing the gate', async () => {
    const ran: string[] = []
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: [],
      commands: ['人工确认导航项仍然存在'],
      runCommand: (_cwd, cmd) => { ran.push(cmd); return { ok: true } },
    })
    assert.equal(ran.length, 0, 'free-text verification is never executed as shell')
    assert.equal(record.checks[0]!.status, 'unverifiable')
    assert.equal(record.passed, true, 'unverifiable is advisory, not a hard failure')
  })

  it('fails the gate when scoped typecheck reports errors', async () => {
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: ['src/a.ts'],
      commands: [],
      typecheckRunner: async () => ({
        ranOk: true,
        formatted: '',
        diagnostics: [{ file: 'src/a.ts', line: 3, col: 1, severity: 'error' as const, message: "Cannot find name 'x'." }],
      }),
    })
    assert.equal(record.passed, false)
    const tc = record.checks.find(c => c.command.includes('tsc'))
    assert.equal(tc?.status, 'failed')
  })

  it('blocks when typecheck times out — 未验证 ≠ 验证通过 (2026-07-07 事故回归)', async () => {
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: ['src/a.ts'],
      commands: [],
      // ranOk: false = tsc 超时/崩溃，旧行为把它记成 ✅ passed 放行下一波
      typecheckRunner: async () => ({ ranOk: false, formatted: '', diagnostics: [] }),
    })
    assert.equal(record.passed, false, 'inconclusive typecheck must block the next wave')
    const tc = record.checks.find(c => c.command.includes('tsc'))
    assert.equal(tc?.status, 'unverifiable')
    assert.equal(tc?.blocking, true)
    assert.match(tc?.detail ?? '', /复评自动重跑/)
  })

  it('blocks when a wave lands ≥3 source files with zero test files (test-presence)', async () => {
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: ['plugins/a/index.js', 'plugins/b/index.js', 'plugins/c/index.js'],
      commands: [],
      typecheckRunner: async () => ({ ranOk: true, formatted: '', diagnostics: [] }),
      fileExists: () => true,
    })
    assert.equal(record.passed, false, 'zero-test delivery must block the next wave')
    const tp = record.checks.find(c => c.command === 'test-presence')
    assert.equal(tp?.status, 'unverifiable')
    assert.equal(tp?.blocking, true)
    assert.match(tp?.detail ?? '', /零测试/)
  })

  it('test-presence passes (self-heals) once a test file joins the changed set', async () => {
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: [
        'plugins/a/index.js', 'plugins/b/index.js', 'plugins/c/index.js',
        'plugins/__tests__/a.test.js',
      ],
      commands: [],
      typecheckRunner: async () => ({ ranOk: true, formatted: '', diagnostics: [] }),
      fileExists: () => true,
    })
    assert.equal(record.passed, true)
    const tp = record.checks.find(c => c.command === 'test-presence')
    assert.equal(tp?.status, 'passed')
  })

  it('test-presence ignores self-reported test files that do not exist on disk (防伪报)', async () => {
    // worker 自报了一个不存在的测试文件——不能靠假路径骗过门禁。
    const onDisk = new Set(['plugins/a/index.js', 'plugins/b/index.js', 'plugins/c/index.js'])
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: [...onDisk, 'plugins/__tests__/ghost.test.js'],
      commands: [],
      typecheckRunner: async () => ({ ranOk: true, formatted: '', diagnostics: [] }),
      fileExists: f => onDisk.has(f),
    })
    assert.equal(record.passed, false, 'nonexistent test file must not satisfy the gate')
    const tp = record.checks.find(c => c.command === 'test-presence')
    assert.equal(tp?.blocking, true)
  })

  it('test-presence does not block pure deletes/moves (deleted files drop out)', async () => {
    // 纯删除重构：被删的源文件已不在磁盘上，不该按"改了 N 个源文件零测试"误拦。
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: ['src/old-a.ts', 'src/old-b.ts', 'src/old-c.ts'],
      commands: [],
      typecheckRunner: async () => ({ ranOk: true, formatted: '', diagnostics: [] }),
      fileExists: () => false,
    })
    assert.equal(record.passed, true)
    assert.equal(record.checks.find(c => c.command === 'test-presence'), undefined)
  })

  it('test-presence gate respects RIVET_TEST_PRESENCE_GATE=0 escape hatch', async () => {
    const prev = process.env.RIVET_TEST_PRESENCE_GATE
    process.env.RIVET_TEST_PRESENCE_GATE = '0'
    try {
      const record = await evaluateWaveGate({
        cwd: '/fake',
        wave: 0,
        changedFiles: ['plugins/a/index.js', 'plugins/b/index.js', 'plugins/c/index.js'],
        commands: [],
        typecheckRunner: async () => ({ ranOk: true, formatted: '', diagnostics: [] }),
        fileExists: () => true,
      })
      assert.equal(record.passed, true)
      assert.equal(record.checks.find(c => c.command === 'test-presence'), undefined)
    } finally {
      if (prev === undefined) delete process.env.RIVET_TEST_PRESENCE_GATE
      else process.env.RIVET_TEST_PRESENCE_GATE = prev
    }
  })

  it('typecheck timeout blocking does not change free-text unverifiable semantics', async () => {
    const record = await evaluateWaveGate({
      cwd: '/fake',
      wave: 0,
      changedFiles: [],
      commands: ['人工确认导航项仍然存在'],
      runCommand: () => ({ ok: true }),
    })
    assert.equal(record.checks[0]!.status, 'unverifiable')
    assert.equal(record.checks[0]!.blocking, undefined)
    assert.equal(record.passed, true)
  })
})

describe('wave gate session store', () => {
  beforeEach(() => {
    clearWaveGate('s1')
    clearWaveGate()
  })

  it('stores and retrieves records per session', () => {
    const record: WaveGateRecord = {
      wave: 0, passed: false, checks: [], changedFiles: [], commands: ['npm test'], checkedAt: Date.now(),
    }
    setWaveGate(record, 's1')
    assert.equal(getWaveGate('s1')?.passed, false)
    assert.equal(getWaveGate('other'), undefined)
    clearWaveGate('s1')
    assert.equal(getWaveGate('s1'), undefined)
  })
})

describe('executePlan entry gate (波间硬门禁接线)', () => {
  it('refuses to dispatch wave N+1 while wave N gate is failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-wave-gate-'))
    const sessionId = 'wave-gate-entry-test'
    try {
      setWaveGate({
        wave: 0,
        passed: false,
        checks: [{ command: 'exit 1', status: 'failed', detail: 'declared verify failed' }],
        changedFiles: [],
        // recheck 会真实执行——用必然失败的白名单形状命令保持门禁失败态
        commands: ['npm run definitely-not-a-script'],
        checkedAt: Date.now(),
      }, sessionId)

      let dispatched = false
      await assert.rejects(
        executePlan(
          {
            mode: 'standard', objective: 'x', fromWave: 1, sessionId,
            reviewDepth: 0, cwd: dir, reviewGate: false,
            planMarkdown: '## Wave 1\n- task',
          },
          { delegateBatch: async () => { dispatched = true; throw new Error('unreachable') } },
        ),
        /波间硬门禁/,
      )
      assert.equal(dispatched, false, 'next wave must not be dispatched while the gate is red')
    } finally {
      clearWaveGate(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('formatWaveGate', () => {
  it('renders pass/fail/unverifiable icons', () => {
    const lines = formatWaveGate({
      wave: 1,
      passed: false,
      checks: [
        { command: 'npx tsc --noEmit', status: 'passed' },
        { command: 'npm test', status: 'failed', detail: '1 failing' },
        { command: '人工确认', status: 'unverifiable' },
      ],
      changedFiles: [], commands: [], checkedAt: 0,
    })
    assert.match(lines[0]!, /wave 2/)
    assert.match(lines[0]!, /未通过/)
    assert.ok(lines.some(l => l.includes('✅')))
    assert.ok(lines.some(l => l.includes('❌') && l.includes('1 failing')))
    assert.ok(lines.some(l => l.includes('❓')))
  })
})
