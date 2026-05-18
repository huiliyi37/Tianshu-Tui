import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressDeadEnds, formatDeadEndRules } from '../dead-end-rules.js'

describe('compressDeadEnds', () => {
  it('returns empty rules for empty paths', () => {
    const rules = compressDeadEnds([])
    assert.deepEqual(rules, [])
  })

  it('merges multiple npx tsx / npm test dead-ends into one test-runner rule', () => {
    const rules = compressDeadEnds([
      'npx tsx --test src/foo.test.ts',
      'npm test',
      'npm exec -- tsx --test src/bar.test.ts',
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'test-runner')
    assert.equal(rules[0]!.severity, 'medium')
  })

  it('generates high severity rule for secret-related dead-ends', () => {
    const rules = compressDeadEnds([
      'printenv API_KEY',
      'cat config.json',
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'security')
    assert.equal(rules[0]!.severity, 'high')
  })

  it('classifies unknown commands as generic', () => {
    const rules = compressDeadEnds([
      'some-unknown-command --flag',
      'another-mystery',
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.kind, 'generic')
    assert.equal(rules[0]!.severity, 'low')
    assert.equal(rules[0]!.recommendation, 'This approach has been tried and failed.')
  })

  it('merges same-kind rules and takes highest severity', () => {
    // path kind: home-directory is low, claude-global-dir is also low
    // but they should merge into one 'path' kind rule
    const rules = compressDeadEnds([
      'find /Users/banxia -maxdepth 4 -type d',
      'ls -la ~/.claude/',
    ])
    const pathRules = rules.filter(r => r.kind === 'path')
    assert.equal(pathRules.length, 1)
    assert.equal(pathRules[0]!.examples.length, 2)
  })

  it('returns at most 3 rules', () => {
    const rules = compressDeadEnds([
      'printenv TOKEN',                    // security
      'npx tsx --test src/a.test.ts',      // test-runner
      'curl -s http://127.0.0.1:8891/v1',  // network
      'source ~/.zshrc',                   // command-substitution
      'some-random-thing',                 // generic
    ])
    assert.equal(rules.length, 3)
    // security should be first (high severity)
    assert.equal(rules[0]!.severity, 'high')
  })

  it('caps examples per rule at 2', () => {
    const rules = compressDeadEnds([
      'npx tsx --test src/a.test.ts',
      'npx tsx --test src/b.test.ts',
      'npx tsx --test src/c.test.ts',
      'npx tsx --test src/d.test.ts',
    ])
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.examples.length, 2)
  })

  it('truncates examples to 60 chars', () => {
    const longPath = 'npx tsx --test ' + 'x'.repeat(80)
    const rules = compressDeadEnds([longPath])
    assert.equal(rules.length, 1)
    for (const ex of rules[0]!.examples) {
      assert.ok(ex.length <= 60, `example too long: ${ex.length}`)
    }
  })

  it('sorts rules by severity descending', () => {
    const rules = compressDeadEnds([
      'source ~/.bashrc',                    // command-substitution low
      'npx tsx --test src/a.test.ts',        // test-runner medium
      'printenv ZHIPU_API_KEY',              // security high
    ])
    assert.equal(rules.length, 3)
    assert.equal(rules[0]!.severity, 'high')
    assert.equal(rules[1]!.severity, 'medium')
    assert.equal(rules[2]!.severity, 'low')
  })

  it('deduplicates identical paths', () => {
    const rules = compressDeadEnds([
      'npx tsx --test src/a.test.ts',
      'npx tsx --test src/a.test.ts',
      'npx tsx --test src/a.test.ts',
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
    const rules = compressDeadEnds(['printenv API_KEY'])
    const output = formatDeadEndRules(rules)
    assert.match(output, /<file-warnings kind="dead-end" compressed="true">/)
    assert.match(output, /<\/file-warnings>/)
  })

  it('includes rule kind in brackets', () => {
    const rules = compressDeadEnds(['printenv API_KEY'])
    const output = formatDeadEndRules(rules)
    assert.match(output, /\[security\]/)
  })

  it('includes recommendation text', () => {
    const rules = compressDeadEnds(['printenv API_KEY'])
    const output = formatDeadEndRules(rules)
    assert.match(output, /Never print secrets or config contents/)
  })

  it('formats multiple rules on separate lines', () => {
    const rules = compressDeadEnds([
      'printenv TOKEN',
      'npx tsx --test src/a.test.ts',
    ])
    const output = formatDeadEndRules(rules)
    const lines = output.split('\n')
    // First line: open tag, last line: close tag, middle: rules
    assert.ok(lines.length >= 4, `expected >= 4 lines, got ${lines.length}`)
    assert.match(lines[0]!, /<file-warnings/)
    assert.match(lines[lines.length - 1]!, /<\/file-warnings>/)
  })
})
