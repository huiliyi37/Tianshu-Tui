import { splitShellSegments } from './permissions.js'

/**
 * Self-preservation guard.
 *
 * The agent runs inside a Node process (the TUI process, or the desktop
 * "sidecar"). A bash command that terminates that process — or its ancestors —
 * kills the agent mid-turn: the session aborts and, after the shell respawns the
 * sidecar, its API auth context can be lost, producing a cascade of 401s. This
 * guard hard-blocks the narrow class of commands that would hit the agent's OWN
 * process tree, while leaving targeted kills of unrelated processes (e.g.
 * restarting a dev server on port 3001) to the normal approval flow.
 *
 * Field report (2026-07-05): the agent ran
 *   `taskkill //F //IM node.exe 2>/dev/null; sleep 1; echo killed`
 * to "restart the local server", killed its own sidecar, and every subsequent
 * message failed with 401. This guard exists to make that impossible regardless
 * of user config or approval mode.
 */

export interface SelfProcessTree {
  /** This Node process's PID. */
  selfPid: number
  /** Best-effort ancestor PIDs (at least the immediate parent). */
  ancestorPids: readonly number[]
}

/** Resolve the current process's self + ancestor PIDs. Best-effort: at minimum
 *  the own PID and the immediate parent (`process.ppid`). */
export function getSelfProcessTree(): SelfProcessTree {
  const selfPid = process.pid
  const ancestorPids: number[] = []
  const ppid = (process as { ppid?: number }).ppid
  if (typeof ppid === 'number' && ppid > 0) ancestorPids.push(ppid)
  return { selfPid, ancestorPids }
}

let cachedTree: SelfProcessTree | null = null
/** Cached self process tree — PIDs are stable for the process lifetime. */
export function selfProcessTree(): SelfProcessTree {
  if (!cachedTree) cachedTree = getSelfProcessTree()
  return cachedTree
}

/** Commands that terminate Node processes by image name — these always hit the
 *  agent's own runtime (the sidecar/TUI is a Node process). */
const NODE_IMAGE_KILL_PATTERNS: ReadonlyArray<RegExp> = [
  /\btaskkill\b[\s\S]*?\/{1,2}im\s+["']?node(?:\.exe)?/i, // taskkill /IM node.exe (and //IM)
  /\bpkill\b[\s\S]*\bnode\b/i,                            // pkill node / pkill -f node
  /\bkillall\b[\s\S]*\bnode\b/i,                          // killall node
  /\bwmic\b[\s\S]*\bnode(?:\.exe)?\b[\s\S]*\b(?:delete|terminate)\b/i, // wmic ... node.exe ... delete
]

/** Does this single segment kill a PID that belongs to the agent's own tree? */
function killsOwnPidInSegment(segment: string, pids: ReadonlySet<number>): boolean {
  const trimmed = segment.trimStart()

  // Windows: taskkill /PID <n> (also //PID under MSYS/Git-Bash).
  if (/\btaskkill\b/i.test(trimmed)) {
    const pidRe = /\/{1,2}pid\s+["']?(\d+)/gi
    let m: RegExpExecArray | null
    while ((m = pidRe.exec(trimmed)) !== null) {
      if (pids.has(Number(m[1]))) return true
    }
  }

  // Unix: bare `kill [-SIG] <pid> …`. pkill/killall are image-based (handled
  // above), so only match when the leading token is exactly `kill`.
  const tokens = trimmed.split(/\s+/)
  if (tokens[0] === 'kill') {
    for (const tok of tokens.slice(1)) {
      if (tok.startsWith('-')) continue // signal flag, not a PID
      const n = Number(tok)
      if (Number.isInteger(n) && n > 0 && pids.has(n)) return true
    }
  }

  return false
}

/** True when the command would terminate the agent's own process tree. Splits
 *  compound commands so a kill hidden inside `foo; taskkill //IM node.exe` or a
 *  subshell is still caught. Targeted kills of unrelated PIDs and
 *  `npx kill-port <port>` are intentionally NOT matched. */
export function isSelfDestructiveKill(
  command: string,
  tree: SelfProcessTree = selfProcessTree(),
): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  const pids = new Set<number>([tree.selfPid, ...tree.ancestorPids])
  return splitShellSegments(command).some(seg =>
    NODE_IMAGE_KILL_PATTERNS.some(p => p.test(seg)) || killsOwnPidInSegment(seg, pids),
  )
}
