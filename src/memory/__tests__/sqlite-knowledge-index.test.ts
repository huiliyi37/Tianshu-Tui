import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteKnowledgeIndex, type SQLiteKnowledgeDocument } from '../sqlite-knowledge-index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'rivet-memory-sqlite-'))
  roots.push(value)
  return value
}

describe('sqlite knowledge index', () => {
  it('persists FTS5 projection with CJK bigram recall and metadata filters', async () => {
    const index = new SQLiteKnowledgeIndex(root())
    const documents: SQLiteKnowledgeDocument[] = [
      {
        id: 'current-rule',
        text: '前缀缓存只能在用户消息边界追加上下文',
        indexText: '前缀缓存只能在用户消息边界追加上下文 cache prefix',
        source: 'entry',
        kind: 'project_rule',
        topic: 'cache',
        current: true,
        ts: 10,
      },
      {
        id: 'old-finding',
        text: '旧的缓存建议已经失效',
        indexText: '旧的缓存建议已经失效',
        source: 'entry',
        kind: 'finding',
        topic: 'cache',
        current: false,
        ts: 1,
      },
    ]

    const hits = await index.search(documents, 'v1', '前缀缓存', 5, { kind: 'project_rule' })
    assert.notEqual(hits, null)
    assert.deepEqual(hits?.map(hit => hit.id), ['current-rule'])

    const current = await index.search(documents, 'v1', '旧的建议', 5, {})
    assert.deepEqual(current, [])
    const history = await index.search(documents, 'v1', '旧的建议', 5, { includeHistory: true })
    assert.deepEqual(history?.map(hit => hit.id), ['old-finding'])
    index.close()
  })

  it('rebuilds the derived projection when the source fingerprint changes', async () => {
    const index = new SQLiteKnowledgeIndex(root())
    const original: SQLiteKnowledgeDocument[] = [{
      id: 'rule', text: 'alpha memory rule', indexText: 'alpha memory rule', source: 'entry',
      kind: 'project_rule', current: true, ts: 1,
    }]
    assert.deepEqual((await index.search(original, 'v1', 'alpha', 5, {}))?.map(hit => hit.id), ['rule'])

    const updated = [{ ...original[0]!, text: 'beta memory rule', indexText: 'beta memory rule' }]
    assert.deepEqual(await index.search(updated, 'v2', 'alpha', 5, {}), [])
    assert.deepEqual((await index.search(updated, 'v2', 'beta', 5, {}))?.map(hit => hit.id), ['rule'])
    index.close()
  })
})
