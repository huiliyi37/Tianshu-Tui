/**
 * Static prompt change warning.
 *
 * The static system prompt lives in the frozen prefix. Any byte change to it
 * invalidates the exact-prefix cache for existing sessions: the next request
 * pays full cache creation tokens instead of cheap cache reads.
 *
 * This helper prints a one-time warning per prompt change by storing a hash of
 * buildSystemPrompt() in ~/.rivet/.static-prompt-hash.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSystemPrompt } from '../prompt/static.js'
import { rivetHome } from '../config/paths.js'

const MARKER_FILE = '.static-prompt-hash'

function getPromptHash(): string {
  const prompt = buildSystemPrompt({ tools: [] })
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

function getMarkerPath(): string {
  return join(rivetHome(), MARKER_FILE)
}

function readStoredHash(): string | null {
  const path = getMarkerPath()
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function writeStoredHash(hash: string): void {
  const path = getMarkerPath()
  try {
    mkdirSync(rivetHome(), { recursive: true })
    writeFileSync(path, hash, 'utf8')
  } catch {
    // Best-effort persistence; warning still prints even if write fails.
  }
}

/**
 * Print a stderr warning when the static prompt has changed since the last
 * CLI run. Call once at interactive TUI startup, before the user resumes or
 * starts a session.
 */
export function maybePrintStaticPromptCacheWarning(): void {
  const currentHash = getPromptHash()
  const storedHash = readStoredHash()
  if (storedHash === currentHash) return

  process.stderr.write(
    '\n' +
    '⚠️  Static prompt changed since last run.\n' +
    '   Existing sessions will incur a full prefix-cache rebuild on the next turn\n' +
    '   (cache creation tokens are much more expensive than cache reads).\n' +
    '   Start a new session to avoid the extra cost.\n' +
    '\n'
  )

  writeStoredHash(currentHash)
}
