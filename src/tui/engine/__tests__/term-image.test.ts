/**
 * 终端内联图片协议检测与编码测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectImageProtocol, setImageProtocol, imageProtocol } from '../ansi.js'
import {
  parseImageDataUrl,
  encodeIterm2Image,
  encodeKittyImage,
  encodeTermImage,
  prepareTermImage,
} from '../term-image.js'
import { runImageTool, toPngCandidates, resizeCandidates } from '../image-tool.js'
import { MAX_IMAGE_BYTES } from '../image-attach.js'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { TERM: 'xterm-256color', TERM_PROGRAM: undefined, TMUX: undefined }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  return base
}

// ── 检测（isTTY 显式注入，不依赖测试进程 stdout）─────────────────

test('RIVET_IMAGES 环境开关优先', () => {
  assert.equal(detectImageProtocol(env({ RIVET_IMAGES: '0', TERM_PROGRAM: 'iTerm.app' }), true), 'none')
  assert.equal(detectImageProtocol(env({ RIVET_IMAGES: 'off', TERM: 'xterm-kitty' }), true), 'none')
  assert.equal(detectImageProtocol(env({ RIVET_IMAGES: 'kitty', TERM: 'dumb' }), false), 'kitty')
  assert.equal(detectImageProtocol(env({ RIVET_IMAGES: 'iterm2', TERM: 'dumb' }), false), 'iterm2')
})

test('dumb / 非 TTY / tmux 降级为 none', () => {
  assert.equal(detectImageProtocol(env({ TERM: 'dumb', TERM_PROGRAM: 'iTerm.app' }), true), 'none')
  assert.equal(detectImageProtocol(env({ TERM_PROGRAM: 'iTerm.app' }), false), 'none')
  assert.equal(detectImageProtocol(env({ TMUX: '/tmp/tmux-1000/default,1,0', TERM_PROGRAM: 'iTerm.app' }), true), 'none')
  assert.equal(detectImageProtocol(env({ TERM: 'screen-256color', TERM_PROGRAM: 'iTerm.app' }), true), 'none')
})

test('终端识别矩阵', () => {
  assert.equal(detectImageProtocol(env({ TERM_PROGRAM: 'iTerm.app' }), true), 'iterm2')
  assert.equal(detectImageProtocol(env({ TERM: 'xterm-kitty' }), true), 'kitty')
  assert.equal(detectImageProtocol(env({ TERM_PROGRAM: 'ghostty' }), true), 'kitty')
  assert.equal(detectImageProtocol(env({ TERM_PROGRAM: 'WezTerm' }), true), 'kitty')
  assert.equal(detectImageProtocol(env({ TERM_PROGRAM: 'WarpTerminal' }), true), 'kitty')
  assert.equal(detectImageProtocol(env({ KONSOLE_VERSION: '2308000' }), true), 'kitty')
  assert.equal(detectImageProtocol(env({ TERM_PROGRAM: 'vscode' }), true), 'none')
  assert.equal(detectImageProtocol(env({}), true), 'none')
})

test('setImageProtocol 覆盖自动检测', () => {
  setImageProtocol('kitty')
  assert.equal(imageProtocol(), 'kitty')
  setImageProtocol(null)
  assert.ok(['kitty', 'iterm2', 'none'].includes(imageProtocol()))
})

// ── data URL 严格校验（控制字符注入面）─────────────────────────

test('parseImageDataUrl 合法输入', () => {
  assert.deepEqual(parseImageDataUrl(`data:image/png;base64,${PNG_1X1}`), { mime: 'image/png', b64: PNG_1X1 })
  assert.deepEqual(parseImageDataUrl('data:image/JPEG;base64,/9j/4AA='), { mime: 'image/jpeg', b64: '/9j/4AA=' })
})

test('parseImageDataUrl 拒绝控制字符与畸形载荷', () => {
  // BEL 可提前终止 OSC；ESC\ 可提前终止 APC —— 都必须拒绝
  assert.equal(parseImageDataUrl('data:image/png;base64,QUJD\x07'), null)
  assert.equal(parseImageDataUrl('data:image/png;base64,QUJD\x1B\\'), null)
  assert.equal(parseImageDataUrl('data:image/png;base64,QUJD\n'), null)
  // 空载荷 / 非法 padding / 长度非 4 对齐
  assert.equal(parseImageDataUrl('data:image/png;base64,'), null)
  assert.equal(parseImageDataUrl('data:image/png;base64,QU=J'), null)
  assert.equal(parseImageDataUrl('data:image/png;base64,QUJD='), null)
  assert.equal(parseImageDataUrl('data:image/png;base64,QUJ'), null)
  // 非图片 / 非附件支持 MIME / 非 base64 段
  assert.equal(parseImageDataUrl('data:text/plain;base64,QUJD'), null)
  assert.deepEqual(parseImageDataUrl('data:image/tiff;base64,QUJD'), { mime: 'image/tiff', b64: 'QUJD' })
  assert.deepEqual(parseImageDataUrl('data:image/bmp;base64,QUJD'), { mime: 'image/bmp', b64: 'QUJD' })
  assert.equal(parseImageDataUrl('data:image/png,QUJD'), null)
  assert.equal(parseImageDataUrl('not-a-data-url'), null)
})

test('parseImageDataUrl 拒绝超限载荷（按 base64 长度预估，不分配 Buffer）', () => {
  const tooBig = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
  assert.equal(parseImageDataUrl(`data:image/png;base64,${tooBig}`), null)
})

/** 构造 n 个 base64 分组 + p 个 padding 的载荷，解码后恰为 3n - p 字节。 */
function b64WithGroups(groups: number, padding: 0 | 1 | 2): string {
  return 'A'.repeat(groups * 4 - padding) + '='.repeat(padding)
}

test('parseImageDataUrl 体积上限按精确解码长度判定（扣 padding）', () => {
  // 解码长度 = 3n - p，随 n 步进 3。对每种 padding 取不超上限的最大 n 必须放行，
  // n+1 必须拒绝——覆盖「解码后恰好等于上限」的边界（10MiB 时由 padding=2 命中）。
  for (const padding of [0, 1, 2] as const) {
    const maxGroups = Math.floor((MAX_IMAGE_BYTES + padding) / 3)
    assert.ok(3 * maxGroups - padding <= MAX_IMAGE_BYTES)
    assert.ok(3 * (maxGroups + 1) - padding > MAX_IMAGE_BYTES)
    assert.notEqual(parseImageDataUrl(`data:image/png;base64,${b64WithGroups(maxGroups, padding)}`), null)
    assert.equal(parseImageDataUrl(`data:image/png;base64,${b64WithGroups(maxGroups + 1, padding)}`), null)
  }
  // 具体边界值：上限-1 / 恰好上限 / 超上限 1 字节（各自对应可达的 padding）
  const atMinusOne = b64WithGroups((MAX_IMAGE_BYTES - 1) / 3, 0)
  const atExact = b64WithGroups((MAX_IMAGE_BYTES + 2) / 3, 2)
  const atPlusOne = b64WithGroups((MAX_IMAGE_BYTES + 1 + 1) / 3, 1)
  assert.notEqual(parseImageDataUrl(`data:image/png;base64,${atMinusOne}`), null)
  assert.notEqual(parseImageDataUrl(`data:image/png;base64,${atExact}`), null)
  assert.equal(parseImageDataUrl(`data:image/png;base64,${atPlusOne}`), null)
})

test('parseImageDataUrl 接受大写 MIME（data URL 惯例大小写不敏感）', () => {
  assert.deepEqual(parseImageDataUrl(`data:IMAGE/PNG;base64,${PNG_1X1}`), { mime: 'image/png', b64: PNG_1X1 })
  assert.deepEqual(parseImageDataUrl('data:image/PNG;base64,/9j/4AA='), { mime: 'image/png', b64: '/9j/4AA=' })
})

test('parseImageDataUrl 拒绝带参数或含空格的 MIME', () => {
  // 只接受裸 `;base64,` 形式：charset 等参数不匹配正则，整体拒绝而非解析参数
  assert.equal(parseImageDataUrl('data:image/png;charset=utf-8;base64,QUJD'), null)
  // MIME 含空格不在正则字符集内
  assert.equal(parseImageDataUrl('data:image/ png;base64,QUJD'), null)
  assert.equal(parseImageDataUrl('data: image/png;base64,QUJD'), null)
})

// ── 编码器 ─────────────────────────────────────────────────────

test('encodeIterm2Image 输出 OSC 1337 序列（宽高超框 + 保比例）', () => {
  const seq = encodeIterm2Image('QUJD', 40, 12)
  assert.ok(seq.startsWith('\x1B]1337;File=inline=1;width=40;height=12;preserveAspectRatio=1:'))
  assert.ok(seq.endsWith('QUJD\x07'))
})

test('encodeKittyImage 小块单帧输出（c×r 有界矩形）', () => {
  const seq = encodeKittyImage('QUJD', 40, 10)
  assert.equal(seq, '\x1B_Ga=T,f=100,q=2,c=40,r=10,m=0;QUJD\x1B\\')
})

test('encodeKittyImage 大块分块且非末块为 4 的倍数', () => {
  const b64 = 'A'.repeat(4096 * 2 + 100)
  const seq = encodeKittyImage(b64, 40, 10)
  const frames = seq.split('\x1B\\').filter(Boolean)
  assert.equal(frames.length, 3)
  assert.ok(frames[0]!.startsWith('\x1B_Ga=T,f=100,q=2,c=40,r=10,m=1;'))
  assert.ok(frames[1]!.startsWith('\x1B_Gq=2,m=1;'))
  assert.ok(frames[2]!.startsWith('\x1B_Gq=2,m=0;'))
  for (const frame of frames.slice(0, -1)) {
    const payload = frame.slice(frame.indexOf(';') + 1)
    assert.equal(payload.length % 4, 0)
    assert.ok(payload.length <= 4096)
  }
  // 重组后载荷完整
  const reassembled = frames.map(f => f.slice(f.indexOf(';') + 1)).join('')
  assert.equal(reassembled, b64)
})

test('encodeKittyImage 空载荷返回空串', () => {
  assert.equal(encodeKittyImage('', 40, 10), '')
})

// ── encodeTermImage 行高几何 ───────────────────────────────────

test('encodeTermImage kitty 按像素宽高比收紧 r 并封顶', () => {
  // 1000×500 px，宽 40 列 → 行数 ≈ 0.5 * 40/2 = 10
  const seq = encodeTermImage({ b64: 'QUJD', pixelWidth: 1000, pixelHeight: 500 }, 'kitty', 40, 18)
  assert.ok(seq !== null && seq.includes('c=40,r=10,'))
  // 超高图：100×5000 px → 需要 1000 行，被 maxRows=18 封顶
  const tall = encodeTermImage({ b64: 'QUJD', pixelWidth: 100, pixelHeight: 5000 }, 'kitty', 40, 18)
  assert.ok(tall !== null && tall.includes('c=40,r=18,'))
  // 无尺寸信息 → 退回 maxRows（几何有界）
  const unknown = encodeTermImage({ b64: 'QUJD' }, 'kitty', 40, 18)
  assert.ok(unknown !== null && unknown.includes('c=40,r=18,'))
})

test('encodeTermImage iterm2 直出（宽高超框）', () => {
  const seq = encodeTermImage({ b64: 'QUJD' }, 'iterm2', 40, 18)
  assert.ok(seq !== null && seq.includes('width=40') && seq.includes('height=18'))
})

// ── prepareTermImage ───────────────────────────────────────────

test('prepareTermImage：iterm2 直通，非法 data URL 返回 null', async () => {
  const prepared = await prepareTermImage(`data:image/png;base64,${PNG_1X1}`, 'iterm2')
  assert.deepEqual(prepared, { b64: PNG_1X1 })
  assert.equal(await prepareTermImage('garbage', 'iterm2'), null)
  assert.equal(await prepareTermImage('data:text/plain;base64,QUJD', 'iterm2'), null)
  assert.equal(await prepareTermImage('data:image/png;base64,QUJD\x07', 'iterm2'), null)
})

test('prepareTermImage：kitty 对 PNG 直通并解析 IHDR 尺寸', async () => {
  const prepared = await prepareTermImage(`data:image/png;base64,${PNG_1X1}`, 'kitty')
  assert.ok(prepared !== null)
  assert.equal(prepared.pixelWidth, 1)
  assert.equal(prepared.pixelHeight, 1)
  assert.equal(prepared.b64, PNG_1X1)
})

// ── runImageTool fallback 语义（候选级隔离：执行+读回+PNG 校验一体化）───────────────

/** 用 node -e 构造假命令，不依赖 sips/ImageMagick 真实存在。 */
function fakeCmd(script: string, ...extraArgs: string[]): { bin: string; args: string[] } {
  return { bin: process.execPath, args: ['-e', script, ...extraArgs] }
}

/** 写出真实 PNG 字节的假命令脚本（runner 校验 magic，字符串残片过不了）。 */
function writePngScript(): string {
  return `require('node:fs').writeFileSync(process.argv[1], Buffer.from('${PNG_1X1}','base64'))`
}

const PNG_BUF = Buffer.from(PNG_1X1, 'base64')

test('runImageTool：全部失败返回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  try {
    const out = join(dir, 'out.png')
    const result = await runImageTool([
      fakeCmd('process.exit(1)'),
      fakeCmd('process.exit(1)', out),
    ], out)
    assert.equal(result, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runImageTool：exit 0 但未产出文件时继续 fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  try {
    const out = join(dir, 'out.png')
    // 第一个候选 exit 0 但不写文件 → 应跳过；第二个产出有效 PNG → 成功
    const result = await runImageTool([
      fakeCmd('process.exit(0)', out),
      fakeCmd(writePngScript(), out),
    ], out)
    assert.deepEqual(result, PNG_BUF)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runImageTool：exit 0 但产出空文件时继续 fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  try {
    const out = join(dir, 'out.png')
    const result = await runImageTool([
      fakeCmd("require('node:fs').writeFileSync(process.argv[1], '')", out),
      fakeCmd(writePngScript(), out),
    ], out)
    assert.deepEqual(result, PNG_BUF)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runImageTool：候选级隔离——A 留非空残片 + B 空退时不误判，fallback 到 C', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  try {
    const out = join(dir, 'out.png')
    // A：exit 1 但留下非空残片；B：exit 0 但没写文件——若 B 读到 A 的残片会被
    // 误判成功。每个候选执行前删除 outputPath 后，B 读回失败，继续到 C。
    const result = await runImageTool([
      fakeCmd("require('node:fs').writeFileSync(process.argv[1], 'residue'); process.exit(1)", out),
      fakeCmd('process.exit(0)', out),
      fakeCmd(writePngScript(), out),
    ], out)
    assert.deepEqual(result, PNG_BUF)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runImageTool：exit 0 但输出非 PNG 判失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  try {
    const out = join(dir, 'out.png')
    const result = await runImageTool([
      fakeCmd("require('node:fs').writeFileSync(process.argv[1], 'not-a-png-at-all')", out),
    ], out)
    assert.equal(result, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runImageTool：首个候选成功即短路（不执行后续候选）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-imgtool-test-'))
  try {
    const out = join(dir, 'out.png')
    // 第二个候选是不存在的二进制——若被执行会抛错，短路则不会触碰
    const result = await runImageTool([
      fakeCmd(writePngScript(), out),
      { bin: '/nonexistent/rivet-imgtool-should-not-run', args: [out] },
    ], out)
    assert.deepEqual(result, PNG_BUF)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 候选命令构造的平台分支（只测构造，不测执行）─────────────────────

function bins(commands: { bin: string }[]): string[] {
  return commands.map(c => c.bin)
}

test('toPngCandidates：win32 不含 sips/convert，以 magick → powershell 兜底', () => {
  const cmds = toPngCandidates('C:\\tmp\\in.jpg', 'C:\\tmp\\out.png', 'win32')
  assert.deepEqual(bins(cmds), ['magick', 'powershell'])
  const ps = cmds[1]!
  assert.deepEqual(ps.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  const script = ps.args[3]!
  assert.ok(script.includes('System.Drawing'))
  assert.ok(script.includes("[System.Drawing.Imaging.ImageFormat]::Png"))
  assert.ok(script.includes("'C:\\tmp\\in.jpg'") && script.includes("'C:\\tmp\\out.png'"))
  // 健壮性：non-terminating error 转为终止性 + try/finally 保证释放
  assert.ok(script.includes("$ErrorActionPreference='Stop'"))
  assert.ok(script.includes('try {') && script.includes('finally {'))
})

test('toPngCandidates：darwin 为 sips → magick → convert，无 powershell', () => {
  const cmds = toPngCandidates('/tmp/in.jpg', '/tmp/out.png', 'darwin')
  assert.deepEqual(bins(cmds), ['sips', 'magick', 'convert'])
})

test('resizeCandidates：win32 不含 sips/convert，PowerShell 脚本按 maxEdge 等比缩放', () => {
  const cmds = resizeCandidates('C:\\tmp\\in.jpg', 'C:\\tmp\\out.png', 1568, 'win32')
  assert.deepEqual(bins(cmds), ['magick', 'powershell'])
  const script = cmds[1]!.args[3]!
  assert.ok(script.includes('[Math]::Min(1.0,1568/[Math]::Max($img.Width,$img.Height))'))
  assert.ok(script.includes('.Dispose()'))
  // 健壮性：non-terminating error 转为终止性 + try/finally 空值检查逆序释放
  assert.ok(script.includes("$ErrorActionPreference='Stop'"))
  assert.ok(script.includes('try {') && script.includes('finally {'))
  const finallyPart = script.slice(script.indexOf('finally'))
  assert.ok(finallyPart.includes('if ($g)') && finallyPart.includes('if ($bmp)') && finallyPart.includes('if ($img)'))
  assert.ok(finallyPart.indexOf('$g.Dispose()') < finallyPart.indexOf('$bmp.Dispose()'))
  assert.ok(finallyPart.indexOf('$bmp.Dispose()') < finallyPart.indexOf('$img.Dispose()'))
})

test('resizeCandidates：darwin 为 sips → magick → convert，无 powershell', () => {
  const cmds = resizeCandidates('/tmp/in.jpg', '/tmp/out.png', 1568, 'darwin')
  assert.deepEqual(bins(cmds), ['sips', 'magick', 'convert'])
  assert.ok(cmds[0]!.args.includes('-Z') && cmds[0]!.args.includes('1568'))
})

test('候选构造：路径中的单引号在 PowerShell 脚本里翻倍转义', () => {
  const cmds = toPngCandidates("C:\\tmp\\it's.jpg", 'C:\\tmp\\out.png', 'win32')
  const script = cmds[1]!.args[3]!
  assert.ok(script.includes("'C:\\tmp\\it''s.jpg'"))
})
