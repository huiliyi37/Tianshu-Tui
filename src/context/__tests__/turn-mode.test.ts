import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTurnMode,
  extractTaskContract,
  isSocialOrTrivial,
  type TaskContract,
} from '../task-contract.js'

function activeContract(objective = '修复 loop.ts 内存泄露'): TaskContract {
  return { ...extractTaskContract(objective, 1), status: 'executing' }
}

function deliveredContract(): TaskContract {
  return { ...extractTaskContract('修复 loop.ts 内存泄露', 1), status: 'ready_to_deliver' }
}

describe('isSocialOrTrivial', () => {
  it('detects empty input', () => {
    assert.equal(isSocialOrTrivial(''), true)
    assert.equal(isSocialOrTrivial('   '), true)
  })

  it('detects Chinese greetings', () => {
    assert.equal(isSocialOrTrivial('你好'), true)
    assert.equal(isSocialOrTrivial('谢谢'), true)
    assert.equal(isSocialOrTrivial('辛苦了'), true)
    assert.equal(isSocialOrTrivial('了解'), true)
    assert.equal(isSocialOrTrivial('收到'), true)
  })

  it('detects English greetings', () => {
    assert.equal(isSocialOrTrivial('hi'), true)
    assert.equal(isSocialOrTrivial('hello there'), true)
    assert.equal(isSocialOrTrivial('thanks'), true)
    assert.equal(isSocialOrTrivial('ok'), true)
  })

  it('does not flag substantive messages', () => {
    assert.equal(isSocialOrTrivial('修复这个bug'), false)
    assert.equal(isSocialOrTrivial('fix the auth bug'), false)
    assert.equal(isSocialOrTrivial('做 P1'), false)
  })
})

describe('classifyTurnMode', () => {
  describe('chat mode', () => {
    it('returns chat for greetings without active contract', () => {
      assert.equal(classifyTurnMode('你好'), 'chat')
      assert.equal(classifyTurnMode('谢谢'), 'chat')
      assert.equal(classifyTurnMode('hi'), 'chat')
    })

    it('returns chat for greetings even with active contract', () => {
      assert.equal(classifyTurnMode('谢谢', activeContract()), 'chat')
      assert.equal(classifyTurnMode('ok', activeContract()), 'chat')
    })

    it('returns chat for short non-actionable without contract', () => {
      assert.equal(classifyTurnMode('嗯'), 'chat')
    })
  })

  describe('followUp mode', () => {
    it('returns followUp for short directives with active contract', () => {
      assert.equal(classifyTurnMode('做 P1', activeContract()), 'followUp')
      assert.equal(classifyTurnMode('继续', activeContract()), 'followUp')
      assert.equal(classifyTurnMode('然后呢', activeContract()), 'followUp')
      assert.equal(classifyTurnMode('好 继续', activeContract()), 'followUp')
    })

    it('returns followUp for non-actionable messages with active contract', () => {
      assert.equal(classifyTurnMode('嗯嗯好的', activeContract()), 'followUp')
    })

    it('does NOT return followUp when contract is delivered', () => {
      assert.equal(classifyTurnMode('做 P1', deliveredContract()), 'chat')
    })

    it('does NOT return followUp without active contract', () => {
      assert.equal(classifyTurnMode('做 P1'), 'chat')
    })
  })

  describe('task mode', () => {
    it('returns task for substantive messages', () => {
      assert.equal(classifyTurnMode('修复 loop.ts 的内存泄露'), 'task')
      assert.equal(classifyTurnMode('重构 src/api/client.ts 的重试逻辑'), 'task')
    })

    it('returns task for messages with file references even when short', () => {
      assert.equal(classifyTurnMode('看看 src/agent/loop.ts', activeContract()), 'task')
    })

    it('returns task for messages with constraint markers', () => {
      assert.equal(classifyTurnMode('优化一下，不要改接口', activeContract()), 'task')
    })

    it('returns task for long messages even with active contract', () => {
      assert.equal(classifyTurnMode('帮我重构这个模块的依赖注入，使用工厂模式替代直接构造', activeContract()), 'task')
    })

    it('returns task without active contract for actionable messages', () => {
      assert.equal(classifyTurnMode('修复这个 bug 并添加测试'), 'task')
    })
  })
})
