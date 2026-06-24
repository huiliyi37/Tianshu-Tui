// Project model (P1). Codex organises work by Project (a folder). The runtime has
// no project entity — a session only carries `cwd` — so projects are DERIVED:
// distinct session cwds ∪ folders the user has explicitly opened (localStorage).
// This keeps the runtime untouched while letting an empty project exist before
// its first thread.

export interface Project {
  cwd: string
  name: string
  threadCount: number
  lastActivity: number
}

const KEY = 'tianshu.knownProjects'

export function loadKnownProjects(): string[] {
  try {
    const v = localStorage.getItem(KEY)
    if (v) {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // disabled storage / corrupt — fall through
  }
  return []
}

export function saveKnownProjects(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // non-fatal
  }
}

export function addKnownProject(cwd: string): string[] {
  const list = loadKnownProjects()
  if (list.includes(cwd)) return list
  const next = [cwd, ...list]
  saveKnownProjects(next)
  return next
}

export function removeKnownProject(cwd: string): string[] {
  const next = loadKnownProjects().filter((c) => c !== cwd)
  saveKnownProjects(next)
  return next
}

/** Last path segment, tolerant of trailing slashes and both separators. */
export function basename(p: string): string {
  if (!p) return p
  const trimmed = p.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] || trimmed || p
}

export interface SessionLike {
  cwd: string
  updatedAt: number
}

/**
 * Fold sessions + known folders into a deduped, sorted Project list. Sorted by
 * most-recent activity, then name, so the active project floats to the top.
 */
export function deriveProjects(sessions: SessionLike[], known: string[]): Project[] {
  const map = new Map<string, Project>()
  const ensure = (cwd: string): Project => {
    let p = map.get(cwd)
    if (!p) {
      p = { cwd, name: basename(cwd) || cwd, threadCount: 0, lastActivity: 0 }
      map.set(cwd, p)
    }
    return p
  }
  for (const c of known) ensure(c)
  for (const s of sessions) {
    if (!s.cwd) continue
    const p = ensure(s.cwd)
    p.threadCount += 1
    p.lastActivity = Math.max(p.lastActivity, s.updatedAt)
  }
  return [...map.values()].sort(
    (a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name),
  )
}
