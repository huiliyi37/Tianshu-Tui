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

// ── RED: 附件删除与恢复（2026-08 用户反馈：粘贴图片后删不掉、Ctrl+C 清不掉）──
test('RED: backspace with empty text removes the last image attachment', () => {
  const input = new InputLine()
  input.addImage('data:image/png;base64,aaa')
  input.addImage('data:image/jpeg;base64,bbb')
  input.handleKey('backspace', '', false, false)
  assert.deepEqual(input.images, ['data:image/png;base64,aaa'], 'backspace 应删除最后一张图')
  input.handleKey('backspace', '', false, false)
  assert.deepEqual(input.images, [], '再按一次删光')
})

test('RED: backspace with text present deletes text, not images', () => {
  const input = new InputLine()
  input.setValue('hi')
  input.addImage('data:image/png;base64,aaa')
  input.handleKey('backspace', '', false, false)
  assert.equal(input.value, 'h', '文本被删')
  assert.deepEqual(input.images, ['data:image/png;base64,aaa'], '图片保留')
})

test('RED: clearAll wipes text+images and undo restores both', () => {
  const input = new InputLine()
  input.setValue('hello')
  input.addImage('data:image/png;base64,aaa')
  input.clearAll()
  assert.equal(input.value, '')
  assert.deepEqual(input.images, [])
  input.handleKey('ctrl_z', '', true, false)
  assert.equal(input.value, 'hello', 'undo 恢复文本')
  assert.deepEqual(input.images, ['data:image/png;base64,aaa'], 'undo 恢复图片')
})

test('RED: clearImages is undoable (Ctrl+Z restores attachments)', () => {
  const input = new InputLine()
  input.setValue('note')
  input.addImage('data:image/png;base64,aaa')
  input.clearImages()
  assert.deepEqual(input.images, [])
  input.handleKey('ctrl_z', '', true, false)
  assert.deepEqual(input.images, ['data:image/png;base64,aaa'], 'undo 恢复图片')
  assert.equal(input.value, 'note', '文本不受影响')
})
