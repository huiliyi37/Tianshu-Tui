import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePhantomContinuation } from '../phantom-continuation.js'
import type { TaskContract } from '../../context/task-contract.js'

function contract(partial: Partial<TaskContract>): TaskContract {
  return {
    id: 'task-0-test',
    objective: 'do the thing',
    scope: { mentionedFiles: [] },
    constraints: [],
    successCriteria: [],
    status: 'executing',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
    ...partial,
  }
}

const BASE = {
  streamedText: '让我 grep 一下相关代码。',
  activeContract: undefined as TaskContract | undefined,
  autoContinueCount: 0,
  maxAutoContinue: 1,
  convergenceEscalated: false,
}

describe('evaluatePhantomContinuation — hard gates', () => {
  it('does not continue when feature disabled (maxAutoContinue=0)', () => {
    const d = evaluatePhantomContinuation({ ...BASE, maxAutoContinue: 0 })
    assert.equal(d.shouldContinue, false)
    assert.equal(d.reason, 'none')
  })

  it('does not continue when budget already exhausted', () => {
    const d = evaluatePhantomContinuation({ ...BASE, autoContinueCount: 1, maxAutoContinue: 1 })
    assert.equal(d.shouldContinue, false)
  })

  it('does not continue when convergence/doom-loop already escalated', () => {
    const d = evaluatePhantomContinuation({ ...BASE, convergenceEscalated: true })
    assert.equal(d.shouldContinue, false)
  })

  it('does not continue on an empty turn', () => {
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: '   ' })
    assert.equal(d.shouldContinue, false)
  })
})

describe('evaluatePhantomContinuation — Layer 1 task-contract', () => {
  it('continues when an actionable contract is open AND text has action intent', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: '让我 grep 一下相关代码，看看调用关系。',
      activeContract: contract({ status: 'executing' }),
    })
    assert.equal(d.shouldContinue, true)
    assert.equal(d.reason, 'contract-open')
    assert.ok(d.message.length > 0)
  })

  it('does NOT continue on pure-answer text even when contract is open', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: '两者的主要区别在于缓存策略不同，Layer 1 不检查文本而 Layer 2 检查。',
      activeContract: contract({ status: 'executing' }),
    })
    assert.equal(d.shouldContinue, false)
  })

  it('does NOT continue on social/trivial text even when contract is open', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: '好的，了解了。',
      activeContract: contract({ status: 'executing' }),
    })
    assert.equal(d.shouldContinue, false)
  })

  it('does NOT continue when contract open but action-promise without tool verb', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: '让我来分析一下当前的情况。',
      activeContract: contract({ status: 'executing' }),
    })
    assert.equal(d.shouldContinue, false)
  })

  it('does NOT continue when contract open but tool verb without action-promise', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: '需要修改 src/tools/bash.ts 中的路径验证逻辑。',
      activeContract: contract({ status: 'executing' }),
    })
    assert.equal(d.shouldContinue, false)
  })

  it('does not continue when the contract is ready_to_deliver', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: 'Here is a summary of the work so far.',
      activeContract: contract({ status: 'ready_to_deliver' }),
    })
    assert.equal(d.shouldContinue, false)
  })

  it('does not continue when the contract is blocked', () => {
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: 'Here is a summary of the work so far.',
      activeContract: contract({ status: 'blocked' }),
    })
    assert.equal(d.shouldContinue, false)
  })

  it('falls through to heuristic when contract is non-actionable', () => {
    // Use text WITH action intent so the check reaches isActionable
    // (not short-circuited by intent===false before the Layer 1 gate).
    // isActionable:false blocks Layer 1, but action-intent triggers Layer 2.
    const d = evaluatePhantomContinuation({
      ...BASE,
      streamedText: '让我 grep 一下相关代码。',
      activeContract: contract({ status: 'executing', isActionable: false }),
    })
    assert.equal(d.shouldContinue, true)
    assert.equal(d.reason, 'action-intent')
  })
})

describe('evaluatePhantomContinuation — Layer 2 action-intent heuristic', () => {
  it('continues on action-promise + tool-verb prose (no contract)', () => {
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: 'Let me run grep to search the code.' })
    assert.equal(d.shouldContinue, true)
    assert.equal(d.reason, 'action-intent')
  })

  it('continues on CJK action intent', () => {
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: '接下来我去查看 loop.ts 的实现。' })
    assert.equal(d.shouldContinue, true)
    assert.equal(d.reason, 'action-intent')
  })

  it('does not continue on a plain completion summary', () => {
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: 'I have finished the task and all tests pass.' })
    assert.equal(d.shouldContinue, false)
  })

  it('does not continue on a social ack', () => {
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: '好的，谢谢！' })
    assert.equal(d.shouldContinue, false)
  })

  it('does not continue on an answer without action intent', () => {
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: 'The capital of France is Paris.' })
    assert.equal(d.shouldContinue, false)
  })

  it('inspects only the tail for action intent on long output', () => {
    const filler = 'analysis. '.repeat(200)
    const d = evaluatePhantomContinuation({ ...BASE, streamedText: filler + ' 接下来我来运行测试。' })
    assert.equal(d.shouldContinue, true)
  })
})
