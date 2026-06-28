const SIDEBAR_W_KEY = 'rivet:sidebar-w'
const REVIEW_W_KEY = 'rivet:review-w'

export interface PanelLayout {
  sidebar: number
  review: number
}

const DEFAULTS: PanelLayout = { sidebar: 16, review: 26 }
const MIN_SIDEBAR = 12
const MAX_SIDEBAR = 35
const MIN_REVIEW = 15
const MAX_REVIEW = 45

/** Clamp a panel width to its valid range. */
export function clampSidebar(value: number): number {
  return Math.min(Math.max(value, MIN_SIDEBAR), MAX_SIDEBAR)
}

export function clampReview(value: number): number {
  return Math.min(Math.max(value, MIN_REVIEW), MAX_REVIEW)
}

/**
 * Read persisted panel sizes from localStorage, clamping to sane bounds.
 * Ensures the main panel always has at least 30% (matches WorkspaceSurface minSize).
 */
export function loadPanelLayout(): PanelLayout {
  let sidebar = DEFAULTS.sidebar
  let review = DEFAULTS.review
  try {
    sidebar = clampSidebar(parseInt(localStorage.getItem(SIDEBAR_W_KEY) ?? String(DEFAULTS.sidebar), 10))
    review = clampReview(parseInt(localStorage.getItem(REVIEW_W_KEY) ?? String(DEFAULTS.review), 10))
  } catch {
    // ignore corrupted storage
  }
  // Ensure combined width doesn't squeeze main below 30%.
  if (sidebar + review > 70) {
    const excess = sidebar + review - 70
    // Shrink review first (it has more max headroom), then sidebar.
    const shrinkReview = Math.min(excess, review - MIN_REVIEW)
    review -= shrinkReview
    sidebar -= excess - shrinkReview
    sidebar = clampSidebar(sidebar)
  }
  return { sidebar, review }
}

/** Persist a panel size to localStorage. */
export function saveSidebarWidth(value: number): void {
  try {
    localStorage.setItem(SIDEBAR_W_KEY, String(clampSidebar(value)))
  } catch {
    // ignore
  }
}

export function saveReviewWidth(value: number): void {
  try {
    localStorage.setItem(REVIEW_W_KEY, String(clampReview(value)))
  } catch {
    // ignore
  }
}

/** Reset panel sizes to defaults. */
export function resetPanelLayout(): PanelLayout {
  try {
    localStorage.removeItem(SIDEBAR_W_KEY)
    localStorage.removeItem(REVIEW_W_KEY)
  } catch {
    // ignore
  }
  return { ...DEFAULTS }
}

/**
 * Workspace 右侧面板（ReviewPanel）自适应规则。
 *
 * 参考 TUI side panel 策略：总宽度不足或右侧面板被挤压到太窄时自动折叠，
 * 避免主对话流与 side panel 争夺空间导致内容拥挤。
 */
export const REVIEW_AUTO_COLLAPSE_WIDTH = 1000
export const REVIEW_MIN_WIDTH_PX = 280

/**
 * 判断右侧面板是否应自动折叠。
 *
 * @param workspaceWidth 工作区总宽度（像素）
 * @param reviewWidthPx  右侧面板当前宽度（像素）
 */
export function shouldAutoCollapseReview(workspaceWidth: number, reviewWidthPx: number): boolean {
  return workspaceWidth < REVIEW_AUTO_COLLAPSE_WIDTH || reviewWidthPx < REVIEW_MIN_WIDTH_PX
}
