import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMailbox, createWorkerMailboxSender } from '../worker-mailbox.js'

describe('InMemoryMailbox', () => {
  let mailbox: InMemoryMailbox

  beforeEach(() => {
    mailbox = new InMemoryMailbox()
  })

  describe('send/receive', () => {
    it('sends and receives targeted messages', () => {
      mailbox.send({
        from: 'worker-1',
        to: 'coordinator',
        type: 'finding',
        payload: { summary: 'Found issue in foo.ts', files: ['foo.ts'], severity: 'warning' },
      })

      const msgs = mailbox.receive('coordinator')
      assert.equal(msgs.length, 1)
      assert.equal(msgs[0]!.from, 'worker-1')
      assert.equal(msgs[0]!.type, 'finding')
      assert.equal(msgs[0]!.payload.summary, 'Found issue in foo.ts')
    })

    it('does not deliver to wrong recipient', () => {
      mailbox.send({
        from: 'worker-1',
        to: 'coordinator',
        type: 'finding',
        payload: { summary: 'test' },
      })

      const msgs = mailbox.receive('worker-2')
      assert.equal(msgs.length, 0)
    })
  })

  describe('broadcast', () => {
    it('delivers broadcast to all recipients', () => {
      mailbox.broadcast({
        from: 'worker-1',
        type: 'progress',
        payload: { summary: '50% done', progress: 50 },
      })

      const forCoord = mailbox.receive('coordinator')
      const forMain = mailbox.receive('main')
      assert.equal(forCoord.length, 1)
      assert.equal(forMain.length, 1)
      assert.equal(forCoord[0]!.to, '*')
    })
  })

  describe('byType', () => {
    it('filters messages by type', () => {
      mailbox.send({ from: 'w1', to: 'coordinator', type: 'finding', payload: { summary: 'a' } })
      mailbox.send({ from: 'w2', to: 'coordinator', type: 'escalation', payload: { summary: 'b', severity: 'blocking' } })
      mailbox.send({ from: 'w3', to: 'coordinator', type: 'finding', payload: { summary: 'c' } })

      const findings = mailbox.byType('finding')
      assert.equal(findings.length, 2)
      const escalations = mailbox.byType('escalation')
      assert.equal(escalations.length, 1)
      assert.equal(escalations[0]!.payload.severity, 'blocking')
    })
  })

  describe('all/size/clear', () => {
    it('reports size correctly', () => {
      assert.equal(mailbox.size(), 0)
      mailbox.send({ from: 'w1', to: 'coordinator', type: 'progress', payload: { summary: 'x' } })
      assert.equal(mailbox.size(), 1)
    })

    it('all returns copy of all messages', () => {
      mailbox.send({ from: 'w1', to: 'coordinator', type: 'finding', payload: { summary: 'a' } })
      mailbox.send({ from: 'w2', to: 'main', type: 'escalation', payload: { summary: 'b' } })
      assert.equal(mailbox.all().length, 2)
    })

    it('clear removes all messages', () => {
      mailbox.send({ from: 'w1', to: 'coordinator', type: 'finding', payload: { summary: 'a' } })
      mailbox.clear()
      assert.equal(mailbox.size(), 0)
      assert.equal(mailbox.all().length, 0)
    })
  })
})

describe('createWorkerMailboxSender', () => {
  let mailbox: InMemoryMailbox

  beforeEach(() => {
    mailbox = new InMemoryMailbox()
  })

  it('send targets a specific recipient', () => {
    const sender = createWorkerMailboxSender(mailbox, 'worker-42')
    sender.send('coordinator', 'finding', { summary: 'test' })

    const msgs = mailbox.receive('coordinator')
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0]!.from, 'worker-42')
  })

  it('progress sends to coordinator with percentage', () => {
    const sender = createWorkerMailboxSender(mailbox, 'worker-42')
    sender.progress(3, 4, '3/4 files')

    const msgs = mailbox.receive('coordinator')
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0]!.type, 'progress')
    assert.equal(msgs[0]!.payload.progress, 75)
    assert.equal(msgs[0]!.payload.summary, '3/4 files')
  })

  it('escalate sends blocking message to main', () => {
    const sender = createWorkerMailboxSender(mailbox, 'worker-42')
    sender.escalate('Design-level issue found', ['complex.ts'])

    const msgs = mailbox.receive('main')
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0]!.type, 'escalation')
    assert.equal(msgs[0]!.payload.severity, 'blocking')
    assert.deepEqual(msgs[0]!.payload.files, ['complex.ts'])
  })

  it('reportFinding sends to coordinator', () => {
    const sender = createWorkerMailboxSender(mailbox, 'worker-42')
    sender.reportFinding('Unused import found', 'warning', ['utils.ts'])

    const findings = mailbox.byType('finding')
    assert.equal(findings.length, 1)
    assert.equal(findings[0]!.payload.severity, 'warning')
  })

  it('reportArtifact sends artifact path', () => {
    const sender = createWorkerMailboxSender(mailbox, 'worker-42')
    sender.reportArtifact('Generated test file', '/src/__tests__/foo.test.ts', ['foo.ts'])

    const artifacts = mailbox.byType('artifact')
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0]!.payload.artifact, '/src/__tests__/foo.test.ts')
  })

  it('broadcast reaches all recipients', () => {
    const sender = createWorkerMailboxSender(mailbox, 'worker-42')
    sender.broadcast('progress', { summary: 'done' })

    assert.equal(mailbox.receive('coordinator').length, 1)
    assert.equal(mailbox.receive('main').length, 1)
  })
})
