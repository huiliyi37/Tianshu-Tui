import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { installEpermFilter } from '../eperm-filter.js'

/** Windows system-directory patterns used by the filter. */
const WINDOWS_NOISY_PATTERNS: readonly RegExp[] = [
  /ElevatedDiagnostics/i,
  /AppData[\\/]Local[\\/](?!Temp)/i,
  /Windows[\\/]System32[\\/]config/i,
  /System Volume Information/i,
  /\$RECYCLE\.BIN/i,
]

/** Replicate the filter predicate for contract testing. */
function isWindowsScandirNoise(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const err = error as Record<string, unknown>
  if (err.code !== 'EPERM') return false
  const syscall = err.syscall as string | undefined
  if (syscall !== 'scandir' && syscall !== 'stat') return false
  const path = typeof err.path === 'string'
    ? err.path
    : String(err.message ?? '')
  return WINDOWS_NOISY_PATTERNS.some(re => re.test(path))
}

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

  it('filters EPERM scandir on AppData\\Local subdirectory', () => {
    const error = {
      code: 'EPERM',
      syscall: 'scandir',
      path: 'C:\\Users\\test\\AppData\\Local\\SomeCacheDir',
    }
    assert.equal(isWindowsScandirNoise(error), true)
  })

  it('does NOT filter AppData\\Local\\Temp (legitimate temp dir)', () => {
    const error = {
      code: 'EPERM',
      syscall: 'scandir',
      path: 'C:\\Users\\test\\AppData\\Local\\Temp\\my-project',
    }
    assert.equal(isWindowsScandirNoise(error), false)
  })

  it('does NOT filter non-EPERM errors (ENOENT)', () => {
    const error = {
      code: 'ENOENT',
      syscall: 'scandir',
      path: 'C:\\Users\\test\\AppData\\Local\\ElevatedDiagnostics',
    }
    assert.equal(isWindowsScandirNoise(error), false)
  })

  it('does NOT filter EPERM on non-system project paths', () => {
    const error = {
      code: 'EPERM',
      syscall: 'scandir',
      path: 'C:\\Users\\test\\projects\\myapp\\src',
    }
    assert.equal(isWindowsScandirNoise(error), false)
  })

  it('does NOT filter EPERM stat on user project files', () => {
    const error = {
      code: 'EPERM',
      syscall: 'stat',
      path: 'C:\\Users\\test\\code\\app\\index.ts',
    }
    assert.equal(isWindowsScandirNoise(error), false)
  })

  it('does NOT filter non-error values (string, null, undefined)', () => {
    assert.equal(isWindowsScandirNoise('some string'), false)
    assert.equal(isWindowsScandirNoise(null), false)
    assert.equal(isWindowsScandirNoise(undefined), false)
    assert.equal(isWindowsScandirNoise({}), false)
  })
})
