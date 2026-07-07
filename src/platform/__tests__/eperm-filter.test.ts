import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleRejection, installEpermFilter, isWindowsScandirNoise } from '../eperm-filter.js'

/**
 * Contract tests for the unhandledRejection EPERM filter.
 *
 * Path patterns are shared via `restricted-paths.ts`; these tests verify the
 * filter layer's own semantics: syscall gating, code gating, and that tightened
 * patterns (no carpet AppData match) work end-to-end through isWindowsScandirNoise.
 */
describe('EPERM filter', () => {
  it('installEpermFilter is idempotent (safe to call twice)', () => {
    assert.doesNotThrow(() => installEpermFilter())
    assert.doesNotThrow(() => installEpermFilter())
  })

  it('filters EPERM scandir on ElevatedDiagnostics', () => {
    const error = {
      code: 'EPERM',
      errno: -4048,
      syscall: 'scandir',
      path: 'C:\\Users\\HongLin zhang\\AppData\\Local\\ElevatedDiagnostics',
      message: "EPERM: operation not permitted, scandir 'C:\\Users\\HongLin zhang\\AppData\\Local\\ElevatedDiagnostics'",
    }
    assert.equal(isWindowsScandirNoise(error), true)
  })

  it('filters EACCES scandir on $RECYCLE.BIN (macOS/Linux patterns too)', () => {
    assert.equal(isWindowsScandirNoise({
      code: 'EACCES', syscall: 'scandir',
      path: 'C:\\$RECYCLE.BIN',
    }), true)
  })

  it('does NOT filter AppData\\Local\\.rivet — Rivet data directory', () => {
    // Regression guard: old carpet pattern AppData\Local\(?!Temp) matched this.
    assert.equal(isWindowsScandirNoise({
      code: 'EPERM', syscall: 'scandir',
      path: 'C:\\Users\\test\\AppData\\Local\\.rivet\\sessions\\abc.jsonl',
    }), false)
  })

  it('does NOT filter AppData\\Local\\Temp (legitimate temp dir)', () => {
    assert.equal(isWindowsScandirNoise({
      code: 'EPERM', syscall: 'scandir',
      path: 'C:\\Users\\test\\AppData\\Local\\Temp\\my-project',
    }), false)
  })

  it('does NOT filter non-EPERM/EACCES errors (ENOENT)', () => {
    assert.equal(isWindowsScandirNoise({
      code: 'ENOENT', syscall: 'scandir',
      path: 'C:\\Users\\test\\AppData\\Local\\ElevatedDiagnostics',
    }), false)
  })

  it('does NOT filter EPERM on non-system project paths', () => {
    assert.equal(isWindowsScandirNoise({
      code: 'EPERM', syscall: 'scandir',
      path: 'C:\\Users\\test\\projects\\myapp\\src',
    }), false)
  })

  it('does NOT filter when syscall is not scandir/stat', () => {
    assert.equal(isWindowsScandirNoise({
      code: 'EPERM', syscall: 'open',
      path: 'C:\\Users\\test\\AppData\\Local\\ElevatedDiagnostics',
    }), false)
  })

  it('does NOT filter non-error values (string, null, undefined)', () => {
    assert.equal(isWindowsScandirNoise('some string'), false)
    assert.equal(isWindowsScandirNoise(null), false)
    assert.equal(isWindowsScandirNoise(undefined), false)
    assert.equal(isWindowsScandirNoise({}), false)
  })

  // W3 audibility contract: registering ANY unhandledRejection listener
  // disables Node's built-in warning, so the handler must re-print non-noise
  // rejections itself — otherwise real programming errors become silent.
  // (Tested via handleRejection directly: real rejections under node:test are
  // intercepted by the runner and fail the current test.)
  it('prints non-noise rejections to stderr via console.error', () => {
    const orig = console.error
    const captured: string[] = []
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
    try {
      handleRejection(new Error('genuine-bug-marker'))
      assert.ok(
        captured.some((l) => l.includes('genuine-bug-marker')),
        `expected the rejection to be printed, got: ${JSON.stringify(captured)}`,
      )
    } finally {
      console.error = orig
    }
  })

  it('prints non-Error rejection reasons (string) too', () => {
    const orig = console.error
    const captured: string[] = []
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
    try {
      handleRejection('plain-string-reason')
      assert.ok(captured.some((l) => l.includes('plain-string-reason')))
    } finally {
      console.error = orig
    }
  })

  it('stays silent for EPERM scandir noise rejections', () => {
    const orig = console.error
    const captured: string[] = []
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
    try {
      handleRejection({
        code: 'EPERM',
        syscall: 'scandir',
        path: 'C:\\Users\\test\\AppData\\Local\\ElevatedDiagnostics',
        message: 'EPERM: operation not permitted, scandir',
      })
      assert.equal(captured.length, 0, `noise should stay silent, got: ${JSON.stringify(captured)}`)
    } finally {
      console.error = orig
    }
  })
})
