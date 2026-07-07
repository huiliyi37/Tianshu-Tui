import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, classifyTestRun, isTransient } from '../failure-classifier.js'

describe('classifyFailure', () => {
  it('classifies TS type errors correctly', () => {
    const result = classifyFailure("src/foo.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.")
    assert.equal(result.class, 'type_error')
    assert.ok(result.confidence >= 0.9)
  })

  it('classifies assertion failures', () => {
    const result = classifyFailure('AssertionError: expected true but got false')
    assert.equal(result.class, 'assertion')
    assert.ok(result.confidence >= 0.7)
  })

  it('classifies module resolution errors', () => {
    const result = classifyFailure("Cannot find module '../utils/helper' or its corresponding type declarations.")
    assert.equal(result.class, 'module_resolution')
    assert.ok(result.confidence >= 0.9)
  })

  it('classifies missing dependency errors', () => {
    const result = classifyFailure('sh: vitest: command not found')
    assert.equal(result.class, 'missing_dep')
    assert.ok(result.confidence >= 0.8)
  })

  it('classifies timeout errors', () => {
    const result = classifyFailure('Error: test timed out after 5000ms')
    assert.equal(result.class, 'timeout')
    assert.ok(result.confidence >= 0.8)
  })

  it('classifies snapshot errors', () => {
    const result = classifyFailure('Snapshot mismatch: expected 42 lines but received 38 lines (diff)')
    assert.equal(result.class, 'snapshot')
    assert.ok(result.confidence >= 0.85)
  })

  it('classifies environment errors', () => {
    const result = classifyFailure('Error: API key environment variable is not set')
    assert.equal(result.class, 'env_missing')
    assert.ok(result.confidence >= 0.8)
  })

  it('falls back to unknown for unclassified errors', () => {
    const result = classifyFailure('something weird happened')
    assert.equal(result.class, 'unknown')
    assert.ok(result.confidence <= 0.5)
  })

  // === permission_denied ===
  it('classifies EACCES permission errors', () => {
    const result = classifyFailure("EACCES: permission denied, open '/etc/shadow'")
    assert.equal(result.class, 'permission_denied')
    assert.equal(result.retryable, false)
  })

  it('classifies Permission denied string', () => {
    const result = classifyFailure('Error: Permission denied')
    assert.equal(result.class, 'permission_denied')
  })

  it('classifies Operation not permitted', () => {
    const result = classifyFailure('EPERM: operation not permitted')
    assert.equal(result.class, 'permission_denied')
  })

  // === context_window_exceeded ===
  it('classifies context length exceeded', () => {
    const result = classifyFailure("This model's maximum context length is 200000 tokens")
    assert.equal(result.class, 'context_window_exceeded')
    assert.equal(result.retryable, false)
  })

  it('classifies token limit errors', () => {
    const result = classifyFailure('Maximum context length exceeded')
    assert.equal(result.class, 'context_window_exceeded')
  })

  it('classifies too many tokens', () => {
    const result = classifyFailure('Too many tokens in input')
    assert.equal(result.class, 'context_window_exceeded')
  })

  // === api_error ===
  it('classifies 429 rate limit', () => {
    const result = classifyFailure('429 Too Many Requests')
    assert.equal(result.class, 'api_error')
    assert.equal(result.retryable, true)
  })

  it('classifies 500 server error', () => {
    const result = classifyFailure('500 Internal Server Error')
    assert.equal(result.class, 'api_error')
  })

  it('classifies 502 bad gateway', () => {
    const result = classifyFailure('502 Bad Gateway')
    assert.equal(result.class, 'api_error')
  })

  it('classifies rate limit text', () => {
    const result = classifyFailure('Error: rate limit exceeded')
    assert.equal(result.class, 'api_error')
  })

  // === syntax_error ===
  it('classifies SyntaxError', () => {
    const result = classifyFailure('SyntaxError: Unexpected token')
    assert.equal(result.class, 'syntax_error')
    assert.equal(result.retryable, false)
  })

  it('classifies ParseError', () => {
    const result = classifyFailure('ParseError: Unexpected end of input')
    assert.equal(result.class, 'syntax_error')
  })

  it('classifies compilation error', () => {
    const result = classifyFailure('compilation error in module foo')
    assert.equal(result.class, 'syntax_error')
  })

  it('classifies reference error (is not defined)', () => {
    const result = classifyFailure('ReferenceError: myVar is not defined')
    assert.equal(result.class, 'syntax_error')
  })

  // === format_error ===
  it('classifies JSON parse errors', () => {
    const result = classifyFailure('JSON.parse: unexpected character at line 1 column 5')
    assert.equal(result.class, 'format_error')
    assert.equal(result.retryable, true)
  })

  it('classifies malformed output', () => {
    const result = classifyFailure('Error: malformed response from API')
    assert.equal(result.class, 'format_error')
  })

  it('classifies unterminated string in JSON', () => {
    const result = classifyFailure('Unterminated string in JSON at position 42')
    assert.equal(result.class, 'format_error')
  })
})

describe('classifyTestRun', () => {
  it('parses multiple node:test failures', () => {
    const output = `
ok 1 - setup
not ok 2 - should add numbers
  AssertionError: expected 3 to equal 4
    at TestContext.<anonymous> (src/math.test.ts:5:10)
not ok 3 - should handle timeout
  Error: timed out after 1000ms
    at TestContext.<anonymous> (src/math.test.ts:12:8)
`
    const results = classifyTestRun(output)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.class, 'assertion')
    assert.equal(results[1]!.class, 'timeout')
  })

  it('parses vitest FAIL sections', () => {
    const output = `
FAIL  src/utils/format.test.ts > should format dates
  AssertionError: expected "2024-01-01" to equal "01/01/2024"
  at Context.<anonymous> (src/utils/format.test.ts:15:5)
FAIL  src/utils/math.test.ts > should divide
  error TS2322: Type 'string' is not assignable to type 'number'
`
    const results = classifyTestRun(output)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.class, 'assertion')
    assert.equal(results[1]!.class, 'type_error')
  })
})

describe('isTransient', () => {
  it('returns true for timeout class', () => {
    assert.equal(isTransient('timeout'), true)
  })

  it('returns true for flaky class', () => {
    assert.equal(isTransient('flaky'), true)
  })

  it('returns false for type_error', () => {
    assert.equal(isTransient('type_error'), false)
  })

  it('returns false for assertion', () => {
    assert.equal(isTransient('assertion'), false)
  })

  it('classifies ECONNRESET as transient from raw error text', () => {
    assert.equal(isTransient(classifyFailure('Error: ECONNRESET connection reset').class), true)
  })

  it('marks TypeScript failures as not retryable', () => {
    const result = classifyFailure('error TS2305: Module has no exported member')
    assert.equal(result.class, 'type_error')
    assert.equal(result.retryable, false)
    assert.match(result.suggestion, /fix/i)
  })

  it('marks timeout failures as retryable', () => {
    const result = classifyFailure('Command timed out after 120000ms')
    assert.equal(result.class, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('marks flaky failures as retryable', () => {
    const result = classifyFailure('intermittent flaky test failure')
    assert.equal(result.class, 'flaky')
    assert.equal(result.retryable, true)
  })
})
