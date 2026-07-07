// Reconnect-on-reload: remember which session the user was looking at so a app
// reload (or sidecar restart) lands back where they were. The event stream
// rebuilds full history from since=0, so only the active id needs persisting.

const KEY_ACTIVE = 'tianshu.activeSessionId'
const KEY_PROJECT = 'tianshu.activeProject'
const KEY_SEEN = 'tianshu.attentionSeen'
const KEY_AUTONOMY = 'tianshu.defaultAutonomy'
const KEY_TOOL_DENSITY = 'tianshu.toolDensity'
const KEY_SIDEBAR = 'tianshu.sidebarVisible'
const KEY_REVIEW = 'tianshu.reviewVisible.v2'
const KEY_TERMINAL = 'tianshu.terminalVisible'
const KEY_JOBS_DOCK = 'tianshu.jobsDockVisible'
const KEY_TABS = 'tianshu.openTabs'
const KEY_SPLIT_MODE = 'tianshu.splitMode'
const KEY_NOTIF_PREF = 'tianshu.notifPref'
const KEY_VIEW_MODE = 'tianshu.viewMode'
const KEY_SEND_MODE = 'tianshu.sendMode'
const KEY_DRAFTS = 'tianshu.composerDrafts'

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

// ── Notification preference ──

export type NotifPref = 'never' | 'background' | 'always'

export function loadNotifPref(): NotifPref {
  try {
    const v = localStorage.getItem(KEY_NOTIF_PREF)
    if (v === 'never' || v === 'background' || v === 'always') return v
  } catch { /* non-fatal */ }
  return 'background'
}

export function saveNotifPref(pref: NotifPref): void {
  try { localStorage.setItem(KEY_NOTIF_PREF, pref) } catch { /* non-fatal */ }
}

// ── Thread view mode (P1-2, Claude Desktop transcript view) ──
// normal: timeline groups collapsed (current default)
// verbose: timeline groups expanded
// summary: assistant/user text only — tools and thinking hidden

export type ViewMode = 'normal' | 'verbose' | 'summary'

export function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(KEY_VIEW_MODE)
    if (v === 'normal' || v === 'verbose' || v === 'summary') return v
  } catch { /* non-fatal */ }
  return 'normal'
}

export function saveViewMode(mode: ViewMode): void {
  try { localStorage.setItem(KEY_VIEW_MODE, mode) } catch { /* non-fatal */ }
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

// ── Send mode: Enter to send vs Shift+Enter to send ──

export type SendMode = 'enter' | 'shift-enter'
/** 'enter' (default): Enter sends, Shift+Enter inserts newline.
 *  'shift-enter': Shift+Enter sends, Enter inserts newline (QQ/WeChat style). */
export function loadSendMode(): SendMode {
  try {
    const v = localStorage.getItem(KEY_SEND_MODE)
    if (v === 'enter' || v === 'shift-enter') return v
  } catch { /* non-fatal */ }
  return 'enter'
}

export function saveSendMode(mode: SendMode): void {
  try { localStorage.setItem(KEY_SEND_MODE, mode) } catch { /* non-fatal */ }
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

export function loadJobsDockVisible(): boolean { return loadBool(KEY_JOBS_DOCK, true) }
export function saveJobsDockVisible(v: boolean): void { saveBool(KEY_JOBS_DOCK, v) }

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

// ── Composer drafts (per session) ──
// Empty drafts are dropped on save so the map cannot grow without bound.

export function loadComposerDrafts(): Record<string, string> {
  try {
    const v = localStorage.getItem(KEY_DRAFTS)
    if (v) {
      const parsed = JSON.parse(v) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {}
        for (const [k, val] of Object.entries(parsed)) {
          if (typeof val === 'string' && val) out[k] = val
        }
        return out
      }
    }
  } catch { /* non-fatal */ }
  return {}
}

export function saveComposerDrafts(drafts: Record<string, string>): void {
  try {
    const compact: Record<string, string> = {}
    for (const [k, v] of Object.entries(drafts)) {
      if (v) compact[k] = v
    }
    localStorage.setItem(KEY_DRAFTS, JSON.stringify(compact))
  } catch { /* non-fatal */ }
}
