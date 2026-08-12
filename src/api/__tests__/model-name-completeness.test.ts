/**
 * Completeness matrix for user-supplied model names — every shape a real
 * endpoint can throw at the matcher: official ids, aggregator prefixes,
 * variant tags, relay renames, unicode, hostile strings. Complements
 * model-id-matcher.test.ts (happy paths) with boundary/ambiguity/guard cases.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchModelId, matchModelIds, normalizeModelId, FUZZY_MATCH_THRESHOLD } from '../model-id-matcher.js'
import { MODEL_ALIAS_TABLE } from '../model-aliases.js'
import type { ModelAliasEntry } from '../model-aliases.js'

const T = (canonicalId: string, aliases: string[] = []): ModelAliasEntry =>
  ({ canonicalId, aliases, metadata: {} })

// Synthetic token names deliberately avoid digit-looking tails: the date-stamp
// rule [-_](?:19|20)\d{6}$ eats any dash + 8-digit suffix.

describe('A. model-name input shapes', () => {
  it('A3: leading/trailing whitespace still reaches L2', () => {
    const hit = matchModelId('  deepseek-v4-pro  ')
    assert.equal(hit.tier, 'normalized')
    assert.equal(hit.entry?.canonicalId, 'deepseek-v4-pro')
  })

  it('A4: prefixed id with case variance hits the PREFIXED entry, never collapses to bare', () => {
    const hit = matchModelId('deepseek-ai/DEEPSEEK-V4-PRO')
    assert.equal(hit.tier, 'normalized')
    assert.equal(hit.entry?.canonicalId, 'deepseek-ai/DeepSeek-V4-Pro')
    assert.ok(hit.entry!.canonicalId.includes('/'), 'must be the prefixed entry, not the bare one')
  })

  it('A6: combined variant tags strip in either order', () => {
    assert.equal(normalizeModelId('llama-3@fp8:free'), 'llama-3')
    assert.equal(normalizeModelId('llama-3:free@fp8'), 'llama-3')
  })

  it('A7: date stamps — 8-digit 19xx/20xx stripped, shorter or other prefixes kept', () => {
    assert.equal(normalizeModelId('qwen3-max_20260101'), 'qwen3-max')
    assert.equal(normalizeModelId('qwen3-max-2026'), 'qwen3-max-2026')
    assert.equal(normalizeModelId('qwen3-max-12345678'), 'qwen3-max-12345678')
  })

  it('A8: multi-level prefix strips only the FIRST slash, and normalize is NOT idempotent past that', () => {
    assert.equal(normalizeModelId('vendor/sub/model'), 'sub/model')
    // Second pass strips again — documented non-idempotency; the pipeline
    // normalizes each side exactly once, so matching stays consistent.
    assert.equal(normalizeModelId(normalizeModelId('vendor/sub/model')), 'model')
    // Consequently 'sub/model' cannot survive either L2 pass against a
    // 'sub/model' entry — pin the limitation instead of silently matching.
    const hit = matchModelId('vendor/sub/model', [T('sub/model')])
    assert.notEqual(hit.tier, 'normalized')
  })

  it('A9: inner spaces miss L2 but tokenize identically → L3 fuzzy', () => {
    const hit = matchModelId('deepseek v3', [T('deepseek-v3')])
    assert.equal(hit.tier, 'fuzzy')
    assert.equal(hit.needsReview, true)
    assert.equal(hit.entry?.canonicalId, 'deepseek-v3')
  })

  it('A10: Jaccard boundary — exactly 0.6 matches, 0.5 does not', () => {
    const table = [T('qw-rt-yu-op-as')]
    assert.equal(matchModelId('qw-rt-yu', table).tier, 'fuzzy') // 3/(3+5-3) = 0.6
    assert.equal(matchModelId('qw-rt-yu-kk', table).tier, 'unknown') // 3/(4+5-3) = 0.5
    assert.equal(FUZZY_MATCH_THRESHOLD, 0.6)
  })

  it('A11: several candidates ≥ threshold → highest score wins; exact tie → first in table', () => {
    const highest = matchModelId('qw-rt-yu-op', [T('qw-rt-yu'), T('qw-rt-yu-op-as')])
    assert.equal(highest.entry?.canonicalId, 'qw-rt-yu-op-as') // 4/5 beats 3/4

    const tie = matchModelId('qw-rt', [T('qw-rt-yu'), T('qw-rt-op')]) // both 2/3
    assert.equal(tie.tier, 'fuzzy')
    assert.equal(tie.entry?.canonicalId, 'qw-rt-yu')
  })

  it('A12: non-ASCII and pure-digit ids degrade to unknown without crashing', () => {
    assert.equal(matchModelId('通义千问-max', [T('qwen3-max')]).tier, 'unknown') // {max} vs {qwen3,max} = 0.5
    assert.equal(matchModelId('405', [T('llama-405')]).tier, 'unknown') // {405} vs {llama,405} = 0.5
  })

  it('A13: inputs that normalize to nothing are L4 skeletons', () => {
    for (const raw of ['', '   ', ':free', '/', '@']) {
      const hit = matchModelId(raw)
      assert.equal(hit.tier, 'unknown', `raw=${JSON.stringify(raw)}`)
      assert.equal(hit.entry, undefined)
      assert.equal(hit.rawId, raw)
    }
  })

  it('A14: hostile strings pass through verbatim as L4 — matcher never interprets content', () => {
    for (const raw of ['../../etc/passwd', '$(rm -rf /)', 'q\nw', '"quoted"']) {
      const hit = matchModelId(raw)
      assert.equal(hit.tier, 'unknown', `raw=${JSON.stringify(raw)}`)
      assert.equal(hit.rawId, raw)
    }
  })

  it('A15: a 10KB id terminates and yields a valid result', () => {
    const hit = matchModelId('z'.repeat(10_000))
    assert.equal(hit.tier, 'unknown')
    assert.equal(hit.rawId.length, 10_000)
  })
})

describe('B. alias-table invariants', () => {
  it('B1: canonical ids are unique across all presets', () => {
    const seen = new Map<string, number>()
    for (const entry of MODEL_ALIAS_TABLE) {
      seen.set(entry.canonicalId, (seen.get(entry.canonicalId) ?? 0) + 1)
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
    assert.deepEqual(dupes, [], `duplicate canonicalIds: ${dupes.join(', ')}`)
  })

  it('B2: no alias collides with another entry\'s canonical id (ambiguity guard)', () => {
    const canonicals = new Set(MODEL_ALIAS_TABLE.map(e => e.canonicalId))
    for (const entry of MODEL_ALIAS_TABLE) {
      for (const alias of entry.aliases) {
        if (canonicals.has(alias)) {
          assert.equal(alias, entry.canonicalId, `alias '${alias}' of ${entry.canonicalId} collides with a canonical`)
        }
      }
    }
  })

  it('B3: metadata sanity — numeric fields are positive integers when present', () => {
    for (const entry of MODEL_ALIAS_TABLE) {
      const { contextWindow, maxTokens } = entry.metadata
      if (contextWindow !== undefined) {
        assert.ok(Number.isInteger(contextWindow) && contextWindow > 0, `${entry.canonicalId} contextWindow=${contextWindow}`)
      }
      if (maxTokens !== undefined) {
        assert.ok(Number.isInteger(maxTokens) && maxTokens > 0, `${entry.canonicalId} maxTokens=${maxTokens}`)
      }
    }
  })

  it('B4/D1: EVERY table entry is L1-reachable via its canonical and every alias', () => {
    for (const entry of MODEL_ALIAS_TABLE) {
      const viaCanonical = matchModelId(entry.canonicalId)
      assert.equal(viaCanonical.tier, 'exact', `canonical miss: ${entry.canonicalId}`)
      assert.equal(viaCanonical.entry, entry)
      for (const alias of entry.aliases) {
        const viaAlias = matchModelId(alias)
        assert.equal(viaAlias.tier, 'exact', `alias miss: ${alias} → ${entry.canonicalId}`)
        assert.equal(viaAlias.entry, entry)
      }
    }
  })
})

describe('D. provider × model combinations', () => {
  it('D2: one model via three endpoint shapes — bare, aggregator-prefixed, :free variant', () => {
    // Bare official endpoint (case/whitespace noise included).
    const bare = matchModelId('DEEPSEEK-V4-PRO ')
    assert.equal(bare.entry?.canonicalId, 'deepseek-v4-pro')
    // Aggregator endpoints hit the prefixed entry family (own pricing metadata).
    for (const raw of ['deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/deepseek-v4-pro:free']) {
      const hit = matchModelId(raw)
      assert.notEqual(hit.tier, 'unknown', raw)
      assert.equal(hit.entry?.canonicalId, 'deepseek-ai/DeepSeek-V4-Pro', raw)
    }
  })

  it('D3: relay rename — recognizable overlap → L3 review; alien rename → L4', () => {
    const table = [T('deepseek-chat')]
    const relay = matchModelId('mycorp-deepseek-chat', table) // 2/3 overlap
    assert.equal(relay.tier, 'fuzzy')
    assert.equal(relay.needsReview, true)
    const alien = matchModelId('xyz-totally-opaque', table)
    assert.equal(alien.tier, 'unknown')
  })

  it('D4: mixed list with duplicates — order preserved, unknowns first-class, no dedup', () => {
    const results = matchModelIds(['deepseek-v4-pro', 'mystery-x', 'deepseek-v4-pro', 'glm-5.2'])
    assert.equal(results.length, 4, 'duplicates are NOT deduped by the matcher')
    assert.deepEqual(results.map(r => r.rawId), ['deepseek-v4-pro', 'mystery-x', 'deepseek-v4-pro', 'glm-5.2'])
    assert.deepEqual(results.map(r => r.tier), ['exact', 'unknown', 'exact', 'exact'])
  })
})

describe('E. guards', () => {
  it('E2: normalizeModelId is idempotent for ids with ≤ one slash (the pipeline\'s contract)', () => {
    const corpus = [
      'DeepSeek-V4-PRO', 'deepseek-ai/X:free', 'qw@rt', 'qwen3-max-20260101',
      '', ':free', '  spaced  ', '通义千问-max',
    ]
    for (const raw of corpus) {
      assert.equal(
        normalizeModelId(normalizeModelId(raw)),
        normalizeModelId(raw),
        `not idempotent for ${JSON.stringify(raw)}`,
      )
    }
  })
})
