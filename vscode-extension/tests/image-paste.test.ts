import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAddImage, imageTooLarge, normalizeImageDataUrl } from '../webview-ui/src/image-paste.ts'

test('normalizeImageDataUrl: 接受 png/jpeg，jpg 改写成 jpeg，拒其它', () => {
  assert.ok(normalizeImageDataUrl('data:image/png;base64,aaaa'))
  assert.equal(normalizeImageDataUrl('data:image/jpg;base64,aaaa'), 'data:image/jpeg;base64,aaaa')
  assert.equal(normalizeImageDataUrl('data:image/svg+xml;base64,aaaa'), null)
  assert.equal(normalizeImageDataUrl('https://x/a.png'), null)
})

test('canAddImage: 最多 4 张', () => {
  assert.equal(canAddImage(3), true)
  assert.equal(canAddImage(4), false)
})

test('imageTooLarge: 超过 1.5MB 拒', () => {
  const small = 'data:image/png;base64,' + 'A'.repeat(100)
  assert.equal(imageTooLarge(small), false)
  const huge = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024)
  assert.equal(imageTooLarge(huge), true)
})
