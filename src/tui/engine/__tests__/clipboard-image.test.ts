/**
 * clipboard-image.ts RED tests.
 *
 * Wave 1 — 先写失败用例形成契约，再写实现（GREEN）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

// ── RED #1: 模块尚不存在，import 会失败（测试框架报错 = RED） ──
// 此 import 在 clipboard-image.ts 创建前会抛 MODULE_NOT_FOUND。
// 创建模块后：至少导出 readImageFromClipboard, tryNativeClipboard, tryShellClipboard,
// ClipboardImage, ClipboardReader。

// 1x1 transparent PNG (valid)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

// We'll import after the module exists. For now this file documents the contract.

test('RED #1: readImageFromClipboard returns ClipboardImage when native reader succeeds', async () => {
  // 契约：传入 mock reader 返回固定 dataUrl → 函数应返回该 ClipboardImage
  // 此测试在模块不存在时必定失败（import error = RED）。
  // 模块创建后：通过 setClipboardReader 注入 mock → 验证返回结构。
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      return {
        dataUrl: PNG_DATA_URL,
        mime: 'image/png',
        name: 'clipboard.png',
        source: 'png' as const,
      }
    },
  })

  const result = await readImageFromClipboard()
  assert.ok(result, 'expected non-null result when reader returns image')
  assert.equal(result!.dataUrl, PNG_DATA_URL)
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.name, 'clipboard.png')
  assert.equal(result!.source, 'png')

  // 清理
  setClipboardReader(null)
})

test('RED #2: readImageFromClipboard returns null when clipboard has no image → caller must fallback to text', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      return null // 剪贴板里是文本，没有图片
    },
  })

  const result = await readImageFromClipboard()
  assert.equal(result, null)

  setClipboardReader(null)
})

test('RED #3: readImageFromClipboard returns null when reader throws → no crash, caller falls back to text', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      throw new Error('osascript missing')
    },
  })

  // 不应 throw；应静默返回 null（调用方走文本 fallback）
  const result = await readImageFromClipboard()
  assert.equal(result, null)

  setClipboardReader(null)
})

test('injected clipboard reader isolates the plain-text fallback from the host clipboard', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readTextFromClipboard } = mod

  setClipboardReader({
    async readImage() { return null },
    async readText() { return 'injected text' },
  })

  assert.equal(await readTextFromClipboard(), 'injected text')
  setClipboardReader(null)
})

test('RED #4: tryShellClipboard returns null when no shell tools available', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  // 覆盖 shell 命令路径使其全部失败 → 应返回 null
  const result = await tryShellClipboard({
    execFile: async (_bin: string, _args: string[]) => {
      throw new Error('command not found')
    },
    platform: 'linux',
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.equal(result, null)
})

test('RED #5: tryShellClipboard on macOS returns image when osascript succeeds', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  const execFile = async (bin: string, args: string[]) => {
    const arg0 = args[0] ?? ''
    const arg1 = args[1] ?? ''
    if (bin === 'osascript' && arg0 === '-e' && arg1.includes('clipboard info')) {
      // 模拟 osascript 返回 class PNG 信息
      return { stdout: '«class PNG»' }
    }
    if (bin === 'osascript' && arg0 === '-e' && arg1.includes('write')) {
      // 模拟写入临时文件——实际由 readFile 读回
      return { stdout: '' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }

  const readFile = async (_p: string) => pngBuf

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.ok(result, 'expected non-null on macOS with osascript')
  assert.ok(result!.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.source, 'png')
})
