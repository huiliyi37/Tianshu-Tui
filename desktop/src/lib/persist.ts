// Reconnect-on-reload: remember which session the user was looking at so a app
// reload (or sidecar restart) lands back where they were. The event stream
// rebuilds full history from since=0, so only the active id needs persisting.

const KEY_ACTIVE = 'tianshu.activeSessionId'
const KEY_PROJECT = 'tianshu.activeProject'
const KEY_SEEN = 'tianshu.attentionSeen'
const KEY_AUTONOMY = 'tianshu.defaultAutonomy'
const KEY_TOOL_DENSITY = 'tianshu.toolDensity'

// ── Tool density ──

export type ToolDensity = 'compact' | 'balanced' | 'detailed'

export function loadToolDensity(): ToolDensity {
  try {
    const v = localStorage.getItem(KEY_TOOL_DENSITY)
    if (v === 'compact' || v === 'balanced' || v === 'detailed') return v
  } catch {
    // private mode / disabled storage — non-fatal
  }
  return 'balanced'
}

export function saveToolDensity(d: ToolDensity): void {
  try {
    localStorage.setItem(KEY_TOOL_DENSITY, d)
  } catch {
    // non-fatal
  }
}

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(KEY_ACTIVE)
  } catch {
    return null
  }
}

export function saveActiveSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY_ACTIVE, id)
    else localStorage.removeItem(KEY_ACTIVE)
  } catch {
    // private mode / disabled storage — non-fatal
  }
}

export function loadActiveProject(): string | null {
  try {
    return localStorage.getItem(KEY_PROJECT)
  } catch {
    return null
  }
}

export function saveActiveProject(cwd: string | null): void {
  try {
    if (cwd) localStorage.setItem(KEY_PROJECT, cwd)
    else localStorage.removeItem(KEY_PROJECT)
  } catch {
    // non-fatal
  }
}

export function loadAttentionSeen(): string[] {
  try {
    const v = localStorage.getItem(KEY_SEEN)
    if (v) {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // non-fatal
  }
  return []
}

export function saveAttentionSeen(sigs: string[]): void {
  try {
    // Cap to avoid unbounded growth as signatures churn.
    localStorage.setItem(KEY_SEEN, JSON.stringify(sigs.slice(-500)))
  } catch {
    // non-fatal
  }
}

// S — default autonomy level for new sessions (one of AutonomyLevel). Stored as
// a raw string; callers validate/coerce. Absent → 'default'.
export function loadDefaultAutonomy(): string | null {
  try {
    return localStorage.getItem(KEY_AUTONOMY)
  } catch {
    return null
  }
}

export function saveDefaultAutonomy(level: string): void {
  try {
    localStorage.setItem(KEY_AUTONOMY, level)
  } catch {
    // non-fatal
  }
}
