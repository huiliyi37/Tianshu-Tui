import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GitignoreFilter } from '../gitignore.js'

describe('GitignoreFilter', () => {
  it('matches Windows-style relative paths against slash-based ignore patterns', () => {
    const filter = new GitignoreFilter('C:\\repo', ['dist/', 'src/generated/*.ts'])

    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\dist\\bundle.js'), true)
    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\src\\generated\\api.ts'), true)
    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\src\\handwritten\\api.ts'), false)
  })
})
