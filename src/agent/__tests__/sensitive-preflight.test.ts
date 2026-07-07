import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSensitivePreflightMessage,
  hasKnowledgeManifestRead,
  isSensitivePreflightPath,
  normalizePreflightPath,
  shouldRequireSensitivePreflight,
} from '../sensitive-preflight.js'
import type { TaskLedgerEvent } from '../task-ledger.js'

function read(path: string): TaskLedgerEvent {
  return { type: 'file_read', path, timestamp: Date.now() }
}

describe('sensitive preflight', () => {
  it('detects sensitive prompt, context, recall, memory, verification, and ownership paths', () => {
    assert.equal(isSensitivePreflightPath('src/prompt/static.ts'), true)
    assert.equal(isSensitivePreflightPath('src/context/project-memory-loader.ts'), true)
    assert.equal(isSensitivePreflightPath('src/tools/recall.ts'), true)
    assert.equal(isSensitivePreflightPath('src/agent/dream.ts'), true)
    assert.equal(isSensitivePreflightPath('src/agent/delivery-gate-v2.ts'), true)
    assert.equal(isSensitivePreflightPath('src/agent/ownership-ledger.ts'), true)
    assert.equal(isSensitivePreflightPath('.rivet/knowledge/project-memory.md'), true)

    assert.equal(isSensitivePreflightPath('src/tui/app.tsx'), false)
    assert.equal(isSensitivePreflightPath('docs/superpowers/plans/demo.md'), false)
  })

  it('normalizes relative and Windows-style paths', () => {
    assert.equal(normalizePreflightPath('./src\\prompt\\static.ts'), 'src/prompt/static.ts')
  })

  it('recognizes knowledge manifest reads in task ledger events', () => {
    assert.equal(hasKnowledgeManifestRead([read('.rivet/knowledge/manifest.md')]), true)
    assert.equal(hasKnowledgeManifestRead([read('./.rivet/knowledge/manifest.md')]), true)
    assert.equal(hasKnowledgeManifestRead([read('.rivet/knowledge/project-memory.md')]), false)
  })

  it('requires preflight only for sensitive paths when manifest was not read', () => {
    assert.equal(shouldRequireSensitivePreflight({ path: 'src/context/project-memory-loader.ts', events: [] }), true)
    assert.equal(shouldRequireSensitivePreflight({ path: 'src/context/project-memory-loader.ts', events: [read('.rivet/knowledge/manifest.md')] }), false)
    assert.equal(shouldRequireSensitivePreflight({ path: 'src/tui/app.tsx', events: [] }), false)
  })

  it('builds an actionable preflight message', () => {
    const message = buildSensitivePreflightMessage('src/tools/recall.ts')
    assert.match(message, /Sensitive-area preflight required/)
    assert.match(message, /\.rivet\/knowledge\/manifest\.md/)
    assert.match(message, /src\/tools\/recall\.ts/)
  })
})
