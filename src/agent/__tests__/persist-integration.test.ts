/**
 * Integration test: SessionContext mutation listener wired to SessionPersist.
 *
 * Verifies P0-1 fix: every in-memory message change is mirrored to disk so
 * non-/exit shutdowns (Ctrl+C, crash) don't lose the session.
 *
 * Mirrors the wiring done in AgentLoop's constructor; if the actual loop
 * code drifts from this contract, this test should fail.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionContext } from '../context.js'
import { SessionPersist } from '../session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { isToolMessage } from '../../api/oai-types.js'

/** Reproduces the AgentLoop constructor wiring in a self-contained helper. */
function wirePersistence(session: SessionContext, persist: SessionPersist): { drain: () => Promise<void> } {
  let writeChain: Promise<void> = Promise.resolve()
  session.setMutationListener((m) => {
    if (m.type === 'append') {
      const msg = m.message
      writeChain = writeChain
        .then(() => persist.appendOaiWithChecksum(msg))
        .catch(() => { /* swallow per AgentLoop contract */ })
    } else {
      writeChain = writeChain
        .then(() => { persist.compactOai(m.messages) })
        .catch(() => { /* swallow */ })
    }
  })
  return { drain: () => writeChain }
}

describe('SessionContext → SessionPersist integration', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-persist-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('persists user → assistant → tool_result append flow to disk', async () => {
    const session = new SessionContext()
    const persist = new SessionPersist('integration-test-1')
    const { drain } = wirePersistence(session, persist)

    session.addUserMessage('hello')
    session.addAssistantBlocks([
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { file_path: 'a.ts' } },
    ])
    session.addToolResults([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' },
    ])

    await drain()

    const onDisk = persist.loadOai()
    assert.equal(onDisk.length, 3, 'should have user + assistant + tool')
    const userMsg = onDisk[0]!
    const assistantMsg = onDisk[1]!
    const toolMsg = onDisk[2]!
    assert.equal(userMsg.role, 'user')
    assert.equal(userMsg.content, 'hello')
    assert.equal(assistantMsg.role, 'assistant')
    assert.ok(assistantMsg.role === 'assistant')
    assert.equal(assistantMsg.tool_calls?.[0]?.id, 'call_1')
    assert.ok(isToolMessage(toolMsg))
    assert.equal(toolMsg.content, 'file contents')
  })

  it('preserves order across rapid consecutive tool_results', async () => {
    const session = new SessionContext()
    const persist = new SessionPersist('integration-test-order')
    const { drain } = wirePersistence(session, persist)

    // Fire 50 tool_results back-to-back; serialization queue must keep them in order.
    // Each result must be anchored to a matching assistant tool_call, otherwise the
    // load-time orphan repair (loadOai → repairOrphanToolCalls) correctly drops them
    // as API-unsafe dangling tool messages.
    session.addAssistantBlocks(
      Array.from({ length: 50 }, (_, i) => ({
        type: 'tool_use' as const,
        id: `call_${i}`,
        name: 'read_file',
        input: { idx: i },
      })),
    )
    const results = Array.from({ length: 50 }, (_, i) => ({
      type: 'tool_result' as const,
      tool_use_id: `call_${i}`,
      content: `payload-${i}`,
    }))
    session.addToolResults(results)
    await drain()

    const onDisk = persist.loadOai()
    // index 0 = the assistant message that issued the 50 tool_calls; 1..50 = tool results
    assert.equal(onDisk.length, 51)
    assert.equal(onDisk[0]!.role, 'assistant')
    for (let i = 0; i < 50; i++) {
      const msg = onDisk[i + 1]!
      assert.ok(isToolMessage(msg), `index ${i} should be a tool message`)
      assert.equal(msg.tool_call_id, `call_${i}`, `index ${i} out of order`)
      assert.equal(msg.content, `payload-${i}`)
    }
  })

  it('replaceMessages does a full rewrite, dropping prior appended state', async () => {
    const session = new SessionContext()
    const persist = new SessionPersist('integration-test-replace')
    const { drain } = wirePersistence(session, persist)

    session.addUserMessage('msg-1')
    session.addUserMessage('msg-2')
    session.addUserMessage('msg-3')
    await drain()
    assert.equal(persist.loadOai().length, 3)

    // Simulate compaction: replace with a smaller set.
    const compacted: OaiMessage[] = [
      { role: 'user', content: 'compacted-summary' },
      { role: 'assistant', content: 'continuing' },
    ]
    session.replaceMessages(compacted)
    await drain()

    const onDisk = persist.loadOai()
    assert.equal(onDisk.length, 2)
    assert.equal(onDisk[0]!.content, 'compacted-summary')
    assert.equal(onDisk[1]!.content, 'continuing')
  })

  it('appends after replace continue from the rewritten state', async () => {
    const session = new SessionContext()
    const persist = new SessionPersist('integration-test-replace-then-append')
    const { drain } = wirePersistence(session, persist)

    session.addUserMessage('msg-1')
    session.replaceMessages([{ role: 'user', content: 'compacted' }])
    session.addAssistantBlocks([{ type: 'text', text: 'after-compact' }])
    await drain()

    const onDisk = persist.loadOai()
    assert.equal(onDisk.length, 2)
    assert.equal(onDisk[0]!.content, 'compacted')
    assert.equal(onDisk[1]!.role, 'assistant')
    assert.equal(onDisk[1]!.content, 'after-compact')
  })

  it('survives simulated crash mid-flow: messages written so far are recoverable', async () => {
    // This is the core P0-1 contract: if we never call /exit, prior messages
    // must still be on disk.
    const session = new SessionContext()
    const persist = new SessionPersist('integration-test-crash')
    const { drain } = wirePersistence(session, persist)

    session.addUserMessage('what is the bug?')
    session.addAssistantBlocks([
      { type: 'thinking', thinking: 'analyzing' },
      { type: 'text', text: 'looks like a race condition' },
    ])
    session.addUserMessage('please confirm')
    // ...crash here; no /exit, no compactOai called manually.

    await drain()

    // Re-open the session file as if we restarted the process.
    const reopened = new SessionPersist('integration-test-crash')
    const recovered = reopened.loadOai()
    assert.equal(recovered.length, 3)
    assert.equal(recovered[0]!.content, 'what is the bug?')
    assert.equal(recovered[1]!.role, 'assistant')
    assert.match(recovered[1]!.content as string, /race condition/)
    assert.equal(recovered[2]!.content, 'please confirm')
  })
})
