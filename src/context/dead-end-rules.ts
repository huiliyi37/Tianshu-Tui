/**
 * Dead-end rule compression — converts raw dead-end path lists into
 * compressed, deduplicated rule summaries for context injection.
 *
 * Pure functions only — no I/O, no side effects.
 */

export interface DeadEndRule {
  kind: 'security' | 'test-runner' | 'path' | 'network' | 'command-substitution' | 'generic'
  pattern: string
  recommendation: string
  examples: string[]
  severity: 'low' | 'medium' | 'high'
}

// ─── Rule detection definitions (priority order) ────────────────────

interface RuleDef {
  kind: DeadEndRule['kind']
  pattern: string
  recommendation: string
  severity: DeadEndRule['severity']
  test: (path: string) => boolean
}

const RULE_DEFS: RuleDef[] = [
  {
    kind: 'security',
    pattern: 'secrets/config',
    recommendation: 'Never print secrets or config contents.',
    severity: 'high',
    test: (p) =>
      /API_KEY|TOKEN|config\.json|printenv/i.test(p),
  },
  {
    kind: 'test-runner',
    pattern: 'npx/npm test',
    recommendation: 'Use `./node_modules/.bin/tsx --test ...` for targeted tests in this repo.',
    severity: 'medium',
    test: (p) =>
      /\bnpx\s+tsx\s+--test\b/.test(p)
      || /\bnpm\s+test\b/.test(p)
      || /\bnpm\s+exec\s+--\s+tsx\s+--test\b/.test(p),
  },
  {
    kind: 'path',
    pattern: 'home-directory',
    recommendation: 'Do not search home directory unless user explicitly asks.',
    severity: 'low',
    test: (p) =>
      /\bfind\b/.test(p) && /(~\/|\/Users\/)/.test(p),
  },
  {
    kind: 'path',
    pattern: 'claude-global-dir',
    recommendation: 'Do not inspect global Claude dirs unless user explicitly asks.',
    severity: 'low',
    test: (p) =>
      /\.claude/.test(p) || /ls\s+~\/\.claude/.test(p),
  },
  {
    kind: 'network',
    pattern: 'localhost-probe',
    recommendation: 'Do not probe local service endpoints unless instructed.',
    severity: 'medium',
    test: (p) =>
      /\bcurl\b/.test(p) && /(localhost|127\.0\.0\.1)/.test(p),
  },
  {
    kind: 'command-substitution',
    pattern: 'git-diff-no-index',
    recommendation: 'Use `diff` tool or `git diff -- <path>` for tracked files.',
    severity: 'low',
    test: (p) =>
      /git\s+diff\s+--no-index\s+\/dev\/null/.test(p),
  },
  {
    kind: 'command-substitution',
    pattern: 'source-rc',
    recommendation: 'Do not source shell RC files; use direct commands instead.',
    severity: 'low',
    test: (p) =>
      /source\s+~\/\.(zshrc|bashrc)/.test(p),
  },
]

const SEVERITY_RANK: Record<DeadEndRule['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
}

const MAX_RULES = 3
const MAX_EXAMPLES_PER_RULE = 2
const MAX_EXAMPLE_LENGTH = 60

// ─── Public API ─────────────────────────────────────────────────────

export interface DeadEndEntry {
  path: string
  context?: string
}

/**
 * Compress a deduplicated list of dead-end entries into at most 3 rules.
 * Same-kind paths are merged; severity takes the highest; examples are capped.
 * Generic fallback uses the first available entry context as recommendation.
 */
export function compressDeadEnds(entries: DeadEndEntry[]): DeadEndRule[] {
  if (entries.length === 0) return []

  // Deduplicate by path, keeping the entry with the richest context
  const byPath = new Map<string, DeadEndEntry>()
  for (const entry of entries) {
    const existing = byPath.get(entry.path)
    if (!existing || (!existing.context && entry.context)) {
      byPath.set(entry.path, entry)
    }
  }

  // Map each entry to its matching rule definition (first match wins)
  const entryToKind = new Map<DeadEndEntry, { kind: DeadEndRule['kind']; def: RuleDef }>()
  for (const entry of byPath.values()) {
    const def = RULE_DEFS.find(d => d.test(entry.path))
    if (def) {
      entryToKind.set(entry, { kind: def.kind, def })
    } else {
      entryToKind.set(entry, {
        kind: 'generic',
        def: {
          kind: 'generic',
          pattern: 'unknown',
          recommendation: entry.context
            ? `Previously failed: ${entry.context}`
            : 'This approach has been tried and failed.',
          severity: 'low',
          test: () => false,
        },
      })
    }
  }

  // Group by kind, preserving first-seen rule def for each kind
  const byKind = new Map<DeadEndRule['kind'], { def: RuleDef; examples: string[] }>()
  for (const [entry, { kind, def }] of entryToKind) {
    const truncated = entry.path.length > MAX_EXAMPLE_LENGTH
      ? entry.path.slice(0, MAX_EXAMPLE_LENGTH)
      : entry.path
    const existing = byKind.get(kind)
    if (existing) {
      // Merge: accumulate examples, upgrade severity
      existing.examples.push(truncated)
      if (SEVERITY_RANK[def.severity] > SEVERITY_RANK[existing.def.severity]) {
        existing.def = { ...def }
      }
      // Keep the richest generic recommendation (with context)
      if (kind === 'generic' && def.recommendation !== 'This approach has been tried and failed.') {
        existing.def = { ...def }
      }
    } else {
      byKind.set(kind, { def: { ...def }, examples: [truncated] })
    }
  }

  // Build rules, cap examples per rule
  const rules: DeadEndRule[] = []
  for (const [_kind, { def, examples }] of byKind) {
    rules.push({
      kind: def.kind,
      pattern: def.pattern,
      recommendation: def.recommendation,
      examples: examples.slice(0, MAX_EXAMPLES_PER_RULE),
      severity: def.severity,
    })
  }

  // Sort by severity descending, then by kind for stability
  rules.sort((a, b) => {
    const diff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (diff !== 0) return diff
    return a.kind.localeCompare(b.kind)
  })

  return rules.slice(0, MAX_RULES)
}

/**
 * Format compressed dead-end rules into XML for context injection.
 */
export function formatDeadEndRules(rules: DeadEndRule[]): string {
  if (rules.length === 0) return ''

  const lines = rules.map(r => `- [${r.kind}] ${r.recommendation}`)
  return [
    '<天枢-观测 type="dead-end" compressed="true">',
    ...lines,
    '</天枢-观测>',
  ].join('\n')
}
