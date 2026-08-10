import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveConnectDraft, readConnectDraft, clearConnectDraft, type ConnectDraft } from '../connect-draft.js'

function draft(overrides: Partial<ConnectDraft> = {}): ConnectDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    phase: 'diy-apikey',
    collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'example' },
    ...overrides,
  }
}

describe('connect draft I/O', () => {
  let base = ''

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rivet-connect-draft-'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('round-trips a draft with advanced and probedSelection', () => {
    const input = draft({
      collected: {
        baseUrl: 'https://api.example.com/v1',
        keyRef: 'example',
        advanced: { maxRetries: 0, temperature: 0.2 },
        probedSelection: [{ rawId: 'm1', checked: true }, { rawId: 'm2', checked: false }],
      },
      pendingInput: 'half-typed',
    })
    saveConnectDraft(input, base)
    const read = readConnectDraft(base)
    assert.deepEqual(read, input)
  })

  it('returns undefined and deletes a corrupt file', () => {
    const path = join(base, 'connect-draft.json')
    writeFileSync(path, '{not json')
    assert.equal(readConnectDraft(base), undefined)
    assert.equal(existsSync(path), false)
  })

  it('rejects wrong version, unknown phase, and missing savedAt', () => {
    saveConnectDraft(draft(), base)
    const path = join(base, 'connect-draft.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

    writeFileSync(path, JSON.stringify({ ...raw, version: 2 }))
    assert.equal(readConnectDraft(base), undefined)

    saveConnectDraft(draft(), base)
    const raw2 = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...raw2, phase: 'bogus-phase' }))
    assert.equal(readConnectDraft(base), undefined)

    saveConnectDraft(draft(), base)
    const raw3 = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete raw3.savedAt
    writeFileSync(path, JSON.stringify(raw3))
    assert.equal(readConnectDraft(base), undefined)
  })

  it('expires drafts older than the TTL', () => {
    saveConnectDraft(draft({ savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }), base)
    assert.equal(readConnectDraft(base), undefined)
  })

  it('treats an empty provider-phase draft as no draft', () => {
    saveConnectDraft(draft({ phase: 'provider', collected: {} }), base)
    assert.equal(readConnectDraft(base), undefined)
  })

  it('skips junk collected fields but keeps valid ones', () => {
    saveConnectDraft(draft(), base)
    const path = join(base, 'connect-draft.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    ;(raw.collected as Record<string, unknown>).modelId = 42
    ;(raw.collected as Record<string, unknown>).contextWindow = 'huge'
    writeFileSync(path, JSON.stringify(raw))
    const read = readConnectDraft(base)
    assert.equal(read?.collected.modelId, undefined)
    assert.equal(read?.collected.contextWindow, undefined)
    assert.equal(read?.collected.baseUrl, 'https://api.example.com/v1')
  })

  it('read on a missing file is undefined; clear is idempotent', () => {
    assert.equal(readConnectDraft(base), undefined)
    clearConnectDraft(base)
    clearConnectDraft(base)
  })

  it('drops legacy plaintext apiKey fields (drafts never carry keys)', () => {
    saveConnectDraft(draft(), base)
    const path = join(base, 'connect-draft.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    ;(raw.collected as Record<string, unknown>).apiKey = 'sk-legacy-plaintext'
    writeFileSync(path, JSON.stringify(raw))
    const read = readConnectDraft(base)
    assert.equal('apiKey' in (read?.collected ?? {}), false)
    assert.ok(!JSON.stringify(read).includes('sk-legacy-plaintext'))
  })
})
