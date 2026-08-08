import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ActiveStarDomain } from '../../agent/star-domain.js'

class DomainAgent implements ManagedAgent {
  domain: ActiveStarDomain | null | undefined
  private resolveRun?: () => void

  run(_prompt: string, _callbacks: AgentCallbacks): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve
    })
  }

  abort(): void {
    this.resolveRun?.()
  }

  listArtifacts(): Artifact[] {
    return []
  }

  readArtifact(): Promise<string | null> {
    return Promise.resolve(null)
  }

  getMessages(): OaiMessage[] {
    return []
  }

  replaceMessages(_messages: OaiMessage[]): void {}
  rewindToMessages(_messages: OaiMessage[]): void {}
  setSessionDomain(domain: ActiveStarDomain | null): void {
    this.domain = domain
  }
  resetSessionDomain(): void {
    this.domain = undefined
  }
}

function setup() {
  const agents: DomainAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = new DomainAgent()
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
  })
  return { manager, agents }
}

test('setDomain 拒绝运行态会话且不修改 record、agent 或事件', () => {
  const { manager, agents } = setup()
  const session = manager.createSession({ domain: 'tianshu' })
  assert.equal(manager.run(session.id, 'keep running'), true)
  const beforeEvents = manager.getEvents(session.id, 0)!.events
  const beforeDomainEvents = beforeEvents.filter((event) => event.type === 'domain_changed').length

  assert.equal(manager.setDomain(session.id, 'yaoguang'), false)
  assert.equal(manager.getSession(session.id)!.domain, 'tianshu')
  assert.equal(agents[0]!.domain?.id, 'tianshu')
  const afterEvents = manager.getEvents(session.id, 0)!.events
  assert.equal(
    afterEvents.filter((event) => event.type === 'domain_changed').length,
    beforeDomainEvents,
  )
})

test('POST /domain 对已有运行态会话返回明确 409', async () => {
  const { manager } = setup()
  const session = manager.createSession({ domain: 'tianshu' })
  assert.equal(manager.run(session.id, 'keep running'), true)
  const token = 'domain-running-token'
  const router = createRouter(buildSessionRoutes(manager, token))

  const response = await router(
    'POST',
    `/sessions/${session.id}/domain`,
    { key: 'yaoguang' },
    { authorization: `Bearer ${token}` },
  )

  assert.equal(response.status, 409)
  assert.match(String((response.body as { error?: unknown }).error), /running/i)
  assert.equal(manager.getSession(session.id)!.domain, 'tianshu')
})
