import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import i18n, { initI18n } from '../../i18n'
import { isImageFile, isTextFile, isArchiveFile, isUnsupportedFile, formatUnsupportedFiles, detectImageMimeByMagic } from '../file-types'

// formatUnsupportedFiles/describeUnsupportedFile resolve through i18n; pin the
// language to zh-CN so assertions are deterministic regardless of host locale.
before(async () => {
  await initI18n()
  await i18n.changeLanguage('zh-CN')
})

function file(name: string, type = ''): File {
  return new File([], name, { type })
}

describe('file-types', () => {
  describe('isImageFile', () => {
    test('accepts common raster images by MIME', () => {
      assert.equal(isImageFile(file('a.png', 'image/png')), true)
      assert.equal(isImageFile(file('a.jpg', 'image/jpeg')), true)
      assert.equal(isImageFile(file('a.webp', 'image/webp')), true)
      assert.equal(isImageFile(file('a.gif', 'image/gif')), true)
    })

    test('accepts images by extension when MIME is empty (Windows)', () => {
      assert.equal(isImageFile(file('a.png', '')), true)
      assert.equal(isImageFile(file('a.jpeg', '')), true)
      assert.equal(isImageFile(file('a.bmp', '')), true)
    })

    test('rejects SVG', () => {
      assert.equal(isImageFile(file('a.svg', 'image/svg+xml')), false)
      assert.equal(isImageFile(file('a.svg', '')), false)
    })

    test('rejects non-images', () => {
      assert.equal(isImageFile(file('a.zip', 'application/zip')), false)
      assert.equal(isImageFile(file('a.txt', 'text/plain')), false)
    })
  })

  describe('isTextFile', () => {
    test('accepts text files by MIME', () => {
      assert.equal(isTextFile(file('a.txt', 'text/plain')), true)
      assert.equal(isTextFile(file('a.json', 'application/json')), true)
    })

    test('accepts code files by extension', () => {
      assert.equal(isTextFile(file('a.ts', '')), true)
      assert.equal(isTextFile(file('a.tsx', '')), true)
      assert.equal(isTextFile(file('a.py', '')), true)
      assert.equal(isTextFile(file('a.md', '')), true)
      assert.equal(isTextFile(file('Dockerfile', '')), true)
    })

    test('rejects images and archives', () => {
      assert.equal(isTextFile(file('a.png', 'image/png')), false)
      assert.equal(isTextFile(file('a.zip', '')), false)
    })
  })

  describe('isArchiveFile', () => {
    test('detects common archives', () => {
      assert.equal(isArchiveFile(file('a.zip', '')), true)
      assert.equal(isArchiveFile(file('a.rar', '')), true)
      assert.equal(isArchiveFile(file('a.7z', '')), true)
      assert.equal(isArchiveFile(file('a.tar.gz', '')), true)
      assert.equal(isArchiveFile(file('a.tar.bz2', '')), true)
      assert.equal(isArchiveFile(file('a.tar.xz', '')), true)
    })

    test('rejects non-archives', () => {
      assert.equal(isArchiveFile(file('a.png', '')), false)
      assert.equal(isArchiveFile(file('a.txt', '')), false)
    })
  })

  describe('isUnsupportedFile', () => {
    test('rejects archives', () => {
      assert.equal(isUnsupportedFile(file('a.zip', 'application/zip')), true)
    })

    test('rejects binaries without extension', () => {
      assert.equal(isUnsupportedFile(file('binary', '')), true)
    })

    test('rejects known unsupported extensions', () => {
      assert.equal(isUnsupportedFile(file('a.pdf', '')), true)
      assert.equal(isUnsupportedFile(file('a.exe', '')), true)
      assert.equal(isUnsupportedFile(file('a.mp4', '')), true)
    })

    test('accepts images and text files', () => {
      assert.equal(isUnsupportedFile(file('a.png', 'image/png')), false)
      assert.equal(isUnsupportedFile(file('a.ts', '')), false)
    })
  })

  describe('formatUnsupportedFiles', () => {
    test('returns empty for empty list', () => {
      assert.equal(formatUnsupportedFiles([]), '')
    })

    test('describes a single archive', () => {
      assert.equal(
        formatUnsupportedFiles([file('assets.zip', '')]),
        'assets.zip 是压缩包，暂不支持，请解压后上传文件或图片',
      )
    })

    test('describes a single unsupported binary', () => {
      assert.equal(
        formatUnsupportedFiles([file('report.pdf', '')]),
        'report.pdf 暂不支持（仅支持图片或文本文件）',
      )
    })

    test('groups multiple archives', () => {
      assert.equal(
        formatUnsupportedFiles([file('a.zip', ''), file('b.tar.gz', '')]),
        'a.zip 等 2 个压缩包暂不支持，请解压后上传',
      )
    })

    test('prioritizes archive wording for mixed files', () => {
      assert.equal(
        formatUnsupportedFiles([file('a.zip', ''), file('b.pdf', '')]),
        'a.zip 等 2 个文件暂不支持（压缩包请解压后上传）',
      )
    })
  })

  describe('detectImageMimeByMagic', () => {
    function bytesFile(name: string, bytes: number[]): File {
      return new File([new Uint8Array(bytes)], name)
    }

    test('detects PNG without extension or MIME', async () => {
      const f = bytesFile('image', [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      assert.equal(await detectImageMimeByMagic(f), 'image/png')
      assert.equal(isImageFile({ type: await detectImageMimeByMagic(f) ?? '', name: f.name }), true)
    })

    test('detects JPEG without extension or MIME', async () => {
      const f = bytesFile('image', [0xFF, 0xD8, 0xFF, 0xE0])
      assert.equal(await detectImageMimeByMagic(f), 'image/jpeg')
    })

    test('detects GIF without extension or MIME', async () => {
      const f = bytesFile('image', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      assert.equal(await detectImageMimeByMagic(f), 'image/gif')
    })

    test('detects BMP without extension or MIME', async () => {
      const f = bytesFile('image', [0x42, 0x4D, 0x00, 0x00])
      assert.equal(await detectImageMimeByMagic(f), 'image/bmp')
    })

    test('detects WebP without extension or MIME', async () => {
      // RIFF....WEBP
      const f = bytesFile('image', [
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50,
      ])
      assert.equal(await detectImageMimeByMagic(f), 'image/webp')
    })

    test('returns null for unknown bytes', async () => {
      const f = bytesFile('image', [0x00, 0x01, 0x02, 0x03])
      assert.equal(await detectImageMimeByMagic(f), null)
    })

    test('returns null for empty file', async () => {
      const f = bytesFile('image', [])
      assert.equal(await detectImageMimeByMagic(f), null)
    })
  })
})
