import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialChatState, reduceEvent, type ChatState } from '../webview-ui/src/model.ts'

function feed(events: Array<{ type: string; data: Record<string, unknown> }>): ChatState {
  let state = initialChatState
  let seq = 0
  for (const e of events) {
    state = reduceEvent(state, { seq: ++seq, ts: seq, type: e.type, data: e.data })
  }
  return state
}

test('todo_state 全量镜像替换（不累积）', () => {
  const s = feed([
    { type: 'todo_state', data: { items: [{ id: '1', content: 'a', status: 'pending' }] } },
    {
      type: 'todo_state',
      data: {
        items: [
          { id: '1', content: 'a', status: 'completed' },
          { id: '2', content: 'b', status: 'in_progress' },
        ],
      },
    },
  ])
  assert.equal(s.todos.length, 2)
  assert.equal(s.todos[0]?.status, 'completed')
})

test('user_question 解析问题与选项，畸形项过滤', () => {
  const s = feed([
    {
      type: 'user_question',
      data: {
        toolUseId: 't9',
        questions: [
          { id: 'q1', prompt: '选哪个方案?', options: ['A', 'B'], allowMultiple: false },
          { id: 'bad', prompt: '', options: [] },
        ],
      },
    },
  ])
  const q = s.items[0]
  assert.equal(q?.kind, 'question')
  if (q?.kind === 'question') {
    assert.equal(q.questions.length, 1)
    assert.deepEqual(q.questions[0]?.options, ['A', 'B'])
  }
})

test('plan_mode / model_switched / domain_changed 更新会话状态', () => {
  const s = feed([
    { type: 'plan_mode', data: { state: 'planning' } },
    { type: 'model_switched', data: { modelId: 'deepseek-chat' } },
    { type: 'domain_changed', data: { key: 'tianquan', name: '天权' } },
  ])
  assert.equal(s.planMode, 'planning')
  assert.equal(s.askMode, 'off')
  assert.equal(s.model, 'deepseek-chat')
  assert.equal(s.domain, '天权')
})

test('ask_mode 与 plan_mode 互斥', () => {
  const asking = feed([
    { type: 'plan_mode', data: { state: 'planning' } },
    { type: 'ask_mode', data: { state: 'asking' } },
  ])
  assert.equal(asking.askMode, 'asking')
  assert.equal(asking.planMode, 'off')
  assert.equal(asking.planDrafting, false)

  const planned = reduceEvent(asking, { seq: 9, ts: 9, type: 'plan_mode', data: { state: 'planning' } })
  assert.equal(planned.planMode, 'planning')
  assert.equal(planned.askMode, 'off')
})
