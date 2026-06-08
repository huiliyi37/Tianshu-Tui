import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toPosixPath } from '../path-format.js'

describe('path-format', () => {
  it('normalizes Windows separators for stable model/tool output', () => {
    assert.equal(toPosixPath('src\\tools\\file.ts'), 'src/tools/file.ts')
    assert.equal(toPosixPath('C:\\Users\\alice\\repo\\image.png'), 'C:/Users/alice/repo/image.png')
  })

  it('keeps POSIX paths unchanged', () => {
    assert.equal(toPosixPath('src/tools/file.ts'), 'src/tools/file.ts')
  })
})
