/**
 * image-tool.ts tests：isCompletePng 完整性校验 + runImageTool 截断 PNG fallback
 * + 全失败时 RIVET_DEBUG 调试输出可观测性。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCompletePng, resizeCandidates, runImageTool } from '../image-tool.js'

// 1x1 transparent PNG（含完整 IHDR + IEND）
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BUF = Buffer.from(PNG_1X1, 'base64')

/** 用 node -e 构造假命令，不依赖 sips/ImageMagick 真实存在。 */
function fakeCmd(script: string, ...extraArgs: string[]): { bin: string; args: string[] } {
  return { bin: process.execPath, args: ['-e', script, ...extraArgs] }
}

/** 写出指定字节的假命令脚本。 */
function writeBytesScript(buf: Buffer): string {
  return `require('node:fs').writeFileSync(process.argv[1], Buffer.from('${buf.toString('base64')}','base64'))`
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  return fn(dir).finally(() => { rmSync(dir, { recursive: true, force: true }) })
}

// ── isCompletePng ────────────────────────────────────────────────────────────

test('isCompletePng：仅 signature（8 字节）不算完整 PNG', () => {
  assert.equal(isCompletePng(PNG_BUF.subarray(0, 8)), false)
})

test('isCompletePng：截断 IHDR 不算完整 PNG', () => {
  // 截到 IHDR 数据中间（signature + length/type + 部分 data）
  assert.equal(isCompletePng(PNG_BUF.subarray(0, 20)), false)
  // IHDR 宽度为 0 的伪造 chunk
  const zeroWidth = Buffer.from(PNG_BUF)
  zeroWidth.writeUInt32BE(0, 16)
  assert.equal(isCompletePng(zeroWidth), false)
})

test('isCompletePng：缺 IEND 不算完整 PNG', () => {
  assert.equal(isCompletePng(PNG_BUF.subarray(0, PNG_BUF.length - 12)), false)
})

test('isCompletePng：完整 PNG（PNG_1X1）通过', () => {
  assert.equal(isCompletePng(PNG_BUF), true)
})

test('isCompletePng：非 PNG 内容不通过', () => {
  assert.equal(isCompletePng(Buffer.from('not a real image at all, definitely long enough to pass length gate........')), false)
})

// ── runImageTool：截断 PNG → fallback 下一候选 ───────────────────────────────

test('runImageTool：产出截断 PNG 时 fallback 到下一候选', async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, 'out.png')
    // 第一个候选 exit 0 但只写出 signature + 截断 IHDR；第二个产出完整 PNG
    const result = await runImageTool([
      fakeCmd(writeBytesScript(PNG_BUF.subarray(0, 20)), out),
      fakeCmd(writeBytesScript(PNG_BUF), out),
    ], out)
    assert.deepEqual(result, PNG_BUF)
  })
})

// ── RIVET_DEBUG 失败可观测性 ─────────────────────────────────────────────────

async function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
  const origError = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.error = origError
  }
  return lines
}

test('runImageTool：全部失败且 RIVET_DEBUG 非空时输出一行调试信息', async () => {
  const origDebug = process.env.RIVET_DEBUG
  process.env.RIVET_DEBUG = '1'
  try {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out.png')
      const lines = await captureConsoleError(async () => {
        const result = await runImageTool([fakeCmd('process.exit(1)', out)], out)
        assert.equal(result, null)
      })
      assert.equal(lines.length, 1)
      assert.ok(lines[0]?.includes('[image-tool]'))
    })
  } finally {
    if (origDebug === undefined) delete process.env.RIVET_DEBUG
    else process.env.RIVET_DEBUG = origDebug
  }
})

test('runImageTool：全部失败但无 RIVET_DEBUG 时保持静默', async () => {
  const origDebug = process.env.RIVET_DEBUG
  delete process.env.RIVET_DEBUG
  try {
    await withTempDir(async (dir) => {
      const out = join(dir, 'out.png')
      const lines = await captureConsoleError(async () => {
        const result = await runImageTool([fakeCmd('process.exit(1)', out)], out)
        assert.equal(result, null)
      })
      assert.equal(lines.length, 0)
    })
  } finally {
    if (origDebug !== undefined) process.env.RIVET_DEBUG = origDebug
  }
})

test('resizeCandidates：macOS sips 缩放时显式输出 PNG', () => {
  assert.deepEqual(resizeCandidates('/tmp/in.jpg', '/tmp/out.png', 1568, 'darwin')[0], {
    bin: 'sips',
    args: ['-Z', '1568', '-s', 'format', 'png', '/tmp/in.jpg', '--out', '/tmp/out.png'],
  })
})
