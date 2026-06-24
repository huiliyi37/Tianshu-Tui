import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeComposerTextareaStyle } from '../Composer.tsx'

test('composer textarea grows until max height', () => {
  assert.deepEqual(computeComposerTextareaStyle(120), {
    height: '120px',
    overflowY: 'hidden',
  })
})

test('composer textarea scrolls after max height', () => {
  assert.deepEqual(computeComposerTextareaStyle(400), {
    height: '220px',
    overflowY: 'auto',
  })
})
