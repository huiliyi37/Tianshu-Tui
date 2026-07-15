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
    '⚠️  系统提示词已变更：旧会话的前缀缓存将在下一轮失效并触发完整重建。\n' +
    '   建议：升级后请新建会话，不要在旧会话里继续长对话，以避免高额 cache creation 费用。\n' +
    '   Static prompt changed; start a new session to avoid cache rebuild costs.\n' +
    '\n'
  )

  writeStoredHash(currentHash)
}
