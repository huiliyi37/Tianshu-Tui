import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuckDuckGoResults, decodeHtmlEntities } from '../web-search.js'

// Fixture: real markup captured from html.duckduckgo.com/html/?q=anthropic+claude
// (2026-06-07). Trimmed to two result blocks. Source of truth for the parser —
// if DDG changes its markup, refresh this fixture and the test will flag drift.
const DDG_FIXTURE = `
<div class="result results_links results_links_deep web-result">
<h2 class="result__title">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fclaude.com%2Fproduct%2Foverview&amp;rut=b63acd">The AI for Problem Solvers | Claude by Anthropic</a>
</h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fclaude.com%2Fproduct%2Foverview&amp;rut=b63acd"><b>Claude</b> is <b>Anthropic&#x27;s</b> AI, built for problem solvers.</a>
</div>
<div class="result results_links results_links_deep web-result">
<h2 class="result__title">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.anthropic.com%2F&amp;rut=aa11">Home &#92; Anthropic</a>
</h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.anthropic.com%2F&amp;rut=aa11">Claude Opus &amp; agentic tasks.</a>
</div>
`

describe('parseDuckDuckGoResults', () => {
  it('extracts title, real (un-wrapped) url, and snippet from live-shaped markup', () => {
    const r = parseDuckDuckGoResults(DDG_FIXTURE, 10)
    assert.equal(r.length, 2)
    assert.equal(r[0]!.title, 'The AI for Problem Solvers | Claude by Anthropic')
    // uddg redirect wrapper must be unwrapped to the real target
    assert.equal(r[0]!.url, 'https://claude.com/product/overview')
  })

  it('decodes HTML entities in title AND snippet (not just url)', () => {
    const r = parseDuckDuckGoResults(DDG_FIXTURE, 10)
    // &#x27; (hex) in snippet → apostrophe
    assert.equal(r[0]!.snippet, "Claude is Anthropic's AI, built for problem solvers.")
    // &#92; (decimal) in title → backslash — was NOT in the old hardcoded table
    assert.equal(r[1]!.title, 'Home \\ Anthropic')
    // &amp; in snippet → ampersand
    assert.equal(r[1]!.snippet, 'Claude Opus & agentic tasks.')
  })

  it('honors maxCount', () => {
    assert.equal(parseDuckDuckGoResults(DDG_FIXTURE, 1).length, 1)
  })

  it('returns empty array when markup has no result blocks (drift signal)', () => {
    assert.deepEqual(parseDuckDuckGoResults('<html><body>nothing</body></html>', 10), [])
  })
})

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    assert.equal(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"')
  })

  it('decodes numeric entities (decimal + hex)', () => {
    assert.equal(decodeHtmlEntities('&#92; &#x27; &#39;'), "\\ ' '")
  })

  it('does not double-decode (&amp;#x27; stays literal &#x27;)', () => {
    assert.equal(decodeHtmlEntities('&amp;#x27;'), '&#x27;')
  })

  it('leaves unknown / malformed entities untouched', () => {
    assert.equal(decodeHtmlEntities('100% &notreal; &#;'), '100% &notreal; &#;')
  })
})
