import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validatePath, validatePathSafe } from '../path-validate.js'

describe('validatePath', () => {
  it('allows files within cwd', () => {
    const result = validatePath('/home/user/project', 'src/file.ts')
    assert.equal(result, '/home/user/project/src/file.ts')
  })

  it('allows cwd itself', () => {
    const result = validatePath('/home/user/project', '.')
    assert.equal(result, '/home/user/project')
  })

  it('rejects parent directory traversal', () => {
    assert.throws(
      () => validatePath('/home/user/project', '../../etc/passwd'),
      /Path outside project directory/,
    )
  })

  it('rejects sibling directory with common prefix', () => {
    assert.throws(
      () => validatePath('/home/user/app', '../app-backup/secrets'),
      /Path outside project directory/,
    )
  })

  it('rejects absolute path outside cwd', () => {
    assert.throws(
      () => validatePath('/home/user/project', '/etc/passwd'),
      /Path outside project directory/,
    )
  })

  it('normalizes path with double slashes', () => {
    const result = validatePath('/home/user/project', 'src//file.ts')
    assert.equal(result, '/home/user/project/src/file.ts')
  })

  it('rejects path that resolves outside via symlink-like traversal', () => {
    assert.throws(
      () => validatePath('/home/user/project', 'src/../../../etc/shadow'),
      /Path outside project directory/,
    )
  })

  it('allows deeply nested files within cwd', () => {
    const result = validatePath('/home/user/project', 'a/b/c/d/e/file.ts')
    assert.equal(result, '/home/user/project/a/b/c/d/e/file.ts')
  })
})

describe('validatePathSafe', () => {
  it('returns ok for valid paths', () => {
    const result = validatePathSafe('/home/user/project', 'src/file.ts')
    assert.deepEqual(result, { ok: true, path: '/home/user/project/src/file.ts' })
  })

  it('returns error for traversal', () => {
    const result = validatePathSafe('/home/user/project', '../etc/passwd')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /outside project directory/)
  })
})
