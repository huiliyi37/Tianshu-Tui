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

test('detectImageMime falls back to extension', () => {
  const buf = Buffer.from('not a real image')
  assert.equal(detectImageMime(buf, '/foo/bar.jpg'), 'image/jpeg')
})

test('looksLikeImagePath recognizes supported extensions', () => {
  assert.equal(looksLikeImagePath('/tmp/shot.png'), true)
  assert.equal(looksLikeImagePath('/tmp/shot.JPG'), true)
  assert.equal(looksLikeImagePath('/tmp/shot.webp'), true)
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
