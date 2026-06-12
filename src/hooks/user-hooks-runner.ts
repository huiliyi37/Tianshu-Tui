/**
 * User hooks — .rivet/hooks.json event→script mapping.
 *
 * Runs external shell scripts on agent lifecycle events. Scripts receive
 * event context via environment variables and stdin JSON.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export type HookEvent =
  | 'preTurn'
  | 'postTurn'
  | 'postTool'
  | 'postSession'
  | 'onError'

export interface HookEntry {
  event: HookEvent
  /** Script path relative to project root or absolute. */
  script: string
  /** Optional timeout in ms. Default 5000. */
  timeoutMs?: number
}

export interface HooksConfig {
  hooks: HookEntry[]
}

export interface HookContext {
  event: HookEvent
  cwd: string
  sessionId?: string
  turn?: number
  toolName?: string
  toolResult?: string
  error?: string
}

const VALID_EVENTS = new Set<HookEvent>(['preTurn', 'postTurn', 'postTool', 'postSession', 'onError'])

export function loadHooksConfig(cwd: string): HooksConfig {
  const path = join(cwd, '.rivet', 'hooks.json')
  if (!existsSync(path)) return { hooks: [] }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: HookEntry[] }
    const hooks = (parsed.hooks ?? []).filter(h => VALID_EVENTS.has(h.event) && typeof h.script === 'string')
    return { hooks }
  } catch {
    return { hooks: [] }
  }
}

export function runHooksForEvent(cwd: string, ctx: HookContext): Array<{ script: string; ok: boolean; output: string }> {
  const config = loadHooksConfig(cwd)
  const results: Array<{ script: string; ok: boolean; output: string }> = []

  for (const entry of config.hooks.filter(h => h.event === ctx.event)) {
    const scriptPath = entry.script.startsWith('/')
      ? entry.script
      : join(cwd, entry.script)

    if (!existsSync(scriptPath)) {
      results.push({ script: entry.script, ok: false, output: `Script not found: ${scriptPath}` })
      continue
    }

    const timeoutMs = entry.timeoutMs ?? 5000
    const env = {
      ...process.env,
      RIVET_HOOK_EVENT: ctx.event,
      RIVET_SESSION_ID: ctx.sessionId ?? '',
      RIVET_TURN: String(ctx.turn ?? ''),
      RIVET_TOOL_NAME: ctx.toolName ?? '',
    }

    try {
      const result = spawnSync(scriptPath, [], {
        cwd,
        env,
        input: JSON.stringify(ctx),
        encoding: 'utf-8',
        timeout: timeoutMs,
        shell: true,
      })
      const output = (result.stdout ?? '') + (result.stderr ?? '')
      results.push({ script: entry.script, ok: result.status === 0, output: output.trim() })
    } catch (e) {
      results.push({
        script: entry.script,
        ok: false,
        output: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return results
}
