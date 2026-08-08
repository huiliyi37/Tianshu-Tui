/**
 * 终端内联图片渲染 — 把 data URL 图片准备/编码为 kitty / iTerm2 图形协议序列。
 *
 * 协议事实（与 detectImageProtocol 配套）：
 * - kitty APC：`\x1B_G<control>;<base64 payload>\x1B\\`，仅支持 RGB/RGBA/PNG 载荷
 *   （f=100 = PNG），非 PNG 需先转码。base64 必须按 ≤4096 字节分块，除末块外
 *   长度须为 4 的倍数，用 m=1/0 标记。q=2 抑制终端响应，避免污染 stdin 解析。
 *   同时给 c（列）和 r（行）时终端把图片缩放进该单元格矩形（保持宽高比），
 *   放置后光标下移 r 行、停在图片右缘列——几何有界、位置确定，这是 live 区
 *   锚点安全的前提；调用方随后输出 `\r` 回到行首。
 * - iTerm2 OSC 1337：`\x1B]1337;File=inline=1;width=N;height=M:<base64>\x07`，
 *   直接支持 png/jpeg/gif/webp，宽高以单元格计，preserveAspectRatio=1 下
 *   图片适配进宽高超框，绘制后光标停在图片末行右缘；调用方随后输出 `\r\n`
 *   把光标移到图片下方行首。
 * 两种序列都会被不支持的终端静默忽略，因此检测失误的最坏结果是图片不显示。
 *
 * 安全边界：data URL 载荷在编码前必须通过严格 base64 校验（RFC 4648 字母表 +
 * 合法 padding + 非空 + 长度 4 对齐），否则载荷里的 BEL/ESC/ST 可以提前终止
 * OSC/APC 序列并向终端注入任意控制序列。
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageProtocol } from './ansi.js'
import { makeImageTempDir, removeImageTempDir, runImageTool, toPngCandidates } from './image-tool.js'
import { MAX_IMAGE_BYTES } from './image-attach.js'

/** kitty 协议单块 base64 上限（协议规定 ≤4096 且除末块外须为 4 的倍数）。 */
const KITTY_CHUNK = 4096

/**
 * 估算字符 cell 高宽比（≈2，主流等宽字体）。
 * 只用于把 kitty 的 r 收紧到图片实际需要行数；估错只会留白或轻微缩放，
 * 不影响正确性（光标移动行数以我们给出的 r 为准，与图片内容无关）。
 */
const CELL_ASPECT = 2

/** 编码白名单：两种协议合计可直接/可转换展示的 MIME。 */
const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp'])

const MIME_EXTS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
}

/** RFC 4648 base64（标准字母表 + 合法 padding）。 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * 解析并校验 data URL → { mime, b64 }。
 * 拒绝：非 data URL、非白名单 MIME、空载荷、含控制字符/非法字符的载荷、
 * 非法 padding、长度非 4 对齐、解码后超过 MAX_IMAGE_BYTES。
 */
export function parseImageDataUrl(dataUrl: string): { mime: string; b64: string } | null {
  // MIME 大小写不敏感（RFC 2045），统一转小写后过白名单；字符集不含空格/分号，
  // 因此 `data:image/png;charset=...;base64,` 这类带参数的形式整体不匹配、直接拒绝——
  // 只接受裸 `;base64,` 形式，不做参数解析。
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl)
  if (!m || m[1] === undefined || m[2] === undefined) return null
  const mime = m[1].toLowerCase()
  if (!SUPPORTED_MIMES.has(mime)) return null
  const b64 = m[2]
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return null
  // base64 解码大小 = 3/4 长度减尾部 padding（BASE64_RE 已限定 0/1/2 个 '='）；
  // 精确计算而非高估，否则解码后恰为上限的合法图片会被误拒。超限直接拒，避免分配大 Buffer
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  if ((b64.length * 3) / 4 - padding > MAX_IMAGE_BYTES) return null
  return { mime, b64 }
}

/** 已备图片：编码所需的全部材料。kitty 路径保证是 PNG 且带像素尺寸。 */
export interface PreparedTermImage {
  b64: string
  pixelWidth?: number
  pixelHeight?: number
}

/** 从 PNG base64 解出 IHDR 宽高（解码前 33 字节即可）；非法 PNG 返回 null。 */
function pngDimensions(pngB64: string): { width: number; height: number } | null {
  const head = Buffer.from(pngB64.slice(0, 44), 'base64')
  if (head.length < 24 || head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return null
  const width = head.readUInt32BE(16)
  const height = head.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * 非 PNG 转码为 PNG base64（kitty 协议只接受 PNG 容器）。
 * 走共享图像工具执行器的平台感知候选（见 toPngCandidates），每次转换独立
 * 临时目录；全部失败返回 null，调用方降级为文本占位。
 */
async function ensurePngBase64(mime: string, b64: string): Promise<string | null> {
  if (mime === 'image/png') return b64
  const dir = await makeImageTempDir()
  const inPath = join(dir, `in${MIME_EXTS[mime] ?? '.img'}`)
  const outPath = join(dir, 'out.png')
  try {
    await writeFile(inPath, Buffer.from(b64, 'base64'))
    // runImageTool 返回校验过的 PNG 内容；全部候选失败返回 null
    const png = await runImageTool(toPngCandidates(inPath, outPath), outPath)
    if (!png) return null
    return png.toString('base64')
  } finally {
    await removeImageTempDir(dir)
  }
}

/**
 * data URL → 已备图片（慢速部分：校验 + 必要的 PNG 转码）。
 * 在 commit 前异步完成；编码（快速、与终端尺寸相关）留到写入时进行，
 * 使转码期间的终端 resize 不会用过期宽度编码。
 * 返回 null 表示无法准备，调用方保持文本占位。
 */
export async function prepareTermImage(
  dataUrl: string,
  protocol: Exclude<ImageProtocol, 'none'>,
): Promise<PreparedTermImage | null> {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) return null
  // iTerm2 accepts the common web image containers directly. TIFF/BMP are
  // retained for the vision payload but converted before terminal rendering.
  if (protocol === 'iterm2' && (parsed.mime === 'image/png' || parsed.mime === 'image/jpeg' || parsed.mime === 'image/gif' || parsed.mime === 'image/webp')) {
    return { b64: parsed.b64 }
  }
  const png = await ensurePngBase64(parsed.mime, parsed.b64)
  if (!png) return null
  const dims = pngDimensions(png)
  return { b64: png, pixelWidth: dims?.width, pixelHeight: dims?.height }
}

/** iTerm2 OSC 1337 内联图片序列。宽高以单元格计，图片按比例适配进超框。 */
export function encodeIterm2Image(b64: string, cols: number, maxRows: number): string {
  return `\x1B]1337;File=inline=1;width=${cols};height=${maxRows};preserveAspectRatio=1:${b64}\x07`
}

/** kitty APC 图形序列（f=100 PNG，分块直传，c×r 有界单元格矩形）。 */
export function encodeKittyImage(b64Png: string, cols: number, rows: number): string {
  const chunks: string[] = []
  for (let i = 0; i < b64Png.length; i += KITTY_CHUNK) {
    chunks.push(b64Png.slice(i, i + KITTY_CHUNK))
  }
  if (chunks.length === 0) return ''
  return chunks
    .map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0
      const control = i === 0 ? `a=T,f=100,q=2,c=${cols},r=${rows},m=${more}` : `q=2,m=${more}`
      return `\x1B_G${control};${chunk}\x1B\\`
    })
    .join('')
}

/**
 * 已备图片 → 终端图形序列。cols/maxRows 应在写入当刻取最新终端尺寸。
 * kitty 用像素尺寸把 r 收紧到实际需要行数（受 maxRows 封顶），
 * 拿不到尺寸时退回 maxRows（宁可留白，几何必须有界）。
 * 序列末尾不含换行，由调用方控制光标。
 */
export function encodeTermImage(
  image: PreparedTermImage,
  protocol: Exclude<ImageProtocol, 'none'>,
  cols: number,
  maxRows: number,
): string | null {
  const width = Math.max(10, cols)
  const rowCap = Math.max(1, maxRows)
  if (protocol === 'iterm2') return encodeIterm2Image(image.b64, width, rowCap)
  let rows = rowCap
  if (image.pixelWidth && image.pixelHeight) {
    rows = Math.min(rowCap, Math.max(1, Math.ceil((image.pixelHeight / image.pixelWidth) * (width / CELL_ASPECT))))
  }
  return encodeKittyImage(image.b64, width, rows)
}

// ── 测试注入 seam ─────────────────────────────────────────────

let prepareOverride: typeof prepareTermImage | null = null

/** 测试钩子：替换 prepare 实现（null 恢复真实实现）。 */
export function setTermImagePreparer(fn: typeof prepareTermImage | null): void {
  prepareOverride = fn
}

/** app 层统一入口：走注入点后的 prepare。 */
export async function prepareTermImageForCommit(
  dataUrl: string,
  protocol: Exclude<ImageProtocol, 'none'>,
): Promise<PreparedTermImage | null> {
  return (prepareOverride ?? prepareTermImage)(dataUrl, protocol)
}
