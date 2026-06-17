import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { ContentBlock } from '../../api/types.js'
import type { OaiAssistantMessage } from '../../api/oai-types.js'

function findAssistantWithTools(msgs: ReturnType<SessionContext['getMessages']>): OaiAssistantMessage {
  const found = msgs.find((m): m is OaiAssistantMessage => m.role === 'assistant' && !!(m.tool_calls?.length))
  assert.ok(found, 'assistant message with tool_calls should exist')
  return found!
}

describe('SessionContext + plan_submit arg processor integration', () => {
  it('plan_submit arguments are replaced with file pointer in oaiMessages', () => {
    const session = new SessionContext()
    const bigPlan = '# My Plan\n\n'.repeat(100) // ~1200 chars
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Submitting plan' },
      { type: 'tool_use', id: 'tc-plan-1', name: 'plan_submit', input: { title: 'Test Plan', plan: bigPlan } },
    ]

    session.addUserMessage('create a plan')
    session.addAssistantBlocks(blocks)

    const msgs = session.getMessages()
    const asst = findAssistantWithTools(msgs)
    const tc = asst.tool_calls![0]!
    assert.equal(tc.function.name, 'plan_submit')
    // Arguments should contain the file pointer, NOT the full plan
    assert.ok(tc.function.arguments.includes('[plan persisted to'), 'arguments should contain file pointer')
    assert.ok(tc.function.arguments.includes('.rivet/plans/test-plan.md'), 'should reference correct slug')
    // The full plan content should NOT be in arguments
    assert.ok(!tc.function.arguments.includes(bigPlan.slice(0, 50)), 'full plan content should be replaced')
  })

  it('plan_submit tool_call_id is preserved after processing', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-preserve-id', name: 'plan_submit', input: { title: 'ID Test', plan: '# x\n'.repeat(50) } },
    ]

    session.addUserMessage('test')
    session.addAssistantBlocks(blocks)

    const asst = findAssistantWithTools(session.getMessages())
    assert.equal(asst.tool_calls![0]!.id, 'tc-preserve-id', 'tool_call_id must not change')
  })

  it('non-plan_submit tools are not affected', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-read', name: 'read_file', input: { file_path: '/src/foo.ts' } },
    ]

    session.addUserMessage('read file')
    session.addAssistantBlocks(blocks)

    const asst = findAssistantWithTools(session.getMessages())
    const args = asst.tool_calls![0]!.function.arguments
    assert.ok(args.includes('/src/foo.ts'), 'read_file arguments should be unchanged')
  })

  it('block.input is not mutated — execute still gets original plan', () => {
    const session = new SessionContext()
    const bigPlan = '# Original Plan\n'.repeat(50)
    const block: ContentBlock & { type: 'tool_use' } = {
      type: 'tool_use',
      id: 'tc-mutation',
      name: 'plan_submit',
      input: { title: 'Mutation Test', plan: bigPlan },
    }

    session.addUserMessage('test')
    session.addAssistantBlocks([block])

    // block.input.plan should still be the original full plan
    const input = block.input as { title: string; plan: string }
    assert.equal(input.plan, bigPlan, 'block.input.plan must not be mutated')
    assert.equal(input.title, 'Mutation Test', 'block.input.title must not be mutated')
  })

  it('multiple tool calls in one message — only plan_submit is processed', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-a', name: 'read_file', input: { file_path: '/foo.ts' } },
      { type: 'tool_use', id: 'tc-b', name: 'plan_submit', input: { title: 'Multi', plan: '# plan\n'.repeat(50) } },
      { type: 'tool_use', id: 'tc-c', name: 'grep', input: { pattern: 'test' } },
    ]

    session.addUserMessage('multi')
    session.addAssistantBlocks(blocks)

    const asst = findAssistantWithTools(session.getMessages())
    const calls = asst.tool_calls!
    assert.equal(calls.length, 3)
    // read_file unchanged
    assert.ok(calls[0]!.function.arguments.includes('/foo.ts'))
    // plan_submit replaced
    assert.ok(calls[1]!.function.arguments.includes('[plan persisted to'))
    // grep unchanged
    assert.ok(calls[2]!.function.arguments.includes('test'))
    // all ids preserved
    assert.equal(calls[0]!.id, 'tc-a')
    assert.equal(calls[1]!.id, 'tc-b')
    assert.equal(calls[2]!.id, 'tc-c')
  })

  it('persisted message also has pointer (byte-identical guarantee)', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-persist', name: 'plan_submit', input: { title: 'Persist', plan: '# p\n'.repeat(50) } },
    ]

    session.addUserMessage('test')
    session.addAssistantBlocks(blocks)

    // Verify the stored message has the pointer, not the full plan
    const asst = findAssistantWithTools(session.getMessages())
    const args = JSON.parse(asst.tool_calls![0]!.function.arguments)
    assert.ok(args.plan.startsWith('[plan persisted to'), 'persisted args should have pointer')
  })
})

describe('SessionContext + write_file arg processor integration', () => {
  it('large write_file content is replaced with a file pointer in oaiMessages', () => {
    const session = new SessionContext()
    const bigContent = 'const x = 1\n'.repeat(2000) // ~24KB — the real cache-break shape
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-write-1', name: 'write_file', input: { file_path: '/abs/src/big.ts', content: bigContent } },
    ]

    session.addUserMessage('write a big file')
    session.addAssistantBlocks(blocks)

    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.equal(tc.function.name, 'write_file')
    assert.ok(tc.function.arguments.includes('[file written to'), 'should contain file pointer')
    assert.ok(tc.function.arguments.includes('/abs/src/big.ts'), 'should reference file_path')
    assert.ok(!tc.function.arguments.includes(bigContent.slice(0, 50)), 'full content should be gone')
  })

  it('small write_file content stays inline (below threshold)', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-write-small', name: 'write_file', input: { file_path: '/a.txt', content: 'hello world' } },
    ]
    session.addUserMessage('small write')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('hello world'), 'small content stays inline')
  })

  it('write_file block.input is not mutated — execute still gets full content', () => {
    const session = new SessionContext()
    const bigContent = 'data\n'.repeat(1000)
    const block: ContentBlock & { type: 'tool_use' } = {
      type: 'tool_use', id: 'tc-write-mut', name: 'write_file', input: { file_path: '/a.ts', content: bigContent },
    }
    session.addUserMessage('write')
    session.addAssistantBlocks([block])
    assert.equal((block.input as { content: string }).content, bigContent, 'block.input.content must not be mutated')
  })
})

describe('SessionContext + edit_file arg processor integration', () => {
  it('very large edit collapses old/new strings into pointers', () => {
    const session = new SessionContext()
    const bigOld = 'OLD LINE\n'.repeat(1000)
    const bigNew = 'NEW LINE\n'.repeat(1000)
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-edit-1', name: 'edit_file', input: { file_path: '/abs/foo.ts', old_string: bigOld, new_string: bigNew } },
    ]
    session.addUserMessage('big edit')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('[edit on'), 'should collapse to pointer')
    assert.ok(!tc.function.arguments.includes(bigOld.slice(0, 60)), 'old_string literal gone')
  })

  it('ordinary edit_file stays inline (below threshold)', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-edit-small', name: 'edit_file', input: { file_path: '/a.ts', old_string: 'foo()', new_string: 'bar()' } },
    ]
    session.addUserMessage('small edit')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('foo()'), 'small edit stays inline')
    assert.ok(tc.function.arguments.includes('bar()'))
  })

  it('edit_file block.input is not mutated — execute still gets real strings', () => {
    const session = new SessionContext()
    const bigOld = 'X'.repeat(5000)
    const bigNew = 'Y'.repeat(5000)
    const block: ContentBlock & { type: 'tool_use' } = {
      type: 'tool_use', id: 'tc-edit-mut', name: 'edit_file', input: { file_path: '/a.ts', old_string: bigOld, new_string: bigNew },
    }
    session.addUserMessage('edit')
    session.addAssistantBlocks([block])
    const input = block.input as { old_string: string; new_string: string }
    assert.equal(input.old_string, bigOld, 'block.input.old_string must not be mutated')
    assert.equal(input.new_string, bigNew, 'block.input.new_string must not be mutated')
  })
})

describe('SessionContext + hash_edit arg processor integration', () => {
  it('large hash_edit new_string is replaced with a file pointer, anchors kept', () => {
    const session = new SessionContext()
    const bigNew = 'const x = 1\n'.repeat(500)
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-hash-1', name: 'hash_edit', input: { file_path: '/abs/foo.ts', anchors: ['L5:a1b2c3d4'], new_string: bigNew } },
    ]
    session.addUserMessage('big hash edit')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('[hash_edit applied to'), 'should collapse to pointer')
    assert.ok(tc.function.arguments.includes('/abs/foo.ts'))
    assert.ok(tc.function.arguments.includes('L5:a1b2c3d4'), 'anchors preserved')
    assert.ok(!tc.function.arguments.includes(bigNew.slice(0, 50)), 'new_string literal gone')
  })

  it('small hash_edit stays inline', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-hash-small', name: 'hash_edit', input: { file_path: '/a.ts', anchors: ['L1'], new_string: 'tiny' } },
    ]
    session.addUserMessage('small hash edit')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('tiny'), 'small new_string stays inline')
  })

  it('hash_edit block.input is not mutated — execute still gets real new_string', () => {
    const session = new SessionContext()
    const bigNew = 'Z'.repeat(3000)
    const block: ContentBlock & { type: 'tool_use' } = {
      type: 'tool_use', id: 'tc-hash-mut', name: 'hash_edit', input: { file_path: '/a.ts', anchors: ['L1'], new_string: bigNew },
    }
    session.addUserMessage('hash edit')
    session.addAssistantBlocks([block])
    assert.equal((block.input as { new_string: string }).new_string, bigNew, 'block.input.new_string must not be mutated')
  })
})

describe('SessionContext + apply_patch arg processor integration', () => {
  function bigDiff(files: number): string {
    const body = 'context line\n'.repeat(400)
    let out = ''
    for (let i = 0; i < files; i++) {
      out += `--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1 +1 @@\n-a\n+b\n${body}`
    }
    return out
  }

  it('large applied patch collapses diff into a file-list pointer', () => {
    const session = new SessionContext()
    const diff = bigDiff(3)
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-patch-1', name: 'apply_patch', input: { diff } },
    ]
    session.addUserMessage('apply patch')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('[patch applied to'), 'should collapse to pointer')
    assert.ok(tc.function.arguments.includes('3 file(s)'))
    assert.ok(!tc.function.arguments.includes('context line\ncontext line'), 'diff body gone')
  })

  it('check_only patch stays inline', () => {
    const session = new SessionContext()
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'tc-patch-check', name: 'apply_patch', input: { diff: bigDiff(3), check_only: true } },
    ]
    session.addUserMessage('check patch')
    session.addAssistantBlocks(blocks)
    const tc = findAssistantWithTools(session.getMessages()).tool_calls![0]!
    assert.ok(tc.function.arguments.includes('context line'), 'check_only diff stays inline')
  })

  it('apply_patch block.input is not mutated — execute still gets real diff', () => {
    const session = new SessionContext()
    const diff = bigDiff(2)
    const block: ContentBlock & { type: 'tool_use' } = {
      type: 'tool_use', id: 'tc-patch-mut', name: 'apply_patch', input: { diff },
    }
    session.addUserMessage('patch')
    session.addAssistantBlocks([block])
    assert.equal((block.input as { diff: string }).diff, diff, 'block.input.diff must not be mutated')
  })
})
