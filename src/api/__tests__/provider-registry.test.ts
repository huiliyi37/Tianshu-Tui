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
import { WELL_KNOWN_DEFAULTS } from '../provider.js'
import { getProviderCacheDefaults } from '../provider-profile.js'

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
  assert.ok(providers.length >= 10)
  const keys = providers.map(p => p.key)
  assert.ok(keys.includes('deepseek'))
  assert.ok(keys.includes('openai'))
  assert.ok(keys.includes('kimi'))
  assert.ok(keys.includes('codex'))
  assert.ok(keys.includes('mimo-api'))
  assert.ok(keys.includes('claude'))
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

test('glm has implicit exact-prefix cache (deepseek-native)', () => {
  const entry = PROVIDER_REGISTRY['glm']
  assert.ok(entry)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(entry.cacheProfile.cacheType, 'exact-prefix')
  assert.ok(entry.cacheProfile.persistent)
  assert.ok(entry.hasUsageMapping, 'GLM must map cached_tokens from usage')
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

test('mimo-api has exact-prefix cache and thinking support', () => {
  const entry = PROVIDER_REGISTRY['mimo-api']
  assert.ok(entry)
  assert.equal(entry.key, 'mimo-api')
  assert.equal(entry.label, 'MiMo API')
  assert.ok(entry.capabilities.supportsThinking)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(entry.cacheProfile.cacheType, 'exact-prefix')
  assert.ok(entry.cacheProfile.persistent)
})

test('claude has anthropic-compatible thinking', () => {
  const entry = PROVIDER_REGISTRY['claude']
  assert.ok(entry)
  assert.equal(entry.key, 'claude')
  assert.equal(entry.capabilities.thinkingFormat, 'anthropic')
  assert.equal(entry.capabilities.effortFormat, 'reasoning_effort')
})

// ─── Cross-Table Consistency Guard ──────────────────────────

test('every WELL_KNOWN provider exists in REGISTRY', () => {
  for (const key of Object.keys(WELL_KNOWN_DEFAULTS)) {
    assert.ok(
      isKnownProvider(key),
      `provider "${key}" in WELL_KNOWN_DEFAULTS but missing from PROVIDER_REGISTRY`,
    )
  }
})

test('every REGISTRY provider has a cache profile in PROFILES', () => {
  for (const key of Object.keys(PROVIDER_REGISTRY)) {
    const cache = getProviderCacheDefaults(key)
    const entry = PROVIDER_REGISTRY[key]!
    assert.equal(
      cache.cacheType, entry.cacheProfile.cacheType,
      `provider "${key}": PROFILES.cacheType (${cache.cacheType}) differs from REGISTRY (${entry.cacheProfile.cacheType})`,
    )
  }
})

test('every REGISTRY provider has capabilities matching WELL_KNOWN', () => {
  for (const [key, entry] of Object.entries(PROVIDER_REGISTRY)) {
    const caps = WELL_KNOWN_DEFAULTS[key]
    if (!caps) continue
    assert.equal(
      caps.supportsThinking, entry.capabilities.supportsThinking,
      `provider "${key}": supportsThinking mismatch`,
    )
    assert.equal(
      caps.thinkingFormat, entry.capabilities.thinkingFormat,
      `provider "${key}": thinkingFormat mismatch`,
    )
    assert.equal(
      caps.prefixCacheStrategy, entry.capabilities.prefixCacheStrategy,
      `provider "${key}": prefixCacheStrategy mismatch`,
    )
  }
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
    supportsResponseFormat: false,
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
    supportsResponseFormat: true,
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
