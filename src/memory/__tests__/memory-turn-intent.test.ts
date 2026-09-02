import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { memoryQueryForTurn, stripSystemReminderSuffix } from '../memory-turn-intent.js'

describe('memory-turn-intent（记忆幻觉治理 P1）', () => {
  it('task 轮用当前用户文本，且剥离 system-reminder 尾巴', () => {
    assert.equal(
      memoryQueryForTurn('写一个新的数据导出功能<system-reminder>\n快收束</system-reminder>', 'task', '旧任务'),
      '写一个新的数据导出功能',
    )
  })

  it('普通 followUp 追问沿用旧 objective，避免“实施/继续”类指令造成记忆块 churn', () => {
    const objective = '排查 plan_task 超时与 worker 契约偏离'
    for (const input of ['继续', '实施', '接着做', '好', '下一步', '做 P2']) {
      assert.equal(memoryQueryForTurn(input, 'followUp', objective), objective)
    }
  })

  it('显式旧任务收口信号切换为当前文本，旧问题不再主导记忆检索', () => {
    const objective = '排查 worker 超时问题'
    for (const input of ['已解决了', '这个已经解决，做B5', '前面修好了', '之前完成了']) {
      const query = memoryQueryForTurn(input, 'followUp', objective)
      assert.notEqual(query, objective)
      assert.match(query, /解决|修好|完成|B5/)
    }
  })

  it('换新话题信号切换为当前文本', () => {
    const objective = '排查 worker 超时问题'
    for (const input of ['看看新问题', '问个别的事', '换个需求']) {
      assert.notEqual(memoryQueryForTurn(input, 'followUp', objective), objective)
    }
  })

  it('纯系统提醒回落到旧 objective，不拿提醒文本当 query', () => {
    const input = '<system-reminder>\n连续只读，请开始行动。\n</system-reminder>'
    assert.equal(stripSystemReminderSuffix(input), '')
    assert.equal(memoryQueryForTurn(input, 'followUp', '旧任务'), '旧任务')
  })

  it('意图路由高置信换题时，即使短句没有显式换题词也切到当前文本', () => {
    const objective = '排查 worker 超时问题'
    const previous = { confidence: 0.8, taskKinds: ['bug_fix'] }
    const current = { confidence: 0.85, taskKinds: ['usage_question'] }
    assert.equal(
      memoryQueryForTurn('字体', 'followUp', objective, { previous, current }),
      '字体',
      'LLM 已高置信判定为新任务类型，应换 query',
    )
  })

  it('意图路由低置信或 taskKinds 未变化时不换题', () => {
    const objective = '排查 worker 超时问题'
    const previous = { confidence: 0.8, taskKinds: ['bug_fix'] }
    assert.equal(
      memoryQueryForTurn('字体', 'followUp', objective, {
        previous,
        current: { confidence: 0.55, taskKinds: ['usage_question'] },
      }),
      objective,
    )
    assert.equal(
      memoryQueryForTurn('继续看日志', 'followUp', objective, {
        previous,
        current: { confidence: 0.8, taskKinds: ['bug_fix'] },
      }),
      objective,
    )
    assert.equal(
      memoryQueryForTurn('谢谢', 'followUp', objective, {
        previous,
        current: { confidence: 0.9, taskKinds: ['social_idle'] },
      }),
      objective,
    )
  })
})
