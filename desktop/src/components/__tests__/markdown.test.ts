import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeUnterminatedFence } from '../Markdown.tsx'

test('leaves text without fences untouched', () => {
  const s = 'hello **world**\n- a\n- b'
  assert.equal(closeUnterminatedFence(s), s)
})

test('leaves a closed fence (even count) untouched', () => {
  const s = '```ts\nconst x = 1\n```\ndone'
  assert.equal(closeUnterminatedFence(s), s)
})

test('appends a closing fence for a half-open block (odd count)', () => {
  const s = 'intro\n```ts\nconst x = 1'
  assert.equal(closeUnterminatedFence(s), 'intro\n```ts\nconst x = 1\n```')
})

test('does not add an extra newline when source already ends with one', () => {
  const s = '```ts\nconst x = 1\n'
  assert.equal(closeUnterminatedFence(s), '```ts\nconst x = 1\n```')
})

test('counts two opening fences as still-open (odd) and closes the third pending one', () => {
  // Two complete blocks (4 fences) + one half-open (5th) => odd => close.
  const s = '```a\n1\n```\n```b\n2\n```\n```c\n3'
  assert.equal(closeUnterminatedFence(s), `${s}\n\`\`\``)
})

test('ignores backticks that are not line-leading fences', () => {
  const s = 'use `inline` code and ```` not a fence inline'
  // No line-leading ``` => unchanged.
  assert.equal(closeUnterminatedFence(s), s)
})
