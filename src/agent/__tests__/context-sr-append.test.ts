import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'

describe('SessionContext.appendSystemReminder', () => {
  it('appends SR to last user message without adding new message entry', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')
    session.addAssistantBlocks([{ type: 'text', text: 'hi' }])
    session.addUserMessage('do task')

    const lenBefore = session.getMessages().length
    session.appendSystemReminder('convergence kick')
    const lenAfter = session.getMessages().length

    assert.equal(lenAfter, lenBefore, 'message array length must not change')

    const msgs = session.getMessages()
    const last = msgs[msgs.length - 1]!
    assert.equal(last.role, 'user')
    assert.ok(typeof last.content === 'string')
    assert.ok(last.content.includes('<system-reminder>'), 'must contain SR tag')
    assert.ok(last.content.includes('convergence kick'), 'must contain SR text')
    assert.ok(last.content.includes('do task'), 'must preserve original content')
  })

  it('appends multiple SRs to the same last user message', () => {
    const session = new SessionContext()
    session.addUserMessage('继续')

    session.appendSystemReminder('kick A')
    session.appendSystemReminder('kick B')

    const msgs = session.getMessages()
    assert.equal(msgs.length, 1, 'still only 1 message')
    const content = msgs[0]!.content as string
    assert.ok(content.includes('kick A'))
    assert.ok(content.includes('kick B'))
    assert.ok(content.includes('继续'))
  })

  it('falls back to addUserMessage when no user message exists', () => {
    const session = new SessionContext()
    session.appendSystemReminder('orphan SR')

    const msgs = session.getMessages()
    assert.equal(msgs.length, 1, 'fallback creates a new message')
    assert.equal(msgs[0]!.role, 'user')
    assert.ok((msgs[0]!.content as string).includes('<system-reminder>'))
  })

  it('triggers mutation listener with replace type', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')
    const mutations: Array<{ type: string; messages?: unknown }> = []
    session.setMutationListener(m => mutations.push(m))

    session.appendSystemReminder('nudge')

    assert.equal(mutations.length, 1)
    assert.equal(mutations[0]!.type, 'replace')
  })

  // Regression guard for 5fedd9b6: SR injection during a turn (tool/assistant
  // messages already follow the last user message) must NOT rewrite that
  // mid-array user message. DeepSeek's exact-prefix cache keys on the token
  // sequence, so rewriting any earlier message invalidates the prefix from that
  // point onward — collapsing every cached tool output after it. SR must be
  // append-only at the tail.
  it('does NOT rewrite a mid-array user message — appends SR as a new tail entry', () => {
    const session = new SessionContext()
    session.addUserMessage('task')
    session.addAssistantBlocks([{ type: 'text', text: 'doing' }])
    session.addToolResults([{ type: 'tool_result', tool_use_id: 'x', content: 'BIG TOOL OUTPUT'.repeat(100) }])
    session.addAssistantBlocks([{ type: 'text', text: 'done' }])

    const snapshot = session.getMessages().map(m => JSON.stringify(m))

    session.appendSystemReminder('gate hint')

    const after = session.getMessages()
    // Every pre-existing message must be byte-identical (prefix untouched).
    for (let i = 0; i < snapshot.length; i++) {
      assert.equal(JSON.stringify(after[i]), snapshot[i],
        `message at index ${i} must not be rewritten (prefix cache stability)`)
    }
    // SR lands as a NEW tail entry, not merged into the mid-array user message.
    assert.equal(after.length, snapshot.length + 1, 'SR appended as a new tail message')
    const last = after[after.length - 1]!
    assert.equal(last.role, 'user')
    assert.ok((last.content as string).includes('gate hint'), 'SR text in the new tail message')
    assert.ok((last.content as string).includes('<system-reminder>'), 'SR carries the marker')
  })

  it('does not rewrite a mid-array string user message when the tail is multimodal', () => {
    const session = new SessionContext()
    session.addUserMessage('text msg')
    // Simulate a multimodal user message (array content) as the tail.
    session.getMessages().push({ role: 'user', content: [{ type: 'text', text: 'image msg' }] })

    const before = session.getMessages().map(m => JSON.stringify(m))
    // Tail is non-string user → SR must be a new tail entry, leaving the
    // mid-array string user message untouched (prefix stability).
    session.appendSystemReminder('sr text')

    const msgs = session.getMessages()
    assert.equal(JSON.stringify(msgs[0]), before[0], 'mid-array string user must not be rewritten')
    assert.equal(JSON.stringify(msgs[1]), before[1], 'multimodal user must not be rewritten')
    assert.equal(msgs.length, 3, 'SR appended as a new tail entry')
    assert.ok((msgs[2]!.content as string).includes('sr text'), 'SR in the new tail message')
  })
})
