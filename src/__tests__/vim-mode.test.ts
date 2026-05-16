import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VimState, processVimKey } from '../tui/vim-mode.js'

describe('VimState', () => {
  it('starts in insert mode', () => {
    const state = new VimState()
    assert.equal(state.mode, 'insert')
  })

  it('Escape switches to normal mode', () => {
    const state = new VimState()
    const result = processVimKey(state, { key: 'escape' })
    assert.equal(result.mode, 'normal')
  })

  it('i in normal mode switches to insert', () => {
    const state = new VimState('normal')
    const result = processVimKey(state, { key: 'i' })
    assert.equal(result.mode, 'insert')
  })

  it('h/l moves cursor in normal mode', () => {
    const state = new VimState('normal', { cursor: 5, text: 'hello world' })
    const r1 = processVimKey(state, { key: 'h' })
    assert.equal(r1.cursor, 4)
    const r2 = processVimKey(state, { key: 'l' })
    assert.equal(r2.cursor, 6)
  })

  it('w moves to next word boundary', () => {
    const state = new VimState('normal', { cursor: 0, text: 'hello world foo' })
    const result = processVimKey(state, { key: 'w' })
    assert.equal(result.cursor, 6)
  })

  it('b moves to previous word boundary', () => {
    const state = new VimState('normal', { cursor: 12, text: 'hello world foo' })
    const result = processVimKey(state, { key: 'b' })
    assert.equal(result.cursor, 6)
  })

  it('dd clears the line', () => {
    const state = new VimState('normal', { cursor: 3, text: 'hello world' })
    const result = processVimKey(state, { key: 'd', pending: 'd' })
    assert.equal(result.text, '')
    assert.equal(result.cursor, 0)
  })

  it('A moves to end and enters insert', () => {
    const state = new VimState('normal', { cursor: 0, text: 'hello' })
    const result = processVimKey(state, { key: 'A' })
    assert.equal(result.mode, 'insert')
    assert.equal(result.cursor, 5)
  })

  it('0 moves to start of line', () => {
    const state = new VimState('normal', { cursor: 8, text: 'hello world' })
    const result = processVimKey(state, { key: '0' })
    assert.equal(result.cursor, 0)
  })

  it('$ moves to end of line', () => {
    const state = new VimState('normal', { cursor: 2, text: 'hello world' })
    const result = processVimKey(state, { key: '$' })
    assert.equal(result.cursor, 10)
  })

  it('x deletes char at cursor', () => {
    const state = new VimState('normal', { cursor: 1, text: 'abcde' })
    const result = processVimKey(state, { key: 'x' })
    assert.equal(result.text, 'acde')
    assert.equal(result.cursor, 1)
  })

  it('I moves to start and enters insert', () => {
    const state = new VimState('normal', { cursor: 5, text: 'hello world' })
    const result = processVimKey(state, { key: 'I' })
    assert.equal(result.mode, 'insert')
    assert.equal(result.cursor, 0)
  })
})
