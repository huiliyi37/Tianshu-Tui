import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('runtime ignore rules', () => {
  it('ignores runtime diagnostics while preserving canonical memory paths', () => {
    const content = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8')
    assert.match(content, /^\.rivet\/runtime\/$/m)
    assert.match(content, /^\.rivet\/tmp\/$/m)
    assert.match(content, /^\.rivet\/prefix-diag\.jsonl$/m)
    assert.match(content, /^\.rivet\/knowledge\/memory\.jsonl$/m)
    assert.doesNotMatch(content, /^\.rivet\/knowledge\/$/m)
    assert.doesNotMatch(content, /^\.rivet\/knowledge\/project-memory\.md$/m)
  })
})
