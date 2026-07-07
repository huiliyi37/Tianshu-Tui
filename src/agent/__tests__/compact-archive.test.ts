import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializeMessagesForArchive,
  buildArchiveCatalog,
  buildRecallRefBlock,
} from '../compact-archive.js'
import { buildRecallMarker, parseRecallMarker, isCompactHistoryId, COMPACT_HISTORY_TOOL } from '../../compact/recall-marker.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('compact-archive serialization', () => {
  it('renders a fixed divider header per message', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'doing it' },
    ]
    const { rawContent } = serializeMessagesForArchive(messages)
    assert.match(rawContent, /^--- turn:0 role:user ---\nfirst request\n--- turn:0 role:assistant ---\ndoing it$/)
  })

  it('increments turn on each user message after the first', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ]
    const { turnRanges } = serializeMessagesForArchive(messages)
    assert.deepEqual(turnRanges.map(t => t.turn), [0, 1])
  })

  it('cuts sections per message with accurate line ranges', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'one line' },
      { role: 'assistant', content: 'line A\nline B' },
    ]
    const { rawContent, sections } = serializeMessagesForArchive(messages)
    const lines = rawContent.split('\n')

    // Section 0: header + 1 body line = lines 1-2
    assert.equal(sections[0]!.lineStart, 1)
    assert.equal(sections[0]!.lineEnd, 2)
    // Section 1: header + 2 body lines = lines 3-5
    assert.equal(sections[1]!.lineStart, 3)
    assert.equal(sections[1]!.lineEnd, 5)

    // Line ranges must address the real content.
    assert.equal(lines[sections[0]!.lineStart - 1], '--- turn:0 role:user ---')
    assert.equal(lines[sections[1]!.lineStart - 1], '--- turn:0 role:assistant ---')
    assert.equal(lines[4], 'line B')
  })

  it('serializes assistant tool_calls and reasoning verbatim', () => {
    const messages: OaiMessage[] = [
      {
        role: 'assistant',
        content: 'calling',
        reasoning_content: 'I should grep',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"foo"}' } }],
      },
    ]
    const { rawContent } = serializeMessagesForArchive(messages)
    assert.match(rawContent, /\[reasoning\]\nI should grep/)
    assert.match(rawContent, /\[tool_call grep\] \{"pattern":"foo"\}/)
  })

  it('collapses a recalled compact-history block back to a pointer (recall-eviction)', () => {
    const marker = buildRecallMarker('compact-history:abc12345', 'L1-L20')
    const messages: OaiMessage[] = [
      { role: 'tool', tool_call_id: 't1', content: `${marker}\n--- turn:0 role:user ---\nold verbatim content that should not be re-archived` },
    ]
    const { rawContent } = serializeMessagesForArchive(messages)
    assert.match(rawContent, /\[recalled → compact-history:abc12345 L1-L20 \(see original artifact\)\]/)
    assert.doesNotMatch(rawContent, /old verbatim content/)
  })

  it('keeps a normal tool result verbatim', () => {
    const messages: OaiMessage[] = [
      { role: 'tool', tool_call_id: 't1', content: 'normal result body' },
    ]
    const { rawContent } = serializeMessagesForArchive(messages)
    assert.match(rawContent, /normal result body/)
  })
})

describe('compact-archive catalog + ref block', () => {
  it('builds a turn→line catalog', () => {
    const catalog = buildArchiveCatalog(
      [{ turn: 0, lineStart: 1, lineEnd: 40 }, { turn: 1, lineStart: 41, lineEnd: 120 }],
      'compact-history:abc',
    )
    assert.match(catalog, /artifact:compact-history:abc/)
    assert.match(catalog, /- turn 0: L1-L40/)
    assert.match(catalog, /- turn 1: L41-L120/)
  })

  it('caps the catalog and notes overflow', () => {
    const ranges = Array.from({ length: 60 }, (_, i) => ({ turn: i, lineStart: i * 10 + 1, lineEnd: i * 10 + 10 }))
    const catalog = buildArchiveCatalog(ranges, 'compact-history:x')
    assert.match(catalog, /\+20 more turns/)
  })

  it('ref block embeds the artifact id and recall instruction', () => {
    const block = buildRecallRefBlock('compact-history:zzz', 12, 'CATALOG')
    assert.match(block, /已归档 12 条更早消息 → artifact:compact-history:zzz/)
    assert.match(block, /read_section\(artifactId="compact-history:zzz"/)
    assert.match(block, /CATALOG/)
  })
})

describe('recall-marker', () => {
  it('round-trips marker build/parse', () => {
    const marker = buildRecallMarker('compact-history:deadbeef', 'L10-L99')
    const parsed = parseRecallMarker(marker)
    assert.deepEqual(parsed, { artifactId: 'compact-history:deadbeef', section: 'L10-L99' })
  })

  it('parses a marker even with trailing content', () => {
    const parsed = parseRecallMarker(`${buildRecallMarker('compact-history:a1', 'c0-c500')}\nbody`)
    assert.deepEqual(parsed, { artifactId: 'compact-history:a1', section: 'c0-c500' })
  })

  it('returns null for non-recall content', () => {
    assert.equal(parseRecallMarker('just a normal tool result'), null)
  })

  it('identifies compact-history ids', () => {
    assert.equal(isCompactHistoryId(`${COMPACT_HISTORY_TOOL}:abc`), true)
    assert.equal(isCompactHistoryId('read_file:abc'), false)
  })
})
