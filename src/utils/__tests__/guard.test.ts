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

  it('returns a present-but-undefined element without throwing', () => {
    // (T | undefined)[] 中合法位置的 undefined 必须如实返回，
    // 不能被误判为越界——越界用索引比较，不用值哨兵。
    const arr: (string | undefined)[] = [undefined, 'b']
    assert.equal(checkedAt(arr, 0), undefined)
    assert.equal(checkedAt(arr, 1), 'b')
    // 真越界仍要抛
    assert.throws(() => checkedAt(arr, 2), /Index 2 out of bounds/)
  })

  it('throws on negative index', () => {
    assert.throws(() => checkedAt(['a'], -1), /Index -1 out of bounds/)
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
