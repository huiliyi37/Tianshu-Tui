/**
 * Cross-platform line-ending policy for the file-editing tools.
 *
 * The model always emits content with LF (`\n`). Writing that verbatim breaks
 * Windows-specific consumers — cmd.exe mis-parses LF-only `.bat`/`.cmd` files
 * (labels/goto/multi-line blocks fail), and round-tripping a CRLF file through
 * edit_file/hash_edit (which splice LF text onto CRLF lines) corrupts it into a
 * mixed-EOL file. These helpers centralize the decision so write_file/edit_file/
 * hash_edit all behave the same.
 *
 * Policy (see `chooseEol`):
 *   1. Extension that REQUIRES a fixed EOL wins on every platform (.bat/.cmd → CRLF).
 *   2. Otherwise preserve the existing file's dominant EOL (overwrite/edit).
 *   3. New file with no requirement → LF (cross-platform safe; doesn't inject
 *      CRLF into otherwise-LF repos).
 *
 * The LF branch is byte-identical to the previous "write LF verbatim" behavior,
 * so existing LF files and tests are unaffected.
 */
import { extname } from 'node:path'
import { open } from 'node:fs/promises'

export type Eol = 'crlf' | 'lf'

/**
 * Extensions whose interpreter requires a specific EOL regardless of host OS.
 * `.bat`/`.cmd` must be CRLF even when authored on macOS/Linux for a Windows
 * target — this is the concrete bug being fixed here.
 */
const REQUIRED_EOL: Record<string, Eol> = {
  '.bat': 'crlf',
  '.cmd': 'crlf',
}

/** Count CRLF vs bare-LF newlines and return the dominant style (null if none). */
export function detectEol(text: string): Eol | null {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      if (i > 0 && text.charCodeAt(i - 1) === 13 /* \r */) crlf++
      else lf++
    }
  }
  if (crlf === 0 && lf === 0) return null
  return crlf > lf ? 'crlf' : 'lf'
}

/** Collapse any mix of CRLF/CR/LF down to LF. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Convert text (any EOL mix) to the target EOL. `applyEol(x, 'lf')` === `toLf(x)`. */
export function applyEol(text: string, eol: Eol): string {
  const lf = toLf(text)
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

/** The EOL an extension mandates, if any (e.g. `.bat` → `'crlf'`). */
export function requiredEol(filePath: string): Eol | null {
  return REQUIRED_EOL[extname(filePath).toLowerCase()] ?? null
}

/**
 * Resolve the EOL to write with, given the file's existing dominant EOL
 * (null for a new/empty file). Priority: extension requirement > existing >
 * `defaultEol` (the target-platform default for new files; LF when unset).
 */
export function chooseEol(filePath: string, existingEol: Eol | null, defaultEol: Eol = 'lf'): Eol {
  return requiredEol(filePath) ?? existingEol ?? defaultEol
}

/**
 * Pure policy helper for full-content writers (write_file): pick the EOL from
 * the requirement / existing content / default, then apply it to LF content.
 */
export function normalizeForWrite(filePath: string, content: string, existing?: string | null): string {
  const existingEol = existing != null ? detectEol(existing) : null
  return applyEol(content, chooseEol(filePath, existingEol))
}

/**
 * Detect a file's EOL by sampling its head (bounded read — avoids slurping a
 * large file just to look at its newlines). Returns null if unreadable/empty.
 */
export async function detectFileEol(filePath: string, sampleBytes = 65536): Promise<Eol | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(filePath, 'r')
    const buf = Buffer.alloc(sampleBytes)
    const { bytesRead } = await fh.read(buf, 0, sampleBytes, 0)
    return detectEol(buf.toString('utf-8', 0, bytesRead))
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}
