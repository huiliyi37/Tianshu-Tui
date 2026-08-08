/**
 * 长输出塌缩标记的统一性回归。
 *
 * 此前同一语义在四处各写各的（`… +N more lines` / `… +N earlier lines` /
 * `… +N 行` / `... N lines hidden ...`），用户在同一屏里会看到不同形态的
 * 「还有内容没显示」。这些断言钉住统一后的形态。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hiddenLinesMarker } from '../hidden-lines.js'

describe('hiddenLinesMarker', () => {
  it('中部省略：带剪刀符与两侧规则线', () => {
    const s = hiddenLinesMarker(71)
    assert.ok(s.includes('71'), `含行数: ${s}`)
    assert.ok(s.includes('已隐藏'), `含语义标签: ${s}`)
    assert.ok(/^[─-]{2,}/.test(s), `以规则线起头: ${s}`)
    assert.ok(/[─-]{2,}$/.test(s), `以规则线收尾: ${s}`)
  })

  it('上文省略变体用于「保留尾部」的场景（错误输出）', () => {
    const s = hiddenLinesMarker(5, 'earlier')
    assert.ok(s.includes('上文'), `应标明省略的是上文: ${s}`)
    assert.ok(s.includes('5'), `含行数: ${s}`)
  })

  it('两个变体形态一致、只有措辞不同', () => {
    const a = hiddenLinesMarker(3)
    const b = hiddenLinesMarker(3, 'earlier')
    assert.notEqual(a, b, '措辞应有区分')
    assert.equal(a.startsWith(a.slice(0, 3)), true)
    assert.equal(a.slice(0, 3), b.slice(0, 3), '起头规则线一致')
  })

  it('单行也不退化成别的说法', () => {
    assert.ok(hiddenLinesMarker(1).includes('1 行'))
  })
})
