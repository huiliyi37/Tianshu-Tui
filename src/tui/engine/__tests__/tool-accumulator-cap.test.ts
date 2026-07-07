/**
 * B3 回归：capToolAccumulator——工具流式输出累加器的字节封顶。
 * 超限后保留尾部 + 省略前缀，防止超大输出工具（如 cat 100MB 文件）撑爆内存。
 *
 * 反证：如果累加不封顶（直接 `toolAcc + result`），10MB 输入应返回 10MB 字符串；
 * 封顶实现应在 ~64KB 处截断。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { capToolAccumulator, TOOL_ACCUMULATOR_MAX_BYTES } from '../app.js'

describe('capToolAccumulator', () => {
  it('短文本不截断', () => {
    assert.equal(capToolAccumulator('hello world', 1024), 'hello world')
  })

  it('恰好等于上限不截断', () => {
    const text = 'x'.repeat(100)
    assert.equal(capToolAccumulator(text, 100), text)
  })

  it('超限时保留尾部并添加省略前缀', () => {
    const text = 'HEAD'.repeat(100) + '\nTAIL'
    const capped = capToolAccumulator(text, 50)
    assert.ok(capped.startsWith('… [truncated '), '应标注截断信息')
    assert.ok(capped.endsWith('TAIL'), '应保留尾部内容')
    assert.ok(capped.length < text.length, '截断后应更短')
  })

  it('截断后从行边界开始（不截断在行中间）', () => {
    // 构造：长文本，尾部有明确的行分隔
    const head = 'A'.repeat(200)
    const tailLine = 'B'.repeat(30)
    const text = head + '\n' + tailLine
    const capped = capToolAccumulator(text, 50)
    // 尾部的 \n 之后的 B... 行应完整保留
    assert.ok(capped.includes(tailLine), '行边界后的完整行应保留')
  })

  it('默认上限 64KB 能防止内存撑爆', () => {
    // 模拟 10MB 工具输出
    const huge = 'x'.repeat(10 * 1024 * 1024)
    const capped = capToolAccumulator(huge, TOOL_ACCUMULATOR_MAX_BYTES)
    assert.ok(capped.length <= TOOL_ACCUMULATOR_MAX_BYTES + 100, '截断后应在 64KB 量级，远小于 10MB')
    assert.ok(capped.startsWith('… [truncated '), '应标注截断')
  })
})
