// Project model. Codex / Antigravity organise work by Project (one or more
// folders). The runtime still carries a single `cwd` per session, so projects
// remain DERIVED on the client: distinct session cwds ∪ folders the user has
// explicitly opened (localStorage). This keeps the runtime untouched while
// letting an empty project exist before its first thread — and now lets a
// project bind MULTIPLE repos (frontend + backend), matching Antigravity's
// multi-folder project workflow.
//
// Backwards compatible: the legacy `string[]` localStorage shape is migrated
// to the new StoredProject[] format on first load.

/** A project bound to one or more repo roots. `roots[0]` is the primary cwd
 *  passed to the runtime; additional roots are bound repos shown by the project
 *  sidebar (and, once the backend multi-repo coordinator lands, dispatched to
 *  per-repo workers). */
export interface Project {
  /** Stable project identifier (slug of the primary root). Replaces cwd as the
   *  dedup/group key now that a project can span multiple roots. */
  id: string
  roots: string[]
  name: string
  threadCount: number
  lastActivity: number
}

const KEY = 'tianshu.knownProjects'

/** Persisted shape (localStorage). Older installs stored bare `string[]`. */
export interface StoredProject {
  id: string
  roots: string[]
  name: string
}

function shortHash(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36).slice(0, 6)
}

/** Derive a stable id from a root path (slug + short hash). */
export function projectId(root: string): string {
  const b = basename(root) || root
  const normalized = root.replace(/[/\\]+$/, '')
  const slug = `${b}-${shortHash(normalized)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'project'
}

/** Migrate legacy `string[]` → StoredProject[] and write back. */
function migrateLegacy(raw: unknown): StoredProject[] {
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    const migrated = (raw as string[])
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((cwd) => ({ id: projectId(cwd), roots: [cwd], name: basename(cwd) || cwd }))
    try { localStorage.setItem(KEY, JSON.stringify(migrated)) } catch { /* non-fatal */ }
    return migrated
  }
  return []
}

export function loadKnownProjects(): StoredProject[] {
  try {
    const v = localStorage.getItem(KEY)
    if (!v) return []
    const parsed = JSON.parse(v)
    if (Array.isArray(parsed) && (parsed.length === 0 || typeof parsed[0] === 'string')) {
      return migrateLegacy(parsed)
    }
    if (Array.isArray(parsed)) {
      const list = parsed.filter(
        (x): x is StoredProject => x && typeof x === 'object' && typeof x.id === 'string' && Array.isArray(x.roots),
      )
      // Re-derive ids so stored projects pick up new projectId() hashing logic
      // (fixes cross-disk basename collisions) and merge any duplicates.
      const map = new Map<string, StoredProject>()
      let changed = false
      for (const p of list) {
        const nextId = projectId(p.roots[0] ?? '')
        if (nextId !== p.id) changed = true
        const existing = map.get(nextId)
        if (existing) {
          existing.roots = [...new Set([...existing.roots, ...p.roots])]
          changed = true
        } else {
          map.set(nextId, { ...p, id: nextId })
        }
      }
      const next = [...map.values()]
      if (changed) {
        try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* non-fatal */ }
      }
      return next
    }
  } catch {
    // disabled storage / corrupt
  }
  return []
}

export function saveKnownProjects(list: StoredProject[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* non-fatal */ }
}

export function addKnownProject(cwd: string): StoredProject[] {
  if (!cwd) return loadKnownProjects()
  const list = loadKnownProjects()
  const id = projectId(cwd)
  if (list.some((p) => p.id === id)) return list
  const next = [{ id, roots: [cwd], name: basename(cwd) || cwd }, ...list]
  saveKnownProjects(next)
  return next
}

/** Add a known project with multiple roots. */
export function addKnownMultiRootProject(roots: string[], name?: string): StoredProject[] {
  const primary = roots[0]
  if (!primary) return loadKnownProjects()
  const list = loadKnownProjects()
  const id = projectId(primary)
  const filtered = roots.filter(Boolean)
  const next = [{ id, roots: filtered, name: name ?? basename(primary) }, ...list.filter((p) => p.id !== id)]
  saveKnownProjects(next)
  return next
}

export function removeKnownProject(id: string): StoredProject[] {
  const next = loadKnownProjects().filter((p) => p.id !== id)
  saveKnownProjects(next)
  return next
}

/** Rename a known project. If it only exists as a derived project, create a
 *  known entry with the custom name so the rename survives reloads. */
export function renameKnownProject(id: string, name: string, roots: string[]): StoredProject[] {
  const list = loadKnownProjects()
  const idx = list.findIndex((p) => p.id === id)
  const nextName = name.trim()
  if (idx >= 0) {
    list[idx] = { ...list[idx]!, name: nextName }
    saveKnownProjects(list)
    return list
  }
  const next = [{ id, roots: roots.slice(), name: nextName }, ...list]
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

/** Fold sessions + known folders into a deduped, sorted Project list. Group key
 *  is project id (slug of primary root), so a multi-root project stays a single
 *  entry even if sessions land in different roots. A session whose cwd matches
 *  any root of a known multi-root project is folded into that project. */
export function deriveProjects(sessions: SessionLike[], known: StoredProject[]): Project[] {
  const map = new Map<string, Project>()
  // cwd → project id index, so a session landing in any root of a known project
  // resolves to that project (not a new one keyed by the leaf dir).
  const cwdToProjectId = new Map<string, string>()
  for (const k of known) {
    for (const root of k.roots) cwdToProjectId.set(root, k.id)
    map.set(k.id, {
      id: k.id, roots: k.roots.slice(), name: k.name || basename(k.roots[0] ?? ''),
      threadCount: 0, lastActivity: 0,
    })
  }
  const ensure = (cwd: string): Project => {
    // a known multi-root project may list this cwd as a root → use its id
    const knownId = cwdToProjectId.get(cwd)
    const id = knownId ?? projectId(cwd)
    let p = map.get(id)
    if (!p) {
      p = { id, roots: [cwd], name: basename(cwd) || cwd, threadCount: 0, lastActivity: 0 }
      map.set(id, p)
    }
    return p
  }
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
