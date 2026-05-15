import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SSEParser } from '../sse.js'

describe('SSEParser — basic parsing', () => {
  it('parses a single data event', () => {
    const parser = new SSEParser()
    const events = parser.feed('data: hello\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.event, 'message')
    assert.equal(events[0]!.data, 'hello')
  })

  it('handles data: without space after colon', () => {
    const parser = new SSEParser()
    const events = parser.feed('data:value\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.data, 'value')
  })

  it('handles data: with space after colon', () => {
    const parser = new SSEParser()
    const events = parser.feed('data: value\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.data, 'value')
  })

  it('parses custom event type', () => {
    const parser = new SSEParser()
    const events = parser.feed('event: content_block_start\ndata: {"type":"text"}\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.event, 'content_block_start')
    assert.equal(events[0]!.data, '{"type":"text"}')
  })

  it('ignores empty data lines', () => {
    const parser = new SSEParser()
    const events = parser.feed('data:\n\n')
    assert.equal(events.length, 0)
  })

  it('handles multi-line data with multiple data: fields', () => {
    const parser = new SSEParser()
    const events = parser.feed('data: line1\ndata: line2\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.data, 'line1\nline2')
  })

  it('buffers incomplete events across chunks', () => {
    const parser = new SSEParser()
    const e1 = parser.feed('data: hel')
    assert.equal(e1.length, 0)
    const e2 = parser.feed('lo\n\n')
    assert.equal(e2.length, 1)
    assert.equal(e2[0]!.data, 'hello')
  })

  it('parses multiple events from a single chunk', () => {
    const parser = new SSEParser()
    const events = parser.feed('data: first\n\ndata: second\n\n')
    assert.equal(events.length, 2)
    assert.equal(events[0]!.data, 'first')
    assert.equal(events[1]!.data, 'second')
  })

  it('handles CRLF line endings', () => {
    const parser = new SSEParser()
    const events = parser.feed('data: hello\r\n\r\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.data, 'hello')
  })
})

describe('SSEParser — id field', () => {
  it('parses id: field and attaches to event', () => {
    const parser = new SSEParser()
    const events = parser.feed('id: 42\ndata: hello\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.id, '42')
  })

  it('id persists across subsequent events (per SSE spec)', () => {
    const parser = new SSEParser()
    parser.feed('id: 1\ndata: first\n\n')
    const events = parser.feed('data: second\n\n')
    assert.equal(events[0]!.id, '1')
  })

  it('id updates when a new id: field is received', () => {
    const parser = new SSEParser()
    parser.feed('id: 1\ndata: first\n\n')
    const events = parser.feed('id: 2\ndata: second\n\n')
    assert.equal(events[0]!.id, '2')
  })

  it('rejects id containing null bytes', () => {
    const parser = new SSEParser()
    const events = parser.feed('id: abc\0def\ndata: hello\n\n')
    assert.equal(events[0]!.id, undefined)
  })

  it('getLastEventId returns the last seen id', () => {
    const parser = new SSEParser()
    parser.feed('id: 99\ndata: hello\n\n')
    assert.equal(parser.getLastEventId(), '99')
  })
})

describe('SSEParser — retry field', () => {
  it('parses retry: and updates retryMs', () => {
    const parser = new SSEParser()
    parser.feed('retry: 5000\n\n')
    assert.equal(parser.getRetryMs(), 5000)
  })

  it('ignores invalid retry values', () => {
    const parser = new SSEParser()
    assert.equal(parser.getRetryMs(), 3000)
    parser.feed('retry: abc\n\n')
    assert.equal(parser.getRetryMs(), 3000)
  })

  it('ignores zero and negative retry values', () => {
    const parser = new SSEParser()
    parser.feed('retry: 0\n\n')
    assert.equal(parser.getRetryMs(), 3000)
    parser.feed('retry: -100\n\n')
    assert.equal(parser.getRetryMs(), 3000)
  })

  it('retryMs persists across reset()', () => {
    const parser = new SSEParser()
    parser.feed('retry: 7000\n\n')
    parser.reset()
    assert.equal(parser.getRetryMs(), 7000)
  })
})

describe('SSEParser — comments and reset', () => {
  it('silently ignores comment lines starting with :', () => {
    const parser = new SSEParser()
    const events = parser.feed(': this is a comment\ndata: hello\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.data, 'hello')
  })

  it('reset clears buffer and id but preserves retryMs', () => {
    const parser = new SSEParser()
    parser.feed('id: 42\nretry: 5000\ndata: hello\n\n')
    parser.reset()
    assert.equal(parser.getLastEventId(), undefined)
    assert.equal(parser.getRetryMs(), 5000)
  })
})
