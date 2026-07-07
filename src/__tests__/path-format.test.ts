import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toPosixPath, canonicalPathKey, translateWindowsShellPath } from '../path-format.js'

describe('path-format', () => {
  it('normalizes Windows separators for stable model/tool output', () => {
    assert.equal(toPosixPath('src\\tools\\file.ts'), 'src/tools/file.ts')
    assert.equal(toPosixPath('C:\\Users\\alice\\repo\\image.png'), 'C:/Users/alice/repo/image.png')
  })

  it('keeps POSIX paths unchanged', () => {
    assert.equal(toPosixPath('src/tools/file.ts'), 'src/tools/file.ts')
  })
})

describe('canonicalPathKey', () => {
  it('win32: 分隔符/大小写/盘符变体折叠为同一个键', () => {
    const variants = ['D:\\Sky\\天枢\\File.md', 'D:/Sky/天枢/File.md', 'd:/sky/天枢/file.md', 'd:\\SKY\\天枢\\FILE.MD']
    const keys = new Set(variants.map(v => canonicalPathKey(v, 'win32')))
    assert.equal(keys.size, 1)
    assert.equal([...keys][0], 'd:/sky/天枢/file.md')
  })

  it('POSIX: 原样返回（大小写敏感文件系统不能折叠）', () => {
    assert.equal(canonicalPathKey('/repo/File.md', 'darwin'), '/repo/File.md')
    assert.equal(canonicalPathKey('/repo/File.md', 'linux'), '/repo/File.md')
  })
})

describe('translateWindowsShellPath', () => {
  it('win32: Git Bash / Cygwin / WSL 盘符前缀翻译为原生形态', () => {
    assert.equal(translateWindowsShellPath('/d/sky/file.md', 'win32'), 'D:/sky/file.md')
    assert.equal(translateWindowsShellPath('/c/Users/tom', 'win32'), 'C:/Users/tom')
    assert.equal(translateWindowsShellPath('/cygdrive/e/proj', 'win32'), 'E:/proj')
    assert.equal(translateWindowsShellPath('/mnt/c/dev', 'win32'), 'C:/dev')
    assert.equal(translateWindowsShellPath('/c:/dev/x', 'win32'), 'C:/dev/x')
    assert.equal(translateWindowsShellPath('/d', 'win32'), 'D:')
  })

  it('win32: 非盘符前缀路径不受影响', () => {
    assert.equal(translateWindowsShellPath('D:\\sky\\file.md', 'win32'), 'D:\\sky\\file.md')
    assert.equal(translateWindowsShellPath('src/foo/bar.ts', 'win32'), 'src/foo/bar.ts')
    assert.equal(translateWindowsShellPath('/dev/null', 'win32'), '/dev/null')
    assert.equal(translateWindowsShellPath('/cygdrive2/c/x', 'win32'), '/cygdrive2/c/x')
    assert.equal(translateWindowsShellPath('/mnt/data/x', 'win32'), '/mnt/data/x')
  })

  it('非 win32: 一律原样返回（/mnt/c 可能是真实目录）', () => {
    assert.equal(translateWindowsShellPath('/c/Users/tom', 'darwin'), '/c/Users/tom')
    assert.equal(translateWindowsShellPath('/mnt/c/dev', 'linux'), '/mnt/c/dev')
  })
})
