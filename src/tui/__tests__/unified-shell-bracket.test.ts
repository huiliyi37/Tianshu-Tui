import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { formatGlanceLeft, formatGlanceRight, stripAnsiLen } from '../format/glance-bar.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('Unified Shell Bracket Elements', () => {
  it('formats glance left correctly', () => {
    const input = {
      width: 80,
      domainGlyph: '✹',
      domainName: '天枢',
      branch: 'main',
    }
    const leftStr = formatGlanceLeft(input, theme)
    const plain = stripAnsi(leftStr)
    assert.ok(plain.includes('✹'))
    assert.ok(plain.includes('天枢'))
    assert.ok(plain.includes('(main)'))
    
    // Check custom CJK stripAnsiLen matches string-width
    assert.equal(stripAnsiLen(leftStr), stringWidth(plain))
  })

  it('formats glance right correctly', () => {
    const input = {
      width: 100,
      modelName: 'deepseek-chat',
      cacheHitRate: 0.25,
      estimatedTokens: 120_000,
      maxTokens: 1_000_000,
      cost: 0.15,
      elapsedMs: 120_000,
    }
    const rightStr = formatGlanceRight(input, theme)
    const plain = stripAnsi(rightStr)
    assert.ok(plain.includes('deepseek-chat'))
    assert.ok(plain.includes('⚡25%'))
    assert.ok(plain.includes('◧120k/1.0M'))
    assert.ok(plain.includes('$0.15'))
    assert.ok(plain.includes('2m0s'))
    
    // Check width calculation consistency
    assert.equal(stripAnsiLen(rightStr), stringWidth(plain))
  })

  it('behaves correctly in narrow terminals', () => {
    const input = {
      width: 50,
      narrow: true,
      domainGlyph: '⚙',
      domainName: 'Auto',
      branch: 'main',
      modelName: 'very-long-model-name-goes-here',
    }
    const leftStr = formatGlanceLeft(input, theme)
    const rightStr = formatGlanceRight(input, theme)

    const plainLeft = stripAnsi(leftStr)
    const plainRight = stripAnsi(rightStr)

    // Branch should be hidden in narrow left
    assert.ok(!plainLeft.includes('main'))
    // Model name should be truncated in narrow right
    assert.ok(plainRight.includes('very-long-mo'))
    assert.ok(!plainRight.includes('very-long-model-name-goes-here'))
  })
})
