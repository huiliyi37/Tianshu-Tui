import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CommitEngine } from '../engine/commit-engine.js'

/**
 * 创建一个模拟 WriteStream，捕获所有 write 调用。
 */
function mockStdout(): { stdout: NodeJS.WriteStream; writes: string[] } & { stdout: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = []
  const stdout = {
    write: (chunk: string) => { writes.push(chunk); return true },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream
  return { stdout, writes }
}

describe('CommitEngine', () => {
  it('writes a single committed entry with trailing newline', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.write({ text: 'hello world' })
    assert.equal(writes.length, 1)
    assert.equal(writes[0], 'hello world\n')
  })

  it('uses ansi field when provided', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.write({ text: 'plain', ansi: '\x1B[32mgreen\x1B[0m' })
    assert.equal(writes[0], '\x1B[32mgreen\x1B[0m\n')
  })

  it('does not double-append newline when content already ends with newline', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.write({ text: 'already\n' })
    assert.equal(writes[0], 'already\n')
  })

  it('appends trailing newline when trailingNewline is true', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.write({ text: 'entry', trailingNewline: true })
    assert.equal(writes[0], 'entry\n\n')
  })

  it('writeBatch writes all entries', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.writeBatch([
      { text: 'first' },
      { text: 'second' },
    ])
    assert.equal(writes.length, 1)
    assert.ok(writes[0]!.includes('first'))
    assert.ok(writes[0]!.includes('second'))
  })

  it('writeRaw writes exactly the given string', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.writeRaw('\x1B[31mRED\x1B[0m')
    assert.equal(writes[0], '\x1B[31mRED\x1B[0m')
  })

  it('writeSeparator produces a dim horizontal line', () => {
    const { stdout, writes } = mockStdout()
    const engine = new CommitEngine({ stdout })
    engine.writeSeparator(40)
    assert.ok(writes[0]!.includes('─'.repeat(40)))
    assert.ok(writes[0]!.includes('\x1B[2m'))
    assert.ok(writes[0]!.endsWith('\x1B[0m\n'))
  })
})
