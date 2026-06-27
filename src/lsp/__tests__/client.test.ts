import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTypeCheck } from '../client.js'

/**
 * Smoke test: verify require('typescript') loads and the compiler API pipeline
 * runs to completion in the current environment (tsx for tests, bundled dist
 * for production). If this fails (ranOk=false), the typecheck gate silently
 * becomes a no-op — every delivery gets a false GREEN.
 *
 * This is the ONLY test that exercises the real runTypeCheck path (all
 * typecheck-gate tests inject a mock runner). Without it, a require resolution
 * failure in the bundled dist would go undetected until production.
 */
test('runTypeCheck: require(typescript) loads and returns ranOk=true', async () => {
  const res = await runTypeCheck(process.cwd(), '*')
  assert.equal(res.ranOk, true, 'tsc must run to completion — if ranOk is false, require(typescript) failed to load')
  // A clean repo has 0 errors, but the key assertion is ranOk, not the count.
  assert.ok(Array.isArray(res.diagnostics), 'diagnostics must be an array')
})

test('runTypeCheck: diagnostics have valid structure when present', async () => {
  const res = await runTypeCheck(process.cwd(), '*')
  if (!res.ranOk) return // can't check structure if tsc didn't run
  for (const d of res.diagnostics) {
    assert.ok(typeof d.file === 'string', `diagnostic file must be string, got ${typeof d.file}`)
    assert.ok(typeof d.line === 'number', `diagnostic line must be number, got ${typeof d.line}`)
    assert.ok(typeof d.message === 'string', `diagnostic message must be string, got ${typeof d.message}`)
  }
})
