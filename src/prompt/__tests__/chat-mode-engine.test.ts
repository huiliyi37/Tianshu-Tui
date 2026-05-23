import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'

function makeEngine(mode: 'chat' | 'task' = 'task') {
  const engine = new PromptEngine({
    model: 'test',
    maxTokens: 1024,
    staticCtx: { tools: [{ name: 'edit_file', description: 'Edit file', input_schema: { type: 'object', properties: {} } }] },
    volatileCtx: { cwd: '/repo' },
    habituationThreshold: 5,
  })
  engine.setMode(mode)
  return engine
}

describe('Chat Mode PromptEngine', () => {
  it('defaults to task mode', () => {
    const engine = makeEngine()
    assert.equal(engine.getMode(), 'task')
  })

  it('can switch to chat mode', () => {
    const engine = makeEngine()
    engine.setMode('chat')
    assert.equal(engine.getMode(), 'chat')
  })

  it('does not inject CVM projection in chat mode', () => {
    const engine = makeEngine('chat')
    engine.setCognitiveProjection('<cognitive-mirror confidence="1.00"/>')

    const request = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    const volatileMsg = request.messages.filter(m => m.role === 'user')[0]
    const content = typeof volatileMsg?.content === 'string' ? volatileMsg.content : ''

    assert.equal(content.includes('cognitive-mirror'), false)
  })

  it('injects CVM projection in task mode', () => {
    const engine = makeEngine('task')
    engine.setCognitiveProjection('<cognitive-mirror confidence="1.00"/>')

    const request = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    const volatileMsg = request.messages.filter(m => m.role === 'user')[0]
    const content = typeof volatileMsg?.content === 'string' ? volatileMsg.content : ''

    assert.equal(content.includes('cognitive-mirror'), true)
  })

  it('does not inject dynamic appendix in chat mode', () => {
    const engine = makeEngine('chat')
    engine.setBehaviorMirror('test behavior')
    engine.setStrategyShift('test strategy')
    engine.setRepairHint('test repair')

    const request = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    const volatileMsg = request.messages.filter(m => m.role === 'user')[0]
    const content = typeof volatileMsg?.content === 'string' ? volatileMsg.content : ''

    assert.equal(content.includes('behavior-mirror'), false)
    assert.equal(content.includes('strategy-shift'), false)
    assert.equal(content.includes('repair-hint'), false)
  })

  it('injects dynamic appendix in task mode', () => {
    const engine = makeEngine('task')
    engine.setTaskProgress({ completed: ['step1'], current: 'step2', remaining: ['step3'], decisions: [] })
    engine.setDecisions(['decision1', 'decision2'])
    engine.setRepairHint('test repair')

    const request = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    const volatileMsg = request.messages.filter(m => m.role === 'user')[0]
    const content = typeof volatileMsg?.content === 'string' ? volatileMsg.content : ''

    assert.equal(content.includes('task-progress'), true)
    assert.equal(content.includes('decisions'), true)
    assert.equal(content.includes('repair-hint'), true)
  })

  it('does not track field habituation in chat mode', () => {
    const engine = makeEngine('chat')

    for (let i = 0; i < 10; i++) {
      engine.setActiveDomain({
        name: 'test-domain',
        volatileBlock: 'test content',
        motto: 'test motto',
      })
      engine.buildOaiRequest([{ role: 'user', content: `turn ${i}` }])
    }

    const request = engine.buildOaiRequest([{ role: 'user', content: 'final check' }])
    const volatileMsg = request.messages.filter(m => m.role === 'user')[0]
    const content = typeof volatileMsg?.content === 'string' ? volatileMsg.content : ''

    assert.equal(content.includes('test-domain'), true)
  })

  it('fingerprint invalidation works in both modes', () => {
    const engine = makeEngine('chat')
    const fp1 = engine.getFingerprint()

    engine.setMode('task')
    const fp2 = engine.getFingerprint()

    assert.deepEqual(fp1, fp2)
  })
})
