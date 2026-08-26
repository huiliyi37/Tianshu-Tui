import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSessions, sessionLabel, splitSessionLists } from '../webview-ui/src/session-list.ts'

const S = (
  id: string,
  title: string | undefined,
  extra: { archived?: boolean; status?: string } = {},
) => ({ id, title, status: extra.status ?? 'idle', archived: extra.archived === true })

test('sessionLabel: 有标题用标题，否则截 id', () => {
  assert.equal(sessionLabel(S('abcdefghij', '修权限词')), '修权限词')
  assert.equal(sessionLabel(S('abcdefghij', undefined)), 'abcdefgh')
  assert.equal(sessionLabel(S('abcdefghij', '  ')), 'abcdefgh')
})

test('splitSessionLists: archived 与进行中分开', () => {
  const { active, archived } = splitSessionLists([
    S('a', '活着'),
    S('b', '收了', { archived: true }),
    S('c', '也活'),
  ])
  assert.deepEqual(active.map((s) => s.id), ['a', 'c'])
  assert.deepEqual(archived.map((s) => s.id), ['b'])
})

test('filterSessions: 空查询原样；按标题或 id 子串（大小写不敏感）', () => {
  const list = [S('sess-AAA', '权限词统一'), S('sess-bbb', 'slash menu')]
  assert.equal(filterSessions(list, '').length, 2)
  assert.deepEqual(filterSessions(list, '权限').map((s) => s.id), ['sess-AAA'])
  assert.deepEqual(filterSessions(list, 'BBB').map((s) => s.id), ['sess-bbb'])
  assert.equal(filterSessions(list, '没有这个').length, 0)
})
