import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { HookResult } from '../../hooks/user-hooks-runner.js'

class FakeAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks) { return Promise.resolve() }
  abort() {}
  listArtifacts() { return [] as Artifact[] }
  readArtifact(_id: string) { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]) {}
  rewindToMessages(_msgs: OaiMessage[]) {}
}

function setup() {
  return new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: '/tmp/work',
  })
}

test('emitHookResult appends a hook_result event', () => {
  const manager = setup()
  const s = manager.createSession({})
  const results: HookResult[] = [{ script: './x.sh', ok: true, output: 'done' }]
  manager.emitHookResult(s.id, results, { event: 'postTool', turn: 3, toolName: 'write_file' })

  const tail = manager.getEvents(s.id, 0)!
  const ev = tail.events.find((e) => e.type === 'hook_result')
  assert.ok(ev)
  assert.equal(ev!.data.event, 'postTool')
  assert.equal(ev!.data.turn, 3)
  assert.equal(ev!.data.toolName, 'write_file')
  assert.deepEqual(ev!.data.results, results)
})

test('emitHookResult retains only the latest 50 hook_result events', () => {
  const manager = setup()
  const s = manager.createSession({})
  for (let i = 1; i <= 55; i++) {
    manager.emitHookResult(s.id, [{ script: `./${i}.sh`, ok: true, output: '' }], { event: 'preTurn' })
  }
  const all = manager.getEvents(s.id, 0)!.events
  const hookEvents = all.filter((e) => e.type === 'hook_result')
  assert.equal(hookEvents.length, 50)
  assert.equal((hookEvents[0]!.data.results as HookResult[])[0]!.script, './6.sh')
  assert.equal((hookEvents.at(-1)!.data.results as HookResult[])[0]!.script, './55.sh')
})

test('emitHookResult ignores unknown session ids', () => {
  const manager = setup()
  assert.doesNotThrow(() => {
    manager.emitHookResult('nope', [], { event: 'preTurn' })
  })
})
