import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { Tool } from '../../tools/types.js'

class HotAgent implements ManagedAgent {
  external: Tool[] = []
  updateCalls = 0
  run(_p: string, _c: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  registerExternalTools(tools: Tool[]): void {
    this.external.push(...tools)
    this.updateCalls++
  }
}

test('injectMcpTools hot-registers into live agents and skips archived', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-inject-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    const agents: HotAgent[] = []
    const manager = new RuntimeSessionManager({
      createAgent: () => {
        const a = new HotAgent()
        agents.push(a)
        return a
      },
      defaultCwd: home,
    })
    const live = manager.createSession({ cwd: home })
    const archived = manager.createSession({ cwd: home })
    // Force-ensure agents exist (createSession alone may not call createAgent).
    assert.equal(manager.run(live.id, 'hi'), true)
    assert.equal(manager.run(archived.id, 'hi'), true)
    // Wait for async ensureAgent path
    await new Promise((r) => setTimeout(r, 30))

    manager.archiveSession(archived.id)

    const tool: Tool = {
      definition: {
        name: 'mcp__echo__t',
        description: 't',
        input_schema: { type: 'object', properties: {} },
      },
      execute: async () => ({ content: 'ok', isError: false }),
      requiresApproval: () => false,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
    }
    manager.injectMcpTools([tool])

    const liveAgent = agents[0]!
    const archivedAgent = agents[1]!
    assert.equal(liveAgent.external.length, 1)
    assert.equal(liveAgent.external[0]!.definition.name, 'mcp__echo__t')
    assert.equal(archivedAgent.external.length, 0, 'archived sessions must not receive tools')
  } finally {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
