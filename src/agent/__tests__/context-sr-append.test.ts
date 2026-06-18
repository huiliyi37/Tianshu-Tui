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

  it('finds last user message even when tool/assistant messages follow', () => {
    const session = new SessionContext()
    session.addUserMessage('task')
    session.addAssistantBlocks([{ type: 'text', text: 'doing' }])
    session.addToolResults([{ type: 'tool_result', tool_use_id: 'x', content: 'result' }])
    session.addAssistantBlocks([{ type: 'text', text: 'done' }])

    const lenBefore = session.getMessages().length
    session.appendSystemReminder('gate hint')
    const lenAfter = session.getMessages().length

    assert.equal(lenAfter, lenBefore, 'no new message added')

    // SR should be appended to the user message, which is NOT the last message
    const msgs = session.getMessages()
    const userMsg = msgs.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('task'))!
    assert.ok((userMsg.content as string).includes('gate hint'), 'SR appended to the user message')
  })

  it('handles multimodal (non-string) user messages by skipping them', () => {
    const session = new SessionContext()
    session.addUserMessage('text msg')
    // Simulate a multimodal user message (array content)
    session.getMessages().push({ role: 'user', content: [{ type: 'text', text: 'image msg' }] })

    // Should skip the array-content message and append to the string one
    session.appendSystemReminder('sr text')

    const msgs = session.getMessages()
    assert.equal(msgs.length, 2, 'no new message')
    const first = msgs[0]!
    assert.ok((first.content as string).includes('sr text'), 'appended to the string user message')
  })
})
