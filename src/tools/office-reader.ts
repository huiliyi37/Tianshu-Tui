/**
 * Office document reader — converts .doc/.docx/.rtf/.odt to plain text
 * using platform-native tools (textutil on macOS, soffice on Linux).
 *
 * Strategy: prefer textutil (macOS built-in, fast, no dependency), fall
 * back to LibreOffice soffice on Linux. .docx also supports a pure-JS
 * fallback via mammoth if neither binary is available.
 */
import { execFile } from 'child_process'
import { access, readFile, unlink } from 'fs/promises'
import { extname, basename } from 'path'
import { tmpdir } from 'os'

export const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.rtf',
  '.odt',
])

export interface OfficeReadResult {
  /** Converted plain-text content (UTF-8). */
  text: string
  /** Backend used for the conversion. */
  engine: 'textutil' | 'soffice' | 'mammoth'
  /** Original file extension (for messaging). */
  sourceFormat: string
}

/**
 * Detect the best available conversion engine for the current platform.
 */
async function detectEngine(): Promise<'textutil' | 'soffice' | 'mammoth' | null> {
  // macOS built-in
  try {
    await access('/usr/bin/textutil')
    return 'textutil'
  } catch { /* not macOS or textutil not available */ }

  try {
    await access('/usr/bin/soffice')
    return 'soffice'
  } catch { /* no LibreOffice */ }

  try {
    await access('/usr/bin/libreoffice')
    return 'soffice'
  } catch { /* no LibreOffice */ }

  // mammoth requires the npm package; check lazily at call time
  return null
}

let cachedEngine: 'textutil' | 'soffice' | 'mammoth' | null | undefined

async function getEngine(): Promise<'textutil' | 'soffice' | 'mammoth'> {
  if (cachedEngine !== undefined) return cachedEngine!
  cachedEngine = await detectEngine()
  if (!cachedEngine) {
    // mammoth is pure JS — try importing it
    try {
      // @ts-expect-error — mammoth is optional, may not be installed
      await import('mammoth')
      cachedEngine = 'mammoth'
    } catch {
      throw new Error(
        'No Office document converter available. ' +
        'On macOS: textutil is built in. ' +
        'On Linux: install LibreOffice (sudo apt install libreoffice). ' +
        'Or install mammoth: npm install mammoth',
      )
    }
  }
  return cachedEngine
}

/**
 * Convert an Office file to plain text.
 * @param filePath Absolute path to the document.
 */
export async function readOfficeFile(filePath: string): Promise<OfficeReadResult> {
  const ext = extname(filePath).toLowerCase()
  const engine = await getEngine()

  if (engine === 'textutil') {
    return readWithTextutil(filePath, ext)
  }
  if (engine === 'soffice') {
    return readWithSoffice(filePath, ext)
  }
  return readWithMammoth(filePath, ext)
}

async function readWithTextutil(filePath: string, ext: string): Promise<OfficeReadResult> {
  const text = await execTextutil(filePath)
  return { text, engine: 'textutil', sourceFormat: ext }
}

async function readWithSoffice(filePath: string, ext: string): Promise<OfficeReadResult> {
  const text = await execSoffice(filePath)
  return { text, engine: 'soffice', sourceFormat: ext }
}

async function readWithMammoth(filePath: string, ext: string): Promise<OfficeReadResult> {
  if (ext !== '.docx') {
    throw new Error(
      `mammoth only supports .docx files (got ${ext}). ` +
      'Install LibreOffice for .doc/.rtf/.odt support: https://www.libreoffice.org/',
    )
  }
  const text = await execMammoth(filePath)
  return { text, engine: 'mammoth', sourceFormat: ext }
}

function execTextutil(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }, (err, stdout) => {
      if (err) reject(new Error(`textutil failed: ${err.message}`))
      else resolve(stdout)
    })
  })
}

function execSoffice(filePath: string): Promise<string> {
  const name = basename(filePath)
  const outName = name.replace(/\.[^.]+$/, '.txt')
  const outPath = `${tmpdir()}/${outName}`
  const binary = '/usr/bin/soffice'

  return new Promise((resolve, reject) => {
    execFile(binary, ['--headless', '--convert-to', 'txt', '--outdir', tmpdir(), filePath], {
      timeout: 60_000,
    }, async (err) => {
      if (err) {
        reject(new Error(`soffice failed: ${err.message}`))
        return
      }
      try {
        const text = await readFile(outPath, 'utf-8')
        await unlink(outPath).catch(() => {})
        resolve(text)
      } catch (e) {
        reject(new Error(`soffice output file not found: ${outPath}`))
      }
    })
  })
}

async function execMammoth(filePath: string): Promise<string> {
  // @ts-expect-error — mammoth is optional dependency
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value
}
