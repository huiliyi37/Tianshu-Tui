/**
 * Clipboard image reader — reads image data from the system clipboard.
 *
 * Tries native @mariozechner/clipboard first (optional dependency, silent fallback),
 * then falls back to platform-specific shell commands (osascript / xclip / wl-paste / PowerShell).
 *
 * Designed for testability: setClipboardReader() injects a mock for unit tests;
 * tryShellClipboard() accepts injectable execFile/platform/readFile for shell-path testing.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { detectImageMime } from './image-attach.js'

const execFileAsync = promisify(execFile)

/** 焦点防抖窗口 (ms)：编辑器从 overlay 切回后 1s 内的 Ctrl+V 跳过剪贴板读图 */
export const FOCUS_DEBOUNCE_MS = 1_000

// ── Public types ──

export interface ClipboardImage {
  /** data:image/...;base64,... */
  dataUrl: string
  mime: string
  name: string
  source: 'png' | 'jpeg' | 'image'
}

export interface ClipboardReader {
  readImage(): Promise<ClipboardImage | null>
}

export interface ShellClipboardOpts {
  execFile?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>
  platform?: NodeJS.Platform
  readFile?: (path: string) => Promise<Buffer>
  tmpdir?: string
  randomUUID?: () => string
}

// ── Reader injection (for testing) ──

let _reader: ClipboardReader | null = null

export function setClipboardReader(reader: ClipboardReader | null): void {
  _reader = reader
}

// ── Main entry ──

export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
  // Test injection path
  if (_reader) {
    try {
      return await _reader.readImage()
    } catch {
      return null
    }
  }

  // 1. Try native (@mariozechner/clipboard) — silent fallback on any failure
  const native = await tryNativeClipboard()
  if (native) return native

  // 2. Shell fallback chain
  return tryShellClipboard()
}

/**
 * Read plain text from system clipboard.
 * Used as fallback when Ctrl+V finds no image in clipboard.
 */
export async function readTextFromClipboard(): Promise<string | null> {
  const pf = process.platform
  try {
    if (pf === 'darwin') {
      const r = await execFileAsync('pbpaste', [], { timeout: 5_000, maxBuffer: 1024 * 1024 })
      return r.stdout
    }
    if (pf === 'linux') {
      // Try wl-paste first (Wayland), then xclip (X11)
      try {
        const r = await execFileAsync('wl-paste', [], { timeout: 5_000, maxBuffer: 1024 * 1024 })
        return r.stdout
      } catch {
        const r = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], { timeout: 5_000, maxBuffer: 1024 * 1024 })
        return r.stdout
      }
    }
    if (pf === 'win32') {
      const r = await execFileAsync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { timeout: 5_000, maxBuffer: 1024 * 1024 })
      return r.stdout
    }
  } catch {
    // No clipboard text tools available
  }
  return null
}

// ── Native path ──

async function tryNativeClipboard(): Promise<ClipboardImage | null> {
  try {
    // @ts-expect-error — optional dependency, may not be installed
    const clipboard = await import('@mariozechner/clipboard')
    if (typeof clipboard.readImage !== 'function') return null
    const buf: Buffer = await clipboard.readImage()
    if (!buf || buf.length === 0) return null
    return bufToClipboardImage(buf, 'clipboard.png')
  } catch {
    // Package not installed, native binding failed, or any other error — silent
    return null
  }
}

// ── Shell fallback (exported for testing) ──

export async function tryShellClipboard(opts?: ShellClipboardOpts): Promise<ClipboardImage | null> {
  const ef = opts?.execFile ?? (async (bin, args) => {
    const r = await execFileAsync(bin, args, { timeout: 15_000, maxBuffer: 50 * 1024 * 1024 })
    return { stdout: r.stdout, stderr: r.stderr }
  })
  const pf = opts?.platform ?? process.platform
  const rf = opts?.readFile ?? (async (p) => {
    const raw = await readFile(p)
    return Buffer.from(raw)
  })
  const td = opts?.tmpdir ?? tmpdir()
  const uuid = opts?.randomUUID ?? randomUUID

  try {
    if (pf === 'darwin') return await tryMacOSClipboard(ef, rf, td, uuid)
    if (pf === 'linux') return await tryLinuxClipboard(ef)
    if (pf === 'win32') return await tryWindowsClipboard(ef, rf, td, uuid)
  } catch {
    // All shell methods failed or no tools available
  }
  return null
}

// ── macOS: osascript ──

async function tryMacOSClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
  rf: (path: string) => Promise<Buffer>,
  td: string,
  uuid: () => string,
): Promise<ClipboardImage | null> {
  // 1. Check if clipboard contains an image
  let info: string
  try {
    const r = await ef('osascript', ['-e', 'clipboard info'])
    info = r.stdout
  } catch {
    return null
  }
  if (!info.includes('«class PNG»') && !info.includes('«class jp2') && !info.includes('TIFF picture') && !info.includes('GIF picture')) {
    return null
  }

  // 2. Determine the class to read
  let imageClass = '«class PNG»'
  if (info.includes('«class PNG»')) imageClass = '«class PNG»'
  else if (info.includes('TIFF picture')) imageClass = 'TIFF picture'
  else if (info.includes('GIF picture')) imageClass = 'GIF picture'

  // 3. Write clipboard image to temp file
  const tmpPath = `${td}/rivet-clip-${uuid()}.png`
  try {
    await ef('osascript', [
      '-e',
      `set theFile to (open for access POSIX file "${tmpPath}" with write permission)`,
      '-e',
      'set eof of theFile to 0',
      '-e',
      `write (the clipboard as ${imageClass}) to theFile`,
      '-e',
      'close access theFile',
    ])

    const buf = await rf(tmpPath)
    if (!buf || buf.length === 0) return null

    // TIFF → PNG 自动转换：macOS 剪贴板原生格式是 TIFF，
    // 截图工具粘贴时若无可选的 PNG 类会直接写 TIFF 数据。
    // 大多数视觉模型 API 不支持 TIFF，用 sips 转 PNG。
    const mime = detectImageMime(buf, 'clipboard.png')
    if (mime === 'image/tiff' || mime === 'image/bmp') {
      const pngBuf = await convertToPng(buf, tmpPath, ef, td, uuid)
      if (pngBuf) return bufToClipboardImage(pngBuf, 'clipboard.png')
    }
    return bufToClipboardImage(buf, 'clipboard.png')
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => { /* best-effort */ })
  }
}

// ── Linux: xclip / wl-paste ──

async function tryLinuxClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<ClipboardImage | null> {
  // Wayland first (more common on modern desktops)
  const commands: [string, string[]][] = [
    ['wl-paste', ['-t', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ]
  for (const [bin, args] of commands) {
    try {
      const r = await ef(bin, args)
      if (!r.stdout || r.stdout.length === 0) continue
      const buf = Buffer.from(r.stdout, 'latin1') // binary data comes through stdout
      if (buf.length === 0) continue
      return bufToClipboardImage(buf, 'clipboard.png')
    } catch {
      // Try next
    }
  }
  return null
}

// ── Windows: PowerShell ──

async function tryWindowsClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
  rf: (path: string) => Promise<Buffer>,
  td: string,
  uuid: () => string,
): Promise<ClipboardImage | null> {
  const tmpPath = `${td}\\rivet-clip-${uuid()}.png`
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save('${tmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' }
else { exit 1 }
`.trim()
    await ef('powershell', ['-NoProfile', '-Command', script])
    const buf = await rf(tmpPath)
    if (!buf || buf.length === 0) return null
    return bufToClipboardImage(buf, 'clipboard.png')
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => { /* best-effort */ })
  }
}

// ── Helpers ──

/** Convert TIFF/BMP buffer to PNG using macOS sips. Returns null on failure. */
async function convertToPng(
  buf: Buffer,
  srcPath: string,
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
  td: string,
  uuid: () => string,
): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null
  const pngPath = `${td}/rivet-clip-${uuid()}.png`
  try {
    await ef('sips', ['-s', 'format', 'png', srcPath, '--out', pngPath])
    const { readFile } = await import('node:fs/promises')
    const pngBuf = await readFile(pngPath)
    return pngBuf.length > 0 ? pngBuf : null
  } catch {
    return null
  } finally {
    const { unlink } = await import('node:fs/promises')
    await unlink(pngPath).catch(() => {})
  }
}

function bufToClipboardImage(buf: Buffer, name: string): ClipboardImage {
  const mime = detectImageMime(buf, name) ?? 'image/png'
  const b64 = buf.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    name,
    source: mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : 'image',
  }
}
