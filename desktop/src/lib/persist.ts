// Reconnect-on-reload: remember which session the user was looking at so a app
// reload (or sidecar restart) lands back where they were. The event stream
// rebuilds full history from since=0, so only the active id needs persisting.

const KEY_ACTIVE = 'tianshu.activeSessionId'
const KEY_PROJECT = 'tianshu.activeProject'
const KEY_SEEN = 'tianshu.attentionSeen'
const KEY_AUTONOMY = 'tianshu.defaultAutonomy'
const KEY_TOOL_DENSITY = 'tianshu.toolDensity'
const KEY_SIDEBAR = 'tianshu.sidebarVisible'
const KEY_REVIEW = 'tianshu.reviewVisible'
const KEY_TERMINAL = 'tianshu.terminalVisible'
const KEY_TABS = 'tianshu.openTabs'
const KEY_SPLIT_MODE = 'tianshu.splitMode'

// ── Split mode (Phase 3 preview, persisted now) ──

export type SplitMode = 'none' | 'horizontal' | 'vertical'

export function loadSplitMode(): SplitMode {
  try {
    const v = localStorage.getItem(KEY_SPLIT_MODE)
    if (v === 'horizontal' || v === 'vertical') return v
  } catch { /* non-fatal */ }
  return 'none'
}

export function saveSplitMode(mode: SplitMode): void {
  try { localStorage.setItem(KEY_SPLIT_MODE, mode) } catch { /* non-fatal */ }
}

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

// ── Panel visibility ──

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === 'true') return true
    if (v === 'false') return false
  } catch { /* non-fatal */ }
  return fallback
}

function saveBool(key: string, v: boolean): void {
  try { localStorage.setItem(key, String(v)) } catch { /* non-fatal */ }
}

export function loadSidebarVisible(): boolean { return loadBool(KEY_SIDEBAR, true) }
export function saveSidebarVisible(v: boolean): void { saveBool(KEY_SIDEBAR, v) }

export function loadReviewVisible(): boolean { return loadBool(KEY_REVIEW, true) }
export function saveReviewVisible(v: boolean): void { saveBool(KEY_REVIEW, v) }

export function loadTerminalVisible(): boolean { return loadBool(KEY_TERMINAL, false) }
export function saveTerminalVisible(v: boolean): void { saveBool(KEY_TERMINAL, v) }

// ── Open tabs ──

export function loadOpenTabs(): string[] {
  try {
    const v = localStorage.getItem(KEY_TABS)
    if (v) {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string').slice(0, 10)
    }
  } catch { /* non-fatal */ }
  return []
}

export function saveOpenTabs(tabs: string[]): void {
  try {
    localStorage.setItem(KEY_TABS, JSON.stringify(tabs.slice(0, 10)))
  } catch { /* non-fatal */ }
}
