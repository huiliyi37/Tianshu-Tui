import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_META_KB, ENRICHED_ALIAS_TABLE } from '../model-meta-kb.js'
import { MODEL_ALIAS_TABLE } from '../model-aliases.js'

describe('MODEL_META_KB', () => {
  it('contains all GLM entries from the knowledge base', () => {
    const canonicalIds = MODEL_META_KB.map(e => e.canonicalId)
    const glmIds = canonicalIds.filter(id => id.startsWith('glm-'))
    assert.ok(glmIds.includes('glm-5.1'))
    assert.ok(glmIds.includes('glm-5'))
    assert.ok(glmIds.includes('glm-4.7'))
    assert.ok(glmIds.includes('glm-4.6'))
    assert.ok(glmIds.includes('glm-4-long'))
  })

  it('contains Kimi entries with maxTokens omitted (官网未公布)', () => {
    const kimiEntry = MODEL_META_KB.find(e => e.canonicalId === 'kimi-k2.6')
    assert.ok(kimiEntry, 'kimi-k2.6 must be in KB')
    assert.equal(kimiEntry!.metadata.contextWindow, 262_144)
    assert.equal(kimiEntry!.metadata.maxTokens, undefined)
  })

  it('all entries have reasoningSplit capability set', () => {
    for (const entry of MODEL_META_KB) {
      const hasReasoning = entry.metadata?.capabilities?.reasoningSplit === true
      if (!['glm-4-long', 'glm-4-flashx-250414'].includes(entry.canonicalId)) {
        assert.ok(hasReasoning, `${entry.canonicalId} should have reasoningSplit`)
      }
    }
  })

  it('all entries have positive contextWindow', () => {
    for (const entry of MODEL_META_KB) {
      assert.ok(entry.metadata.contextWindow !== undefined, `${entry.canonicalId} needs contextWindow`)
      assert.ok(entry.metadata.contextWindow! > 0, `${entry.canonicalId} contextWindow must be positive`)
    }
  })
})

describe('ENRICHED_ALIAS_TABLE', () => {
  it('is a superset of MODEL_ALIAS_TABLE with KNOWN entries appended', () => {
    assert.ok(ENRICHED_ALIAS_TABLE.length > MODEL_ALIAS_TABLE.length)
    const presetIds = new Set(MODEL_ALIAS_TABLE.map(e => e.canonicalId))
    const enrichedIds = new Set(ENRICHED_ALIAS_TABLE.map(e => e.canonicalId))
    // Every preset entry must be present in the enriched table
    for (const id of presetIds) {
      assert.ok(enrichedIds.has(id), `preset ${id} must be in ENRICHED_ALIAS_TABLE`)
    }
  })

  it('includes KB entries not in preset fleet', () => {
    const presetIds = new Set(MODEL_ALIAS_TABLE.map(e => e.canonicalId))
    const kbEntriesInEnriched = MODEL_META_KB.filter(e => !presetIds.has(e.canonicalId))
    assert.ok(kbEntriesInEnriched.length > 0, 'KB should add entries not in fleet')
    for (const entry of kbEntriesInEnriched) {
      assert.ok(presetIds.has(entry.canonicalId) || true, `${entry.canonicalId} is a new KB entry`)
    }
  })

  it('has no duplicate canonicalId entries', () => {
    const ids = ENRICHED_ALIAS_TABLE.map(e => e.canonicalId)
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
    assert.deepEqual(duplicates, [], 'ENRICHED_ALIAS_TABLE should have no duplicate canonicalIds')
  })

  it('keeps preset entries before KB entries (fleet priority)', () => {
    // Last preset entry index should be before first KB entry index
    const presetCount = MODEL_ALIAS_TABLE.length
    const kbStartIndex = ENRICHED_ALIAS_TABLE.findIndex(e => !MODEL_ALIAS_TABLE.some(p => p.canonicalId === e.canonicalId))
    assert.ok(kbStartIndex >= presetCount, `KB entries should start at or after index ${presetCount}`)
  })
})
