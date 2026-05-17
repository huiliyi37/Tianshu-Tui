/**
 * Provider Conformance Scorecard
 *
 * Consumes a ProviderEntry (from provider-registry) and optional config-level
 * overrides to produce a ConformanceReport. The report identifies gaps between
 * declared capabilities and expected behavior patterns.
 *
 * Intended consumers:
 *   - `npm run benchmark` provider conformance tasks
 *   - R4 Open Model Lab capability matrix
 *   - Runtime warning when a provider is first used
 */

import type { ProviderEntry } from './provider-registry.js'
import type { ProviderCapabilities } from './provider.js'

// ─── Types ───────────────────────────────────────────────────

export interface ConformanceCheck {
  /** Unique check identifier */
  id: string
  /** Human-readable check name */
  name: string
  /** Whether the check passed */
  passed: boolean
  /** Severity when non-passing */
  severity: 'error' | 'warn' | 'info'
  /** Descriptive message */
  message: string
  /** Suggested fix, if applicable */
  suggestion?: string
}

export interface ConformanceReport {
  /** Provider key */
  provider: string
  /** All checks */
  checks: ConformanceCheck[]
  /** 0-1 score: passed / total */
  score: number
  /** Counts */
  passed: number
  failed: number
  warned: number
  /** Whether the provider is ready for production use */
  ready: boolean
}

export interface ConformanceOptions {
  /** Enable strict mode: 'warn' checks become 'error' */
  strict?: boolean
  /** Skip specific check IDs */
  skip?: string[]
  /** Config-level capability overrides (from user config) */
  capabilityOverrides?: Partial<ProviderCapabilities>
}

// ─── Check Definitions ──────────────────────────────────────

function checkThinkingSupport(entry: ProviderEntry): ConformanceCheck {
  const caps = entry.capabilities
  if (!caps.supportsThinking) {
    return {
      id: 'has_thinking',
      name: 'Thinking support',
      passed: true,
      severity: 'info',
      message: 'Thinking is not supported — this is a valid configuration',
    }
  }

  // Only thinkingFormat is critical here — effort control is checked separately
  const formatOk = caps.thinkingFormat !== 'none'

  if (formatOk) {
    return {
      id: 'has_thinking',
      name: 'Thinking support',
      passed: true,
      severity: 'info',
      message: `Thinking supported (format: ${caps.thinkingFormat}, effort: ${caps.effortFormat})`,
    }
  }

  return {
    id: 'has_thinking',
    name: 'Thinking support',
    passed: false,
    severity: 'error',
    message: 'thinkingFormat is "none" but supportsThinking is true — provider cannot send thinking blocks',
    suggestion: 'Set thinkingFormat to "anthropic" or "openai" to match the provider API',
  }
}

function checkCacheStrategy(entry: ProviderEntry): ConformanceCheck {
  const caps = entry.capabilities
  const profile = entry.cacheProfile

  // No cache strategy + no cache profile = consistent
  if (caps.prefixCacheStrategy === 'none' && profile.cacheType === 'none') {
    return {
      id: 'cache_strategy',
      name: 'Cache strategy',
      passed: true,
      severity: 'info',
      message: 'No prefix cache configured',
    }
  }

  // Has cache strategy
  if (caps.prefixCacheStrategy !== 'none') {
    // Strategy active but profile doesn't match: deepseek-native expects exact-prefix
    const strategyToCacheType: Record<string, string> = {
      'deepseek-native': 'exact-prefix',
      'anthropic-cache-control': 'explicit-breakpoint',
    }
    const expected = strategyToCacheType[caps.prefixCacheStrategy]
    if (expected && profile.cacheType !== expected) {
      return {
        id: 'cache_strategy',
        name: 'Cache strategy',
        passed: false,
        severity: 'warn',
        message: `prefixCacheStrategy "${caps.prefixCacheStrategy}" but cacheProfile.cacheType is "${profile.cacheType}" (expected "${expected}")`,
        suggestion: 'Align cache strategy with provider profile or override in config',
      }
    }

    return {
      id: 'cache_strategy',
      name: 'Cache strategy',
      passed: true,
      severity: 'info',
      message: `Prefix cache: ${caps.prefixCacheStrategy} (${profile.cacheType}, ${profile.persistent ? 'persistent' : 'ephemeral'})`,
    }
  }

  // No strategy but profile has cache — likely missed config.
  // Partial-prefix (OpenAI) is auto-cached without explicit strategy; 'none' is acceptable.
  if (profile.cacheType === 'partial-prefix') {
    return {
      id: 'cache_strategy',
      name: 'Cache strategy',
      passed: true,
      severity: 'info',
      message: `Prefix cache: partial-prefix (auto, no explicit strategy needed)`,
    }
  }

  return {
    id: 'cache_strategy',
    name: 'Cache strategy',
    passed: false,
    severity: 'warn',
    message: `No prefixCacheStrategy declared but cacheProfile shows "${profile.cacheType}" — cache may be available`,
    suggestion: `Set prefixCacheStrategy to match the provider's cache: ${profile.cacheType === 'exact-prefix' ? 'deepseek-native' : 'anthropic-cache-control'}`,
  }
}

function checkUsageMapping(entry: ProviderEntry): ConformanceCheck {
  if (entry.hasUsageMapping) {
    return {
      id: 'usage_mapping',
      name: 'Usage field mapping',
      passed: true,
      severity: 'info',
      message: 'Custom usage field mapping registered',
    }
  }

  // Providers without usage mapping use the default — this is OK for OpenAI-compatible APIs
  return {
    id: 'usage_mapping',
    name: 'Usage field mapping',
    passed: true,
    severity: 'info',
    message: 'Using default usage field mapping (OpenAI-compatible)',
  }
}

function checkStripParams(entry: ProviderEntry): ConformanceCheck {
  const params = entry.capabilities.stripParams
  if (params.length > 0) {
    return {
      id: 'strip_params',
      name: 'Parameter stripping',
      passed: true,
      severity: 'info',
      message: `Strips ${params.length} unsupported param(s): ${params.join(', ')}`,
    }
  }

  return {
    id: 'strip_params',
    name: 'Parameter stripping',
    passed: true,
    severity: 'info',
    message: 'No parameters stripped — full request passthrough',
  }
}

function checkBugDisclosure(entry: ProviderEntry): ConformanceCheck {
  if (!entry.capabilities.hasToolJsonInContentBug) {
    return {
      id: 'bug_disclosure',
      name: 'Known bugs',
      passed: true,
      severity: 'info',
      message: 'No known bugs disclosed',
    }
  }

  const hasNote = entry.notes.some(
    n => n.toLowerCase().includes('bug') || n.toLowerCase().includes('tool json'),
  )

  return {
    id: 'bug_disclosure',
    name: 'Known bugs',
    passed: hasNote,
    severity: 'warn',
    message: hasNote
      ? 'Tool JSON-in-content bug documented in notes'
      : 'hasToolJsonInContentBug is true but no bug note found — add a note describing the impact',
    suggestion: hasNote ? undefined : 'Add a note: e.g. "Tool JSON may appear in text content — filter with toolJsonExtractor"',
  }
}

function checkEffortControl(entry: ProviderEntry): ConformanceCheck {
  if (!entry.capabilities.supportsThinking) {
    return {
      id: 'effort_control',
      name: 'Effort control',
      passed: true,
      severity: 'info',
      message: 'Not applicable — thinking not supported',
    }
  }

  if (entry.capabilities.effortFormat !== 'none') {
    return {
      id: 'effort_control',
      name: 'Effort control',
      passed: true,
      severity: 'info',
      message: `Effort control: ${entry.capabilities.effortFormat}`,
    }
  }

  return {
    id: 'effort_control',
    name: 'Effort control',
    passed: false,
    severity: 'warn',
    message: 'Thinking is supported but effort cannot be controlled (effortFormat: "none")',
    suggestion: 'Users cannot adjust reasoning depth — auto-reasoning will be disabled for this provider',
  }
}

// ─── Aggregator ──────────────────────────────────────────────

const ALL_CHECKS = [
  checkThinkingSupport,
  checkCacheStrategy,
  checkUsageMapping,
  checkStripParams,
  checkBugDisclosure,
  checkEffortControl,
]

export function runConformanceCheck(
  entry: ProviderEntry,
  opts: ConformanceOptions = {},
): ConformanceReport {
  // Apply config-level capability overrides to produce an effective entry
  const effectiveEntry = opts.capabilityOverrides
    ? applyOverrides(entry, opts.capabilityOverrides)
    : entry

  const skipSet = new Set(opts.skip ?? [])
  const checks = ALL_CHECKS
    .filter(fn => !skipSet.has(runCheckId(fn)))
    .map(fn => {
      const check = fn(effectiveEntry)
      if (opts.strict && check.severity === 'warn' && !check.passed) {
        return { ...check, severity: 'error' as const }
      }
      return check
    })

  const passed = checks.filter(c => c.passed).length
  const failed = checks.filter(c => !c.passed && c.severity === 'error').length
  const warned = checks.filter(c => !c.passed && c.severity === 'warn').length
  const score = checks.length > 0 ? passed / checks.length : 1

  return {
    provider: entry.key,
    checks,
    score: Math.round(score * 100) / 100,
    passed,
    failed,
    warned,
    ready: failed === 0,
  }
}

/** Apply config-level overrides to produce an effective entry for conformance checking */
function applyOverrides(
  entry: ProviderEntry,
  overrides: Partial<ProviderCapabilities>,
): ProviderEntry {
  return {
    ...entry,
    capabilities: {
      ...entry.capabilities,
      ...overrides,
    },
    hasUsageMapping: overrides.mapUsage !== undefined
      ? true
      : entry.hasUsageMapping,
  }
}

/** Generate a markdown summary of the conformance report */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines: string[] = [
    `# Conformance: ${report.provider}`,
    '',
    `**Score:** ${(report.score * 100).toFixed(0)}% (${report.passed}/${report.checks.length} passed)`,
    `**Status:** ${report.ready ? '✅ Ready' : '⚠️ Issues found'}`,
    '',
    '| Check | Result | Severity |',
    '|-------|--------|----------|',
  ]

  for (const check of report.checks) {
    const icon = check.passed ? '✅' : check.severity === 'error' ? '❌' : '⚠️'
    const severity = check.passed ? '-' : check.severity
    lines.push(`| ${check.name} | ${icon} | ${severity} |`)
  }

  lines.push('')

  const suggestions = report.checks
    .filter(c => c.suggestion)
    .map(c => `- **${c.name}:** ${c.suggestion!}`)

  if (suggestions.length > 0) {
    lines.push('## Suggestions', '', ...suggestions, '')
  }

  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────

function runCheckId(fn: (entry: ProviderEntry) => ConformanceCheck): string {
  // Call with a dummy to get the ID — all checks return id regardless of entry
  const result = fn({
    key: '',
    label: '',
    capabilities: {
      supportsThinking: false,
      thinkingFormat: 'none',
      supportsCacheControl: true,
      stripParams: [],
      hasToolJsonInContentBug: false,
      effortFormat: 'none',
      prefixCacheStrategy: 'none',
    },
    cacheProfile: { cacheType: 'none', persistent: false, minCacheTokens: 0 },
    hasUsageMapping: false,
    notes: [],
  })
  return result.id
}
