import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripIntraTurnRepetition } from '../dedup.js'

describe('stripIntraTurnRepetition', () => {
  it('returns short text unchanged', () => {
    assert.equal(stripIntraTurnRepetition('hello world'), 'hello world')
  })

  it('strips a 50-char chunk repeated twice', () => {
    const chunk = 'A'.repeat(50)
    const input = 'prefix' + chunk + chunk + 'suffix'
    const result = stripIntraTurnRepetition(input)
    assert.equal(result, 'prefix' + chunk + 'suffix')
  })

  it('strips a 100-char chunk repeated 3 times', () => {
    const chunk = 'X'.repeat(100)
    const input = chunk + chunk + chunk
    const result = stripIntraTurnRepetition(input)
    assert.equal(result, chunk)
  })

  it('strips a 200-char paragraph repeated twice', () => {
    const chunk = 'X'.repeat(200)
    const input = 'intro ' + chunk + chunk + ' outro'
    const result = stripIntraTurnRepetition(input)
    assert.equal(result, 'intro ' + chunk + ' outro')
  })

  it('does not modify text without repetition', () => {
    const input = 'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50)
    assert.equal(stripIntraTurnRepetition(input), input)
  })
})
