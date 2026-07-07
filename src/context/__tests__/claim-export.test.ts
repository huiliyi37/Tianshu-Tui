import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDurableClaims, importClaims } from '../claim-export.js'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'

function proposal(text: string): ClaimProposal {
  return {
    kind: 'user_constraint',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'test', turn: 1, eventId: `e:${text.slice(0, 8)}` },
    evidence: [{ id: `ev:${text.slice(0, 8)}`, kind: 'user_message', summary: text, createdAt: Date.now() }],
    createdAt: Date.now(),
    tags: ['test'],
  }
}

describe('claim export/import', () => {
  it('exports durable claims to JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-export-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const claim = store.propose(proposal('Never force push'))
      store.updateClaimStatus(claim.id, 'durable', 'user confirmed')

      const outPath = join(dir, 'export.json')
      const count = exportDurableClaims(store, outPath)

      assert.equal(count, 1)
      assert.ok(existsSync(outPath))

      const data = JSON.parse(readFileSync(outPath, 'utf-8'))
      assert.equal(data.claims.length, 1)
      assert.equal(data.claims[0].text, 'Never force push')
      assert.equal(data.version, 1)
      assert.ok(data.exportedAt)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not export non-durable claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-export-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('Active only claim'))

      const outPath = join(dir, 'export.json')
      const count = exportDurableClaims(store, outPath)

      assert.equal(count, 0)
      const data = JSON.parse(readFileSync(outPath, 'utf-8'))
      assert.deepEqual(data.claims, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports claims with confidence decay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-import-'))
    try {
      const sourceStore = new ContextClaimStore(dir, 'source')
      const claim = sourceStore.propose(proposal('Important rule'))
      sourceStore.updateClaimStatus(claim.id, 'durable', 'confirmed')

      const exportPath = join(dir, 'export.json')
      exportDurableClaims(sourceStore, exportPath)

      const targetStore = new ContextClaimStore(dir, 'target')
      const imported = importClaims(targetStore, exportPath)

      assert.equal(imported, 1)
      const claims = targetStore.listClaims()
      assert.equal(claims.length, 1)
      assert.equal(claims[0]!.text, 'Important rule')
      assert.ok(claims[0]!.confidence <= 0.9 * 0.8 + 0.01)
      assert.ok(claims[0]!.tags.includes('imported'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips import if file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-import-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const imported = importClaims(store, '/nonexistent/path.json')
      assert.equal(imported, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
