import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterCommands, fuzzyScore, type Command } from '../commands.ts'

function cmd(id: string, label: string, hint?: string): Command {
  return { id, label, hint, run: () => {} }
}

test('empty query returns all commands unchanged', () => {
  const items = [cmd('a', 'Alpha'), cmd('b', 'Beta')]
  assert.deepEqual(filterCommands(items, '').map((c) => c.id), ['a', 'b'])
  assert.deepEqual(filterCommands(items, '   ').map((c) => c.id), ['a', 'b'])
})

test('substring match wins over subsequence and ranks earlier hits higher', () => {
  const items = [
    cmd('1', '前往设置'),
    cmd('2', '设置主题'),
    cmd('3', '无关项'),
  ]
  const r = filterCommands(items, '设置')
  assert.deepEqual(r.map((c) => c.id), ['2', '1'])
})

test('matches against hint as well as label', () => {
  const items = [cmd('1', '新建线程', '操作'), cmd('2', '切换主题', '外观')]
  const r = filterCommands(items, '外观')
  assert.deepEqual(r.map((c) => c.id), ['2'])
})

test('fuzzyScore: miss is -1, subsequence positive, substring higher', () => {
  assert.equal(fuzzyScore('hello', 'xyz'), -1)
  assert.ok(fuzzyScore('hello world', 'hw') > 0)
  assert.ok(fuzzyScore('hello', 'hel') > fuzzyScore('aaahello', 'hel'))
})
