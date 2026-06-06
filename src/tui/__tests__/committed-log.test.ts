import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCommittedLog } from '../committed-log.js'
import { createLogEntry } from '../log-state.js'

const entry = (content: string) => createLogEntry({ type: 'assistant_message', content })

describe('committed-log: append + items', () => {
  it('appends entries and items() returns them in order', () => {
    const log = createCommittedLog()
    log.append(entry('a'))
    log.append(entry('b'))
    const items = log.items()
    assert.equal(items.length, 2)
    assert.equal(items[0]!.content, 'a')
    assert.equal(items[1]!.content, 'b')
  })

  it('items() never shrinks across appends (monotonic length)', () => {
    const log = createCommittedLog()
    const lengths: number[] = []
    for (let i = 0; i < 50; i++) {
      log.append(entry(`m${i}`))
      lengths.push(log.items().length)
    }
    for (let i = 1; i < lengths.length; i++) {
      assert.ok(lengths[i]! >= lengths[i - 1]!, `length dropped at ${i}`)
    }
    assert.equal(log.length, 50)
  })
})

describe('committed-log: dedup', () => {
  it('skips an entry with identical type + content prefix, returns false', () => {
    const log = createCommittedLog()
    assert.equal(log.append(entry('hello world')), true)
    assert.equal(log.append(entry('hello world')), false)
    assert.equal(log.items().length, 1)
  })

  it('dedup is bounded to recent window (re-append after 16 distinct is allowed)', () => {
    const log = createCommittedLog()
    log.append(entry('x'))
    for (let i = 0; i < 16; i++) log.append(entry(`d${i}`))
    assert.equal(log.append(entry('x')), true)
    assert.equal(log.length, 18)
  })

  it('dedup keys on type+content prefix (different type not deduped)', () => {
    const log = createCommittedLog()
    log.append(createLogEntry({ type: 'assistant_message', content: 'same' }))
    assert.equal(log.append(createLogEntry({ type: 'system', content: 'same' })), true)
    assert.equal(log.length, 2)
  })
})

describe('committed-log: releaseRendered', () => {
  it('nulls content before (length - keepLast) but keeps array length and ids', () => {
    const log = createCommittedLog()
    for (let i = 0; i < 10; i++) log.append(entry(`line${i}`))
    log.releaseRendered(3)
    const items = log.items()
    assert.equal(items.length, 10, 'length must NOT change (index stability)')
    for (let i = 0; i < 7; i++) {
      assert.equal(items[i]!.content, '', `entry ${i} content should be released`)
      assert.ok(items[i]!.id, 'id preserved for stable memo key')
      assert.equal(items[i]!.type, 'assistant_message')
    }
    for (let i = 7; i < 10; i++) {
      assert.equal(items[i]!.content, `line${i}`)
    }
  })

  it('keepLast >= length releases nothing', () => {
    const log = createCommittedLog()
    log.append(entry('a'))
    log.append(entry('b'))
    log.releaseRendered(5)
    assert.equal(log.items()[0]!.content, 'a')
  })

  it('is idempotent (double release does not throw or corrupt)', () => {
    const log = createCommittedLog()
    for (let i = 0; i < 5; i++) log.append(entry(`x${i}`))
    log.releaseRendered(1)
    log.releaseRendered(1)
    assert.equal(log.items().length, 5)
    assert.equal(log.items()[4]!.content, 'x4')
  })
})

describe('committed-log: reset (rewind only)', () => {
  it('clears items and dedup so prior content can be re-appended', () => {
    const log = createCommittedLog()
    log.append(entry('a'))
    log.append(entry('b'))
    log.reset()
    assert.equal(log.length, 0)
    assert.equal(log.append(entry('a')), true, 'dedup also cleared')
    assert.equal(log.length, 1)
  })
})
