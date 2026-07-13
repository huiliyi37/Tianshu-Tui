/**
 * InputLine image attachment state tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../input-line.js'

test('InputLine starts with empty images', () => {
  const input = new InputLine()
  assert.deepEqual(input.images, [])
  assert.deepEqual(input.imageSummary(), [])
})

test('addImage appends to images and summary reflects count', () => {
  const input = new InputLine()
  input.addImage('data:image/png;base64,aaa')
  assert.deepEqual(input.images, ['data:image/png;base64,aaa'])
  assert.deepEqual(input.imageSummary(), ['📎 1 image'])

  input.addImage('data:image/jpeg;base64,bbb')
  assert.deepEqual(input.images, ['data:image/png;base64,aaa', 'data:image/jpeg;base64,bbb'])
  assert.deepEqual(input.imageSummary(), ['📎 2 images'])
})

test('removeImage removes the targeted attachment', () => {
  const input = new InputLine()
  input.addImage('data:image/png;base64,aaa')
  input.addImage('data:image/jpeg;base64,bbb')
  input.removeImage(0)
  assert.deepEqual(input.images, ['data:image/jpeg;base64,bbb'])
})

test('submit carries images and then clears them', () => {
  let submitted = ''
  let submittedImages: string[] | undefined
  const input = new InputLine({
    onSubmit: (value, images) => {
      submitted = value
      submittedImages = images
    },
  })
  input.addImage('data:image/png;base64,aaa')
  input.handleKey('return', '', false, false)

  assert.equal(submitted, '')
  assert.deepEqual(submittedImages, ['data:image/png;base64,aaa'])
  assert.deepEqual(input.images, [])
})

test('images option seeds initial attachments', () => {
  const input = new InputLine({ images: ['data:image/png;base64,seed'] })
  assert.deepEqual(input.images, ['data:image/png;base64,seed'])
})

test('imageSummary truncates to maxWidth', () => {
  const input = new InputLine()
  input.addImage('data:image/png;base64,aaa')
  assert.deepEqual(input.imageSummary(5), ['📎 1…'])
})
