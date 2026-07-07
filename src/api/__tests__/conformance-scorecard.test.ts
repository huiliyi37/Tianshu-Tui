import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runConformanceCheck,
  formatConformanceReport,
  type ConformanceReport,
} from '../conformance-scorecard.js'
import { PROVIDER_REGISTRY, getProviderEntry, addProviderEntry, type ProviderEntry } from '../provider-registry.js'
import type { ProviderCapabilities } from '../provider.js'

// ─── DeepSeek ────────────────────────────────────────────────

test('DeepSeek passes all core checks', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  assert.ok(report.ready, `DeepSeek should be ready: ${report.failed} failed, ${report.warned} warned`)
  assert.equal(report.failed, 0)
  assert.ok(report.score >= 0.8)
})

test('DeepSeek thinking check passes', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  const thinkingCheck = report.checks.find(c => c.id === 'has_thinking')
  assert.ok(thinkingCheck)
  assert.ok(thinkingCheck!.passed, thinkingCheck!.message)
})

test('DeepSeek cache strategy check passes', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  const cacheCheck = report.checks.find(c => c.id === 'cache_strategy')
  assert.ok(cacheCheck)
  assert.ok(cacheCheck!.passed, cacheCheck!.message)
})

// ─── OpenAI ──────────────────────────────────────────────────

test('OpenAI passes all checks', () => {
  const entry = getProviderEntry('openai')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  assert.ok(report.ready)
  assert.equal(report.failed, 0)
})

// ─── Provider with cache gap ─────────────────────────────────

test('provider with cache profile but no strategy gets warned', () => {
  // Use minimax: cacheType is 'none', prefixCacheStrategy is 'none' — should be ok
  const entry = getProviderEntry('minimax')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  // minimax has cacheType='none' and prefixCacheStrategy='none' → cache check passes
  const cacheCheck = report.checks.find(c => c.id === 'cache_strategy')
  assert.ok(cacheCheck)
  assert.ok(cacheCheck!.passed, cacheCheck!.message)
})

test('cache strategy mismatch between capabilities and profile is detected', () => {
  // Build a synthetic entry with mismatch
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const mismatched: ProviderEntry = {
    ...entry!,
    cacheProfile: { ...entry!.cacheProfile, cacheType: 'none' },
  }
  const report = runConformanceCheck(mismatched)
  const cacheCheck = report.checks.find(c => c.id === 'cache_strategy')
  assert.ok(cacheCheck)
  assert.ok(!cacheCheck!.passed, 'Should fail when cacheType mismatches prefixCacheStrategy')
})

// ─── Strict mode ─────────────────────────────────────────────

test('strict mode promotes warnings to errors', () => {
  // Build an entry with a known warn-level issue
  const caps: ProviderCapabilities = {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',  // will trigger effort_control warn
    prefixCacheStrategy: 'none',
    supportsResponseFormat: true,
  }
  addProviderEntry('strict_test', 'StrictTest', caps)

  const entry = getProviderEntry('strict_test')
  assert.ok(entry)

  const normalReport = runConformanceCheck(entry!)
  const effortCheck = normalReport.checks.find(c => c.id === 'effort_control')
  assert.ok(effortCheck)
  assert.ok(!effortCheck!.passed)
  assert.equal(effortCheck!.severity, 'warn')

  const strictReport = runConformanceCheck(entry!, { strict: true })
  const strictEffortCheck = strictReport.checks.find(c => c.id === 'effort_control')
  assert.ok(strictEffortCheck)
  assert.ok(!strictEffortCheck!.passed)
  assert.equal(strictEffortCheck!.severity, 'error')

  delete (PROVIDER_REGISTRY as Record<string, ProviderEntry>)['strict_test']
})

// ─── Report structure ────────────────────────────────────────

test('conformance report has correct structure', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)

  assert.ok(report.provider === 'deepseek')
  assert.ok(report.checks.length >= 3)
  assert.ok(report.score >= 0 && report.score <= 1)
  assert.ok(report.passed + report.failed + report.warned <= report.checks.length)
  assert.ok(typeof report.ready === 'boolean')

  for (const check of report.checks) {
    assert.ok(check.id.length > 0, `Check must have id`)
    assert.ok(check.name.length > 0, `Check ${check.id} must have name`)
    assert.ok(check.message.length > 0, `Check ${check.id} must have message`)
    assert.ok(['error', 'warn', 'info'].includes(check.severity),
      `Check ${check.id} severity must be error|warn|info, got ${check.severity}`)
  }
})

// ─── Skip checks ─────────────────────────────────────────────

test('skip option excludes specific checks', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const fullReport = runConformanceCheck(entry!)
  const skippedReport = runConformanceCheck(entry!, { skip: ['bug_disclosure'] })

  assert.ok(fullReport.checks.length > skippedReport.checks.length)
  const bugCheck = skippedReport.checks.find(c => c.id === 'bug_disclosure')
  assert.equal(bugCheck, undefined)
})

// ─── Formatting ──────────────────────────────────────────────

test('formatConformanceReport produces markdown', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  const md = formatConformanceReport(report)

  assert.ok(md.includes('# Conformance: deepseek'))
  assert.ok(md.includes('Score'))
  assert.ok(md.includes('Status'))
  assert.ok(md.includes('Ready'))
})

test('formatConformanceReport includes suggestions when issues found', () => {
  const caps: ProviderCapabilities = {
    supportsThinking: true,
    thinkingFormat: 'none',  // mismatch — will fail
    supportsCacheControl: false,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: true,
  }
  addProviderEntry('fmt_test', 'FmtTest', caps)

  const entry = getProviderEntry('fmt_test')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  const md = formatConformanceReport(report)

  assert.ok(report.failed > 0, `Expected failures but got ${report.failed} failed`)
  assert.ok(md.includes('Suggestions'))

  delete (PROVIDER_REGISTRY as Record<string, ProviderEntry>)['fmt_test']
})

// ─── All built-in providers are at least warn-free ───────────

test('all built-in providers have passing required checks', () => {
  for (const [key] of Object.entries(PROVIDER_REGISTRY)) {
    const entry = getProviderEntry(key)
    assert.ok(entry)
    const report = runConformanceCheck(entry!)
    // All built-in providers should have 0 errors (warnings are ok)
    assert.equal(report.failed, 0, `${key}: unexpected errors: ${report.checks.filter(c => !c.passed && c.severity === 'error').map(c => c.message).join('; ')}`)
  }
})

// ─── capabilityOverrides ─────────────────────────────────────

test('capabilityOverrides are applied to effective entry', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  // Override: pretend DeepSeek doesn't support thinking
  const report = runConformanceCheck(entry!, {
    capabilityOverrides: {
      supportsThinking: false,
      thinkingFormat: 'none',
    },
  })
  const thinkingCheck = report.checks.find(c => c.id === 'has_thinking')
  assert.ok(thinkingCheck)
  // With overrides, thinking should be marked as "not supported" → pass (info)
  assert.ok(thinkingCheck!.passed, `Thinking check should pass with overrides: ${thinkingCheck!.message}`)
  assert.ok(thinkingCheck!.message.includes('not supported'))
})

test('capabilityOverrides with cache control changes score', () => {
  // Use openai: partial-prefix cache, no prefix strategy
  const entry = getProviderEntry('openai')
  assert.ok(entry)
  const baseReport = runConformanceCheck(entry!)
  const baseCacheCheck = baseReport.checks.find(c => c.id === 'cache_strategy')
  assert.ok(baseCacheCheck)
  assert.ok(baseCacheCheck!.passed, `OpenAI base cache should pass`)

  // Override: set anthropic-cache-control on a partial-prefix profile — mismatch
  const overrideReport = runConformanceCheck(entry!, {
    capabilityOverrides: { prefixCacheStrategy: 'anthropic-cache-control' },
  })
  const overrideCacheCheck = overrideReport.checks.find(c => c.id === 'cache_strategy')
  assert.ok(overrideCacheCheck)
  assert.ok(!overrideCacheCheck!.passed,
    `Cache check should fail with mismatched override: ${overrideCacheCheck!.message}`)
})

// ─── OpenAI partial-prefix guidance ──────────────────────────

test('OpenAI partial-prefix cache does not trigger misleading guidance', () => {
  const entry = getProviderEntry('openai')
  assert.ok(entry)
  const report = runConformanceCheck(entry!)
  const cacheCheck = report.checks.find(c => c.id === 'cache_strategy')
  assert.ok(cacheCheck)
  assert.ok(cacheCheck!.passed)
  // Must not suggest anthropic-cache-control for partial-prefix
  assert.ok(!cacheCheck!.message.includes('anthropic-cache-control'),
    `OpenAI should not be advised to use anthropic cache: ${cacheCheck!.message}`)
  assert.ok(cacheCheck!.suggestion === undefined || !cacheCheck!.suggestion.includes('anthropic-cache-control'),
    `OpenAI should not suggest anthropic cache: ${cacheCheck!.suggestion}`)
})
