import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticIndex } from '../semantic-index.js'
import type { EmbeddingProvider } from '../embedding-provider.js'
import { NullEmbeddingProvider } from '../embedding-provider.js'

/**
 * Fake provider: maps text to a vector by concept keywords, so we can prove the
 * semantic path surfaces a concept hit that BM25 (literal tokens) misses.
 */
class FakeConceptProvider implements EmbeddingProvider {
  readonly id = 'fake:concept'
  isAvailable(): boolean { return true }
  async embed(texts: string[]): Promise<number[][]> {
    // Dimensions: [auth, database, render]
    return texts.map(t => {
      const lc = t.toLowerCase()
      const auth = /auth|login|credential|permission|require/.test(lc) ? 1 : 0
      const db = /db|database|query|sql|store/.test(lc) ? 1 : 0
      const render = /render|draw|paint|ui|view/.test(lc) ? 1 : 0
      const v = [auth, db, render]
      // Avoid all-zero vectors (cosine would be 0): add a tiny bias.
      return v.some(Boolean) ? v : [0.01, 0.01, 0.01]
    })
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-hybrid-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  // This function is about authentication but never uses the literal word "auth".
  writeFileSync(join(dir, 'src', 'gate.ts'), [
    'export function requireLogin(user: User) {',
    '  // verify the user credential before allowing the request',
    '  if (!user.permission) throw new Error("forbidden")',
    '  return true',
    '}',
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'db.ts'), [
    'export function runQuery(sql: string) {',
    '  return database.execute(sql)',
    '}',
  ].join('\n'))
  return dir
}

describe('SemanticIndex.searchHybrid (C1)', () => {
  it('degrades to BM25 with the null provider', async () => {
    const repo = makeRepo()
    try {
      const idx = new SemanticIndex(repo, new NullEmbeddingProvider())
      idx.rebuild()
      const { backend } = await idx.searchHybrid('runQuery', 5)
      assert.equal(backend, 'bm25')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('hybrid surfaces a concept hit that the literal query misses', async () => {
    const repo = makeRepo()
    try {
      const idx = new SemanticIndex(repo, new FakeConceptProvider())
      idx.rebuild()

      // Query uses the word "authentication" — which does NOT appear literally
      // in gate.ts (it says requireLogin/credential/permission).
      const bm25Only = idx.search('authentication')
      assert.ok(!bm25Only.some(h => h.file.endsWith('gate.ts')), 'BM25 should miss gate.ts on this concept query')

      const { hits, backend } = await idx.searchHybrid('authentication', 5)
      assert.equal(backend, 'hybrid')
      assert.ok(hits.some(h => h.file.endsWith('gate.ts')), 'hybrid should surface gate.ts via vector match')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
