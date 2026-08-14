/**
 * image-attach.ts tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectImageMime, looksLikeImagePath, loadImageAttachment } from '../image-attach.js'

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function withTempPng() {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-img-'))
  const path = join(dir, 'test.png')
  writeFileSync(path, Buffer.from(PNG_B64, 'base64'))
  return {
    path,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

test('detectImageMime recognizes PNG', () => {
  const buf = Buffer.from(PNG_B64, 'base64')
  assert.equal(detectImageMime(buf, '/foo/bar.png'), 'image/png')
})

test('detectImageMime returns null when magic is unrecognized (no extension fallback)', () => {
  const buf = Buffer.from('not a real image')
  assert.equal(detectImageMime(buf, '/foo/bar.jpg'), null)
})

test('looksLikeImagePath recognizes supported extensions', () => {
  assert.equal(looksLikeImagePath('/tmp/shot.png'), true)
  assert.equal(looksLikeImagePath('/tmp/shot.JPG'), true)
  assert.equal(looksLikeImagePath('/tmp/shot.webp'), true)
  assert.equal(looksLikeImagePath('/tmp/scan.tiff'), true)
  assert.equal(looksLikeImagePath('/tmp/scan.TIF'), true)
  assert.equal(looksLikeImagePath('/tmp/scan.BMP'), true)
  assert.equal(looksLikeImagePath('/tmp/shot.txt'), false)
})

test('loadImageAttachment loads a valid PNG into a data URL', async () => {
  const { path, cleanup } = withTempPng()
  try {
    const attachment = await loadImageAttachment(path)
    assert.ok(attachment.dataUrl.startsWith('data:image/png;base64,'))
    assert.equal(attachment.mime, 'image/png')
    assert.equal(attachment.name, 'test.png')
  } finally {
    cleanup()
  }
})

test('loadImageAttachment rejects unsupported formats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-img-'))
  const path = join(dir, 'test.txt')
  writeFileSync(path, 'hello world')
  try {
    await assert.rejects(loadImageAttachment(path), /Unsupported image format/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadImageAttachment advertises resized JPEG bytes as PNG', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-img-'))
  const path = join(dir, 'large.jpg')
  const oversizedJpeg = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]),
    Buffer.alloc(192),
  ])
  writeFileSync(path, oversizedJpeg)
  let resizeCalls = 0
  try {
    const attachment = await loadImageAttachment(path, {
      maxBytes: 100,
      maxEdge: 32,
      resizeImage: async () => {
        resizeCalls++
        return Buffer.from(PNG_B64, 'base64')
      },
    })
    const encoded = attachment.dataUrl.split(',')[1]!
    const payload = Buffer.from(encoded, 'base64')

    assert.equal(resizeCalls, 1)
    assert.equal(attachment.mime, 'image/png')
    assert.ok(attachment.dataUrl.startsWith('data:image/png;base64,'))
    assert.equal(detectImageMime(payload, path), 'image/png')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
