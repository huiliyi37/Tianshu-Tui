import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { alchemyBar, alchemyStage } from '../alchemy-bar.js'

describe('alchemyStage', () => {
  it('returns nigredo for low confidence', () => {
    assert.equal(alchemyStage(0.1), 'nigredo')
    assert.equal(alchemyStage(0.29), 'nigredo')
  })

  it('returns albedo for mid-low confidence', () => {
    assert.equal(alchemyStage(0.3), 'albedo')
    assert.equal(alchemyStage(0.49), 'albedo')
  })

  it('returns citrinitas for mid-high confidence', () => {
    assert.equal(alchemyStage(0.5), 'citrinitas')
    assert.equal(alchemyStage(0.79), 'citrinitas')
  })

  it('returns rubedo for high confidence', () => {
    assert.equal(alchemyStage(0.8), 'rubedo')
    assert.equal(alchemyStage(1.0), 'rubedo')
  })
})

describe('alchemyBar', () => {
  it('renders 4-char bar with correct fill level', () => {
    assert.equal(alchemyBar(0.1).length, 4)
    assert.equal(alchemyBar(0.9).length, 4)
  })

  it('renders all empty for nigredo', () => {
    assert.equal(alchemyBar(0.1), '░░░░')
  })

  it('renders partial for albedo', () => {
    assert.equal(alchemyBar(0.4), '▓░░░')
  })

  it('renders mostly full for citrinitas', () => {
    assert.equal(alchemyBar(0.7), '██▓░')
  })

  it('renders full for rubedo', () => {
    assert.equal(alchemyBar(0.95), '████')
  })
})
