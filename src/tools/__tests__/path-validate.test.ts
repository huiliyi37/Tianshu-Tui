import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { validatePath, validatePathSafe } from '../path-validate.js'
import { grantPath, _resetGrantsForTest } from '../path-grants.js'

describe('validatePath', () => {
  it('allows files within cwd', () => {
    const result = validatePath('/home/user/project', 'src/file.ts')
    assert.equal(result, resolvePath('/home/user/project', 'src/file.ts'))
  })

  it('allows cwd itself', () => {
    const result = validatePath('/home/user/project', '.')
    assert.equal(result, resolvePath('/home/user/project', '.'))
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
    assert.equal(result, resolvePath('/home/user/project', 'src//file.ts'))
  })

  it('rejects path that resolves outside via symlink-like traversal', () => {
    assert.throws(
      () => validatePath('/home/user/project', 'src/../../../etc/shadow'),
      /Path outside project directory/,
    )
  })

  it('allows deeply nested files within cwd', () => {
    const result = validatePath('/home/user/project', 'a/b/c/d/e/file.ts')
    assert.equal(result, resolvePath('/home/user/project', 'a/b/c/d/e/file.ts'))
  })
})

describe('validatePathSafe', () => {
  it('returns ok for valid paths', () => {
    const result = validatePathSafe('/home/user/project', 'src/file.ts')
    assert.deepEqual(result, { ok: true, path: resolvePath('/home/user/project', 'src/file.ts') })
  })

  it('returns error for traversal', () => {
    const result = validatePathSafe('/home/user/project', '../etc/passwd')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /outside project directory/)
  })
})

describe('validatePathSafe with out-of-workspace grants', () => {
  beforeEach(() => _resetGrantsForTest())

  it('allows an out-of-workspace path once a read grant covers it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const external = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      // Without a grant: rejected.
      const before = validatePathSafe(cwd, join(external, 'data.json'), 'read')
      assert.equal(before.ok, false)

      grantPath(external, 'read')
      const after = validatePathSafe(cwd, join(external, 'data.json'), 'read')
      assert.equal(after.ok, true)

      // A read grant must NOT satisfy a write op.
      const write = validatePathSafe(cwd, join(external, 'data.json'), 'write')
      assert.equal(write.ok, false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('allows an out-of-workspace write once a write grant covers it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const external = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      grantPath(external, 'write')
      const w = validatePathSafe(cwd, join(external, 'out.zip'), 'write')
      assert.equal(w.ok, true)
      const r = validatePathSafe(cwd, join(external, 'out.zip'), 'read')
      assert.equal(r.ok, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('upgraded error hints at request_path_access', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    try {
      const r = validatePathSafe(cwd, '/etc/hosts', 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /request_path_access/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('validatePathSafe — sensitive file hard gate across path forms (M3)', () => {
  beforeEach(() => _resetGrantsForTest())

  function makeCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-sens-'))
    mkdirSync(join(cwd, 'scripts'), { recursive: true })
    return cwd
  }

  it('blocks .env inside the workspace', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, '.env', 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks scripts/../.env — whitelist is evaluated on the canonicalized form, not the raw prefix', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, join('scripts', '..', '.env'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks trailing-slash / trailing-dot / case variants', () => {
    const cwd = makeCwd()
    try {
      for (const p of ['.env/', '.env.', '.ENV', join('config', '.Env.Local')]) {
        const r = validatePathSafe(cwd, p, 'read')
        assert.equal(r.ok, false, `${p} must be blocked`)
        if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks the realpath form when the raw name is obfuscated (existing file, resolved name is sensitive)', () => {
    const cwd = makeCwd()
    try {
      // 真实存在的伪装文件：裸名不带敏感后缀，但 realpath/resolve 后的规范名是 .env 变体。
      // 8.3 短名（CREDEN~1.JSON）在同一机制下收敛——realpath 展开后过敏感检测。
      writeFileSync(join(cwd, '.env.local'), 'X=1')
      const r = validatePathSafe(cwd, join(cwd, '.ENV.LOCAL'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('still allows whitelisted fixture/script paths (canonical form keeps the whitelist)', () => {
    const cwd = makeCwd()
    try {
      writeFileSync(join(cwd, 'scripts', 'gen-creds.ts'), 'x')
      const r = validatePathSafe(cwd, join('scripts', '..', 'scripts', 'gen-creds.ts'), 'read')
      assert.equal(r.ok, true, 'canonicalized scripts/ path stays whitelisted')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('sensitive check wins over the out-of-workspace error (fail-closed ordering kept)', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, join('..', '.env'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns the original-cwd-based resolved path for clean files (contract unchanged)', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, join('src', 'a.ts'), 'read')
      assert.deepEqual(r, { ok: true, path: join(cwd, 'src', 'a.ts') })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
