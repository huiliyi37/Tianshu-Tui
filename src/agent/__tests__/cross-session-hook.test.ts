import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createCrossSessionHook, formatEventsForAppendix, renderCrossSessionClaims } from '../hooks/cross-session-hook.js'
import type { EventRecord } from '../session-registry.js'

describe('cross-session-hook', () => {
  test('formatEventsForAppendix formats events correctly', () => {
    const events: EventRecord[] = [
      { id: 1, sessionId: 'abc', eventType: 'file_changed', filePath: 'src/foo.ts', detail: 'Modified by session abc12345', priority: 0, createdAt: '2026-05-21T10:00:00Z' },
      { id: 2, sessionId: 'def', eventType: 'type_error', filePath: 'src/bar.ts', detail: 'Expected 3 args, got 2', priority: 1, createdAt: '2026-05-21T10:01:00Z' },
    ]

    const result = formatEventsForAppendix(events)
    assert.ok(result.includes('<cross-session-events>'))
    assert.ok(result.includes('src/foo.ts'))
    assert.ok(result.includes('Expected 3 args'))
    assert.ok(result.includes('</cross-session-events>'))
    assert.ok(result.includes('[ALERT]'))
    assert.ok(result.includes('[info]'))
    // Priority sorting: ALERT (priority=1) should appear before info (priority=0)
    const alertIdx = result.indexOf('[ALERT]')
    const infoIdx = result.indexOf('[info]')
    assert.ok(alertIdx < infoIdx, 'High-priority events should be sorted first')
  })

  test('formatEventsForAppendix returns empty string for no events', () => {
    assert.equal(formatEventsForAppendix([]), '')
  })

  test('renderCrossSessionClaims surfaces grouped claims (B-line: signal was computed but discarded)', () => {
    const claims = [
      { sessionId: 'sessA', filePath: 'src/loop.ts', claimType: 'edit' },
      { sessionId: 'sessB', filePath: 'src/loop.ts', claimType: 'read' },
      { sessionId: 'sessC', filePath: 'src/engine.ts', claimType: 'edit' },
    ]
    const out = renderCrossSessionClaims(claims)
    assert.ok(out.includes('<cross-session-claims'))
    assert.ok(out.includes('</cross-session-claims>'))
    // Same file groups multiple holders onto one line.
    assert.match(out, /src\/loop\.ts — claimed by sessA\(edit\), sessB\(read\)/)
    assert.match(out, /src\/engine\.ts — claimed by sessC\(edit\)/)
  })

  test('renderCrossSessionClaims returns empty string for no claims', () => {
    assert.equal(renderCrossSessionClaims([]), '')
  })

  test('createCrossSessionHook reads events and updates state', () => {
    let lastSeenId = 0
    let appendixContent = ''
    const mockEvents: EventRecord[] = [
      { id: 5, sessionId: 'other', eventType: 'file_changed', filePath: 'src/x.ts', detail: 'test', priority: 0, createdAt: '2026-05-21T10:00:00Z' },
    ]

    const hook = createCrossSessionHook({
      consumeEvents: (_sessionId, afterId) => {
        assert.equal(afterId, 0)
        return mockEvents
      },
      sessionId: 'my-session',
      setCrossSessionAppendix: (content) => { appendixContent = content },
      getLastSeenEventId: () => lastSeenId,
      setLastSeenEventId: (id) => { lastSeenId = id },
    })

    hook.run()
    assert.equal(lastSeenId, 5)
    assert.ok(appendixContent.includes('src/x.ts'))
  })

  test('createCrossSessionHook does nothing when no new events', () => {
    let appendixContent = 'unchanged'

    const hook = createCrossSessionHook({
      consumeEvents: () => [],
      sessionId: 'my-session',
      setCrossSessionAppendix: (content) => { appendixContent = content },
      getLastSeenEventId: () => 10,
      setLastSeenEventId: () => {},
    })

    hook.run()
    assert.equal(appendixContent, 'unchanged')
  })
})
