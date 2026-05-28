import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_REGISTRY,
  providerEntrySchema,
  getProviderEntry,
  listProviders,
  isKnownProvider,
  addProviderEntry,
  type ProviderEntry,
} from '../provider-registry.js'

// ─── Schema Tests ────────────────────────────────────────────

test('providerEntrySchema validates a complete deepseek entry', () => {
  const entry = PROVIDER_REGISTRY['deepseek']
  assert.ok(entry)
  const parsed = providerEntrySchema.safeParse(entry)
  assert.ok(parsed.success, parsed.error?.issues.map(i => i.message).join(', '))
})

test('providerEntrySchema validates all built-in entries', () => {
  for (const [key, entry] of Object.entries(PROVIDER_REGISTRY)) {
    const parsed = providerEntrySchema.safeParse(entry)
    assert.ok(parsed.success, `${key}: ${parsed.error?.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`)
  }
})

test('providerEntrySchema rejects missing key', () => {
  const result = providerEntrySchema.safeParse({
    label: 'Test',
    capabilities: {},
    cacheProfile: {},
    hasUsageMapping: false,
  })
  assert.ok(!result.success)
})

test('providerEntrySchema rejects invalid thinkingFormat', () => {
  const entry = { ...PROVIDER_REGISTRY['deepseek']! }
  entry.capabilities = { ...entry.capabilities, thinkingFormat: 'invalid' as 'anthropic' }
  const result = providerEntrySchema.safeParse(entry)
  assert.ok(!result.success)
})

// ─── Lookup Tests ────────────────────────────────────────────

test('getProviderEntry returns entry for known provider', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  assert.equal(entry.key, 'deepseek')
  assert.equal(entry.label, 'DeepSeek')
})

test('getProviderEntry returns undefined for unknown provider', () => {
  assert.equal(getProviderEntry('nonexistent'), undefined)
})

test('listProviders returns all entries', () => {
  const providers = listProviders()
  assert.ok(providers.length >= 8)
  const keys = providers.map(p => p.key)
  assert.ok(keys.includes('deepseek'))
  assert.ok(keys.includes('openai'))
  assert.ok(keys.includes('kimi'))
  assert.ok(keys.includes('codex'))
})

test('isKnownProvider returns true for known providers', () => {
  assert.ok(isKnownProvider('deepseek'))
  assert.ok(isKnownProvider('openai'))
  assert.ok(!isKnownProvider('unknown_provider'))
})

// ─── Registry Integrity Tests ────────────────────────────────

test('deepseek has exact-prefix cache strategy', () => {
  const entry = PROVIDER_REGISTRY['deepseek']
  assert.ok(entry)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(entry.cacheProfile.cacheType, 'exact-prefix')
  assert.ok(entry.cacheProfile.persistent)
})

test('deepseek has usage mapping', () => {
  const entry = PROVIDER_REGISTRY['deepseek']
  assert.ok(entry)
  assert.ok(entry.hasUsageMapping)
})

test('openai has explicit-breakpoint cache', () => {
  const entry = PROVIDER_REGISTRY['openai']
  assert.ok(entry)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'none')
  assert.equal(entry.cacheProfile.cacheType, 'partial-prefix')
})

test('codex has OAuth-compatible registry metadata', () => {
  const entry = PROVIDER_REGISTRY['codex']
  assert.ok(entry)
  assert.equal(entry.key, 'codex')
  assert.equal(entry.capabilities.thinkingFormat, 'openai')
  assert.equal(entry.cacheProfile.cacheType, 'partial-prefix')
})

test('all entries have non-empty notes or explicit empty array', () => {
  for (const [key, entry] of Object.entries(PROVIDER_REGISTRY)) {
    assert.ok(Array.isArray(entry.notes), `${key}: notes must be an array`)
  }
})

test('all entries have consistent key field', () => {
  for (const [key, entry] of Object.entries(PROVIDER_REGISTRY)) {
    assert.equal(entry.key, key, `${key}: key must match registry key`)
  }
})

test('all entries have non-empty label', () => {
  for (const [, entry] of Object.entries(PROVIDER_REGISTRY)) {
    assert.ok(entry.label.length > 0)
  }
})

// ─── Dynamic Registration ───────────────────────────────────

test('addProviderEntry adds a new provider', () => {
  const entry = addProviderEntry('test_provider', 'Test Provider', {
    supportsThinking: false,
    thinkingFormat: 'none',
    supportsCacheControl: false,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
  })

  assert.equal(entry.key, 'test_provider')
  assert.equal(entry.label, 'Test Provider')
  assert.ok(isKnownProvider('test_provider'))

  // Verify it's in the registry
  const found = getProviderEntry('test_provider')
  assert.ok(found)
  assert.equal(found.label, 'Test Provider')

  // Clean up — remove from registry
  delete (PROVIDER_REGISTRY as Record<string, ProviderEntry>)['test_provider']
})

test('addProviderEntry with notes', () => {
  const entry = addProviderEntry('noted_provider', 'Noted', {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: false,
    stripParams: ['top_k'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
  }, ['This is a note', 'Another note'])

  assert.equal(entry.notes.length, 2)
  assert.equal(entry.notes[0], 'This is a note')
  assert.equal(entry.capabilities.stripParams[0], 'top_k')

  delete (PROVIDER_REGISTRY as Record<string, ProviderEntry>)['noted_provider']
})

test('addProviderEntry overwrites existing entry', () => {
  const original = getProviderEntry('deepseek')
  assert.ok(original)

  addProviderEntry('deepseek', 'DeepSeek Custom', {
    ...original.capabilities,
    hasToolJsonInContentBug: false,
  })

  const updated = getProviderEntry('deepseek')
  assert.ok(updated)
  assert.equal(updated.capabilities.hasToolJsonInContentBug, false)

  // Restore
  addProviderEntry('deepseek', 'DeepSeek', {
    ...original.capabilities,
  })
})
