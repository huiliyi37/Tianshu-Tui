import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BM25Index, tokenize } from '../text-index.js'

describe('text-index', () => {
  it('tokenizes code and CJK', () => {
    const tokens = tokenize('function authenticateUser 用户认证')
    assert.ok(tokens.includes('authenticateuser') || tokens.includes('function'))
    assert.ok(tokens.includes('用户认证'))
  })

  it('ranks relevant chunks higher', () => {
    const idx = new BM25Index()
    idx.addChunk('src/auth.ts', 1, 10, 'export function authenticateUser(token: string) {}')
    idx.addChunk('src/ui.ts', 1, 5, 'export function renderButton() {}')

    const hits = idx.search('user authentication token')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.file, 'src/auth.ts')
  })
})
