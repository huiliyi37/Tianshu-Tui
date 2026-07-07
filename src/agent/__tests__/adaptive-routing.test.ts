import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectModelForComplexity } from '../adaptive-routing.js'

describe('selectModelForComplexity', () => {
  it('returns flash model for low complexity', () => {
    assert.equal(
      selectModelForComplexity('low', { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' }),
      'deepseek-v4-flash',
    )
  })

  it('returns pro model for high complexity', () => {
    assert.equal(
      selectModelForComplexity('high', { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' }),
      'deepseek-v4-pro',
    )
  })
})
