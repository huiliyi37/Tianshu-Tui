/**
 * TUI image attachment loader — turns an on-disk image path into a base64 data URL
 * suitable for the vision model pipeline.
 *
 * Terminals can only bracketed-paste text, so users paste an image file path; this
 * module reads the file, validates the format, and optionally downscales it so the
 * payload stays under the server cap.
 */

import { readFile, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { makeImageTempDir, removeImageTempDir, resizeCandidates, runImageTool } from './image-tool.js'

/** Provider cap: 10 MB decoded per image (matches common vision API limits). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Long-edge clamp. 1568px keeps token cost bounded while staying legible. */
export const MAX_EDGE = 1568
/** Max number of images per prompt (matches desktop Composer). */
export const MAX_IMAGES = 4

const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.bmp': 'image/bmp',
}

export interface ImageAttachment {
  /** data:image/...;base64,... */
  dataUrl: string
  mime: string
  name: string
}

export interface LoadImageOptions {
  maxBytes?: number
  maxEdge?: number
  /** PNG-producing resize hook; injectable so the oversized-image path is testable. */
  resizeImage?: (path: string, maxEdge: number) => Promise<Buffer | null>
}

/**
 * 仅按 magic bytes 识别 MIME；不识别即返回 null。
 * 不做扩展名 fallback——真实图片（png/jpeg/webp/gif/tiff/bmp）都有可靠 magic，
 * 任意内容改名 .png 不应进入转码流程。保留 filePath 参数仅为兼容既有调用签名。
 */
export function detectImageMime(buf: Buffer, _filePath: string): string | null {
  if (buf.length >= 8) {
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return 'image/png'
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      return 'image/jpeg'
    }
    // WebP: RIFF....WEBP
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return 'image/webp'
    }
    // GIF: GIF87a or GIF89a
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return 'image/gif'
    }
    // TIFF: II (little-endian) or MM (big-endian) at offset 0, magic 42 at offset 2-3
    if (
      (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
      (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)
    ) {
      return 'image/tiff'
    }
    // BMP: BM
    if (buf[0] === 0x42 && buf[1] === 0x4D) {
      return 'image/bmp'
    }
  }
  return null
}

/** Returns true if the file extension looks like a supported image. */
export function looksLikeImagePath(text: string): boolean {
  const ext = extname(text.trim()).toLowerCase()
  return ext in IMAGE_MIMES
}

async function trySystemResize(path: string, maxEdge: number): Promise<Buffer | null> {
  const dir = await makeImageTempDir()
  const outPath = join(dir, 'out.png')
  try {
    // runImageTool 一体化完成「执行 + 读回 + PNG 校验」，失败返回 null
    return await runImageTool(resizeCandidates(path, outPath, maxEdge), outPath)
  } finally {
    await removeImageTempDir(dir)
  }
}

async function compressImage(
  path: string,
  maxEdge: number,
  maxBytes: number,
  resizeImage: (path: string, maxEdge: number) => Promise<Buffer | null>,
): Promise<Buffer> {
  const resized = await resizeImage(path, maxEdge)
  if (resized && resized.length <= maxBytes) return resized

  throw new Error(
    `Image too large after resize. Install an image tool (sips on macOS, ImageMagick on Linux/Windows) to compress.`,
  )
}

/**
 * Load an image from disk and return it as a base64 data URL.
 *
 * - Validates format by magic bytes (no extension fallback).
 * - Rejects unsupported formats.
 * - If the decoded file exceeds maxBytes, attempts to resize to maxEdge using
 *   system tools (sips on macOS, ImageMagick elsewhere).
 */
export async function loadImageAttachment(
  absolutePath: string,
  options: LoadImageOptions = {},
): Promise<ImageAttachment> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const maxEdge = options.maxEdge ?? MAX_EDGE

  const raw = await readFile(absolutePath)
  let buf: Buffer = Buffer.from(raw) as Buffer
  let mime = detectImageMime(buf, absolutePath)
  if (!mime) {
    throw new Error(`Unsupported image format: ${absolutePath}`)
  }

  if (buf.length > maxBytes) {
    buf = await compressImage(absolutePath, maxEdge, maxBytes, options.resizeImage ?? trySystemResize)
    // Every resize candidate is required to produce a validated PNG.
    mime = 'image/png'
  }

  const b64 = buf.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    name: basename(absolutePath),
  }
}
