/**
 * TUI image attachment loader — turns an on-disk image path into a base64 data URL
 * suitable for the vision model pipeline.
 *
 * Terminals can only bracketed-paste text, so users paste an image file path; this
 * module reads the file, validates the format, and optionally downscales it so the
 * payload stays under the server cap.
 */

import { readFile, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

/** Server cap: 1.5 MB decoded per image (matches session-routes.ts). */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024
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
}

/** Detect MIME type from magic bytes; falls back to file extension. */
export function detectImageMime(buf: Buffer, filePath: string): string | null {
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
  }
  const ext = extname(filePath).toLowerCase()
  return IMAGE_MIMES[ext] ?? null
}

/** Returns true if the file extension looks like a supported image. */
export function looksLikeImagePath(text: string): boolean {
  const ext = extname(text.trim()).toLowerCase()
  return ext in IMAGE_MIMES
}

async function trySystemResize(path: string, maxEdge: number): Promise<Buffer | null> {
  const outPath = `${tmpdir()}/rivet-img-${randomUUID()}.png`
  const commands: { bin: string; args: string[] }[] = [
    // macOS built-in
    { bin: 'sips', args: ['-Z', String(maxEdge), path, '--out', outPath] },
    // ImageMagick v7
    { bin: 'magick', args: [path, '-resize', `${maxEdge}x${maxEdge}>`, outPath] },
    // ImageMagick v6
    { bin: 'convert', args: [path, '-resize', `${maxEdge}x${maxEdge}>`, outPath] },
  ]
  for (const { bin, args } of commands) {
    try {
      await execFileAsync(bin, args, { timeout: 15000 })
      const resized = await readFile(outPath)
      await unlink(outPath).catch(() => { /* best-effort cleanup */ })
      return Buffer.from(resized)
    } catch {
      // try next command
    }
  }
  return null
}

async function compressImage(path: string, maxEdge: number, maxBytes: number): Promise<Buffer> {
  const resized = await trySystemResize(path, maxEdge)
  if (resized && resized.length <= maxBytes) return resized

  throw new Error(
    `Image too large after resize. Install an image tool (sips on macOS, ImageMagick on Linux/Windows) to compress.`,
  )
}

/**
 * Load an image from disk and return it as a base64 data URL.
 *
 * - Validates format by magic bytes + extension.
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
  const mime = detectImageMime(buf, absolutePath)
  if (!mime) {
    throw new Error(`Unsupported image format: ${absolutePath}`)
  }

  if (buf.length > maxBytes) {
    buf = (await compressImage(absolutePath, maxEdge, maxBytes)) as Buffer
  }

  const b64 = buf.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    name: basename(absolutePath),
  }
}
