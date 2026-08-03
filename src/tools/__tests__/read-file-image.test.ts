import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { READ_FILE_TOOL } from '../read-file.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'read-file-image-test')

// 1x1 透明 PNG（合法最小 PNG 二进制）
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('read_file — 图片文件视觉分流', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('png → 经 images 通道返回 data URL，base64 可还原原文件', async () => {
    const file = join(TEST_DIR, 'shot.png')
    writeFileSync(file, PNG_BYTES)
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.ok(!result.isError, `expected success, got: ${result.content}`)
    assert.ok(result.content.includes('视觉附件'))
    assert.ok(Array.isArray(result.images) && result.images.length === 1)
    const url = result.images![0]!
    assert.ok(url.startsWith('data:image/png;base64,'), `wrong MIME prefix: ${url.slice(0, 40)}`)
    const decoded = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    assert.deepEqual(decoded, PNG_BYTES, 'base64 round-trips to the original bytes')
  })

  it('jpg → image/jpeg MIME', async () => {
    const file = join(TEST_DIR, 'photo.jpg')
    writeFileSync(file, PNG_BYTES) // 内容不重要，按扩展名分流
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.ok(!result.isError)
    assert.ok(result.images![0]!.startsWith('data:image/jpeg;base64,'))
  })

  it('超过 10MB 的图片 → 拒绝并指向缩放/OCR 绕行', async () => {
    const file = join(TEST_DIR, 'huge.png')
    writeFileSync(file, Buffer.alloc(11 * 1024 * 1024, 1))
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('image too large'))
    assert.ok(result.content.includes('tesseract'))
    assert.equal(result.images, undefined)
  })

  it('.pdf 仍走 binary 拒绝（不在图片分流内）', async () => {
    const file = join(TEST_DIR, 'doc.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.4 fake'))
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('binary'))
  })

  it('.ico 不在图片分流内，维持 binary 拒绝', async () => {
    const file = join(TEST_DIR, 'favicon.ico')
    writeFileSync(file, Buffer.alloc(64, 0))
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('binary'))
  })
})
