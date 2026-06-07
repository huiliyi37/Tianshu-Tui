import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkedAt, checked } from '../guard.js'

describe('checkedAt', () => {
  it('returns element at valid index', () => {
    const arr = ['a', 'b', 'c']
    assert.equal(checkedAt(arr, 0), 'a')
    assert.equal(checkedAt(arr, 2), 'c')
  })

  it('throws on out-of-bounds index', () => {
    const arr: number[] = []
    assert.throws(() => checkedAt(arr, 0), /Index 0 out of bounds/)
  })

  it('works with readonly arrays', () => {
    const arr: readonly string[] = ['x']
    const val: string = checkedAt(arr, 0)
    assert.equal(val, 'x')
  })
})

describe('checked', () => {
  it('returns value when non-null', () => {
    assert.equal(checked('hello'), 'hello')
    assert.equal(checked(42), 42)
  })

  it('throws on null', () => {
    assert.throws(() => checked(null, 'boom'), /boom/)
  })

  it('throws on undefined', () => {
    assert.throws(() => checked(undefined), /Value was null/)
  })

  it('narrows type after assert.ok + checked combo', () => {
    const maybe: string | null = 'safe'
    assert.ok(maybe)
    const val: string = checked(maybe)
    assert.equal(val.length, 4)
  })
})
