import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressDeadEnds, formatDeadEndRules } from '../dead-end-rules.js'

describe('compressDeadEnds', () => {
  it('returns empty rules for empty entries', () => {
    const rules = compressDeadEnds([])
    assert.deepEqual(rules, [])
  })

  it('merges multiple npx tsx / npm test dead-ends into one test-runner rule', () => {
    const rules = compressDeadEnds([
      { path: 'npx tsx --test src/foo.test.ts' },
      { path: 'npm test' },
      { path: 'npm exec -- tsx --test src/bar.test.ts' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'test-runner')
    assert.equal(rules[0]!.severity, 'medium')
  })

  it('generates high severity rule for secret-related dead-ends', () => {
    const rules = compressDeadEnds([
      { path: 'printenv API_KEY' },
      { path: 'cat config.json' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'security')
    assert.equal(rules[0]!.severity, 'high')
  })

  it('classifies unknown commands as generic with default recommendation', () => {
    const rules = compressDeadEnds([
      { path: 'some-unknown-command --flag' },
      { path: 'another-mystery' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'generic')
    assert.equal(rules[0]!.severity, 'low')
    assert.equal(rules[0]!.recommendation, 'This approach has been tried and failed.')
  })

  it('uses entry context as generic recommendation when available', () => {
    const rules = compressDeadEnds([
      { path: 'bash-command', context: 'npm run build failed with TS2345' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'generic')
    assert.match(rules[0]!.recommendation, /npm run build failed with TS2345/)
  })

  it('prefers richest generic recommendation (with context)', () => {
    const rules = compressDeadEnds([
      { path: 'bash-command' },
      { path: 'another-cmd', context: 'specific error from prior attempt' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'generic')
    assert.match(rules[0]!.recommendation, /specific error from prior attempt/)
  })

  it('merges same-kind rules and takes highest severity', () => {
    // path kind: home-directory is low, claude-global-dir is also low
    // but they should merge into one 'path' kind rule
    const rules = compressDeadEnds([
      { path: 'find /Users/banxia -maxdepth 4 -type d' },
      { path: 'ls -la ~/.claude/' },
    ])
    const pathRules = rules.filter(r => r.kind === 'path')
    assert.equal(pathRules.length, 1)
    assert.equal(pathRules[0]!.examples.length, 2)
  })

  it('returns at most 3 rules', () => {
    const rules = compressDeadEnds([
      { path: 'printenv TOKEN' },
      { path: 'npx tsx --test src/a.test.ts' },
      { path: 'curl -s http://127.0.0.1:8891/v1' },
      { path: 'source ~/.zshrc' },
      { path: 'some-random-thing' },
    ])
    assert.equal(rules.length, 3)
    // security should be first (high severity)
    assert.equal(rules[0]!.severity, 'high')
  })

  it('caps examples per rule at 2', () => {
    const rules = compressDeadEnds([
      { path: 'npx tsx --test src/a.test.ts' },
      { path: 'npx tsx --test src/b.test.ts' },
      { path: 'npx tsx --test src/c.test.ts' },
      { path: 'npx tsx --test src/d.test.ts' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.examples.length, 2)
  })

  it('truncates examples to 60 chars', () => {
    const longPath = 'npx tsx --test ' + 'x'.repeat(80)
    const rules = compressDeadEnds([{ path: longPath }])
    assert.equal(rules.length, 1)
    for (const ex of rules[0]!.examples) {
      assert.ok(ex.length <= 60, `example too long: ${ex.length}`)
    }
  })

  it('sorts rules by severity descending', () => {
    const rules = compressDeadEnds([
      { path: 'source ~/.bashrc' },
      { path: 'npx tsx --test src/a.test.ts' },
      { path: 'printenv ZHIPU_API_KEY' },
    ])
    assert.equal(rules.length, 3)
    assert.equal(rules[0]!.severity, 'high')
    assert.equal(rules[1]!.severity, 'medium')
    assert.equal(rules[2]!.severity, 'low')
  })

  it('deduplicates identical paths', () => {
    const rules = compressDeadEnds([
      { path: 'npx tsx --test src/a.test.ts' },
      { path: 'npx tsx --test src/a.test.ts' },
      { path: 'npx tsx --test src/a.test.ts' },
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.examples.length, 1)
  })
})

describe('formatDeadEndRules', () => {
  it('returns empty string for empty rules', () => {
    assert.equal(formatDeadEndRules([]), '')
  })

  it('outputs correct XML format with compressed="true"', () => {
    const rules = compressDeadEnds([{ path: 'printenv API_KEY' }])
    const output = formatDeadEndRules(rules)
    assert.match(output, /<file-warnings kind="dead-end" compressed="true">/)
    assert.match(output, /<\/file-warnings>/)
  })

  it('includes rule kind in brackets', () => {
    const rules = compressDeadEnds([{ path: 'printenv API_KEY' }])
    const output = formatDeadEndRules(rules)
    assert.match(output, /\[security\]/)
  })

  it('includes recommendation text', () => {
    const rules = compressDeadEnds([{ path: 'printenv API_KEY' }])
    const output = formatDeadEndRules(rules)
    assert.match(output, /Never print secrets or config contents/)
  })

  it('formats multiple rules on separate lines', () => {
    const rules = compressDeadEnds([
      { path: 'printenv TOKEN' },
      { path: 'npx tsx --test src/a.test.ts' },
    ])
    const output = formatDeadEndRules(rules)
    const lines = output.split('\n')
    // First line: open tag, last line: close tag, middle: rules
    assert.ok(lines.length >= 4, `expected >= 4 lines, got ${lines.length}`)
    assert.match(lines[0]!, /<file-warnings/)
    assert.match(lines[lines.length - 1]!, /<\/file-warnings>/)
  })
})
