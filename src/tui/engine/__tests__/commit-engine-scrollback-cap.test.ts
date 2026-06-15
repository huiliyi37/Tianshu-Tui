/**
 * B2 回归：CommitEngine.buffer 封顶——长会话下无界 string[] 改为 RingBuffer，
 * 超过上限后丢弃最旧条目，getContent() 只返回最近 N 条。
 *
 * 反证：如果 buffer 仍是 string[]（无封顶），写入 2000 条后 getContent 应包含
 * 第 1 条——封顶实现不应包含。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CommitEngine } from '../commit-engine.js'

function mockStdout() {
  const writes: string[] = []
  const stdout = {
    write: (chunk: string) => { writes.push(chunk); return true },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream
  return { stdout, writes }
}

describe('CommitEngine scrollback cap', () => {
  it('getContent 在封顶后只保留最近 N 条', () => {
    const { stdout } = mockStdout()
    const engine = new CommitEngine({ stdout, scrollbackMaxLines: 5 })
    for (let i = 0; i < 10; i++) {
      engine.write({ text: `line-${i}` })
    }
    const content = engine.getContent()
    const lines = content.split('\n')
    assert.equal(lines.length, 5, '应只保留最近 5 条')
    assert.ok(content.includes('line-9'), '应包含最后写入的条目')
    assert.ok(!content.includes('line-0'), '应已丢弃最早的条目')
    assert.ok(!content.includes('line-4'), '应已丢弃前 5 条')
    assert.ok(content.includes('line-5'), '应从第 6 条开始保留')
  })

  it('未超限时 getContent 返回全部内容', () => {
    const { stdout } = mockStdout()
    const engine = new CommitEngine({ stdout, scrollbackMaxLines: 100 })
    engine.write({ text: 'a' })
    engine.write({ text: 'b' })
    engine.write({ text: 'c' })
    assert.equal(engine.getContent(), 'a\nb\nc')
  })

  it('默认上限为 1000', () => {
    const { stdout } = mockStdout()
    const engine = new CommitEngine({ stdout })
    for (let i = 0; i < 1200; i++) {
      engine.write({ text: `entry-${i}` })
    }
    const lines = engine.getContent().split('\n')
    assert.equal(lines.length, 1000, '默认封顶 1000 行')
    assert.ok(lines[0]!.includes('entry-200'), '最早保留的应是第 201 条')
    assert.ok(lines[999]!.includes('entry-1199'), '最后保留的应是第 1200 条')
  })

  it('writeBatch 同样受封顶约束', () => {
    const { stdout } = mockStdout()
    const engine = new CommitEngine({ stdout, scrollbackMaxLines: 3 })
    engine.writeBatch([
      { text: 'x1' },
      { text: 'x2' },
      { text: 'x3' },
      { text: 'x4' },
      { text: 'x5' },
    ])
    const content = engine.getContent()
    assert.equal(content.split('\n').length, 3)
    assert.ok(content.includes('x5'))
    assert.ok(!content.includes('x1'))
  })
})
