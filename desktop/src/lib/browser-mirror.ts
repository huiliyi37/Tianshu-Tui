// Browser mirror: derive a user-visible view of the agent's in-app browser
// activity purely from the reduced session blocks. No backend/reducer change —
// the Browser panel replays session history (since seq 0) on mount and mirrors
// what the agent's `browser_debug` tool did, so the user SEES the same page the
// agent sees (directly addressing the "模型看到、人看不到" pain).
//
// Source signals (all already in the SSE stream):
//   - tool block   role `tool · browser_debug`,  text `<action> <detail>`
//     (humanizeToolInput: open/navigate carry the target URL as detail)
//   - result block role `result · browser_debug`, text = the tool's own output
//     (`Navigated to <url> …`, `Captured screenshot of <url> → artifact <id>`)
//   - computer_use (CDP route) mirrors the same way:
//     tool `<action> <url|app>`, result `Navigated to "<title>" — <url>` /
//     `Accessibility tree for <app> (screenshot → artifact <id>)`

import type { ConvoBlock } from '../state/event-reducer'

const TOOL_ROLE = 'tool · browser_debug'
const RESULT_ROLE = 'result · browser_debug'
const CU_TOOL_ROLE = 'tool · computer_use'
const CU_RESULT_ROLE = 'result · computer_use'

// artifact id 后可能紧跟 `)`（computer_use 的 `(screenshot → artifact <id>)`）——
// 不能用 \S+ 吞掉右括号。
const ARTIFACT_RE = /→ artifact ([\w.:-]+)/
const NAVIGATED_RE = /Navigated to (\S+)/
const SCREENSHOT_OF_RE = /screenshot of (\S+)/i
/** computer_use CDP 导航结果：`Navigated to "<title>" — <url>` / `Went back to "…" — <url>` / `Reloaded "…" — <url>`。 */
const CU_NAVIGATED_RE = /(?:Navigated to|Went (?:back|forward) to|Reloaded) "[^"]*" — (\S+)/

/** Actions whose detail is a target URL worth tracking on the timeline. */
const NAV_ACTIONS = new Set(['open', 'navigate'])

export interface BrowserNav {
  /** browser_debug action (open / navigate). */
  action: string
  /** Target URL. */
  url: string
  /** Stable key for React lists (derived from the source block key). */
  key: string
}

export interface BrowserMirrorState {
  /** The agent's current page URL (best-effort: result "Navigated to" wins over intent). */
  currentUrl: string | null
  /** Artifact id of the most recent screenshot, for inline rendering. */
  latestScreenshotArtifactId: string | null
  /** Ordered navigation history. */
  timeline: BrowserNav[]
  /** Most recent non-screenshot textual result (snapshot / eval / console / network). */
  latestText: string | null
  /** Whether any browser_debug activity was observed at all. */
  active: boolean
}

export const EMPTY_BROWSER_STATE: BrowserMirrorState = {
  currentUrl: null,
  latestScreenshotArtifactId: null,
  timeline: [],
  latestText: null,
  active: false,
}

/** Strip trailing sentence punctuation a URL regex may over-capture. */
function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:)\]]+$/, '')
}

function isUrlish(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^localhost(:\d+)?/i.test(s) || /^127\.0\.0\.1(:\d+)?/i.test(s)
}

/** Ensure localhost/loopback URLs carry a scheme so downstream consumers (e.g.
 *  the "open in system browser" button) receive a valid http:// URL. */
function normalizeUrl(raw: string): string {
  const url = cleanUrl(raw)
  if (/^https?:\/\//i.test(url)) return url
  if (/^(localhost|127\.0\.0\.1)/i.test(url)) return `http://${url}`
  return url
}

/**
 * Fold the ordered block list into a browser mirror snapshot. Pure + total, so
 * it is trivially unit-testable and safe to call on every render.
 */
export function deriveBrowserState(blocks: ReadonlyArray<ConvoBlock>): BrowserMirrorState {
  let currentUrl: string | null = null
  let latestScreenshotArtifactId: string | null = null
  let latestText: string | null = null
  let active = false
  const timeline: BrowserNav[] = []

  for (const b of blocks) {
    if (b.kind === 'tool' && (b.role === TOOL_ROLE || b.role === CU_TOOL_ROLE)) {
      active = true
      const text = b.text.trim()
      const sp = text.indexOf(' ')
      const action = (sp === -1 ? text : text.slice(0, sp)).trim()
      const detail = sp === -1 ? '' : text.slice(sp + 1).trim()
      if (NAV_ACTIONS.has(action) && detail && isUrlish(detail)) {
        const url = normalizeUrl(detail)
        timeline.push({ action, url, key: b.key })
        currentUrl = url // intent; a following result may confirm/redirect
      }
      continue
    }

    if (b.kind === 'result' && (b.role === RESULT_ROLE || b.role === CU_RESULT_ROLE)) {
      active = true
      const text = b.text
      const shot = text.match(ARTIFACT_RE)
      if (shot) latestScreenshotArtifactId = shot[1]!
      const nav = text.match(CU_NAVIGATED_RE) ?? text.match(NAVIGATED_RE) ?? text.match(SCREENSHOT_OF_RE)
      if (nav) currentUrl = normalizeUrl(nav[1]!)
      // A textual extraction (snapshot/eval/console/network/status) — keep the
      // latest non-screenshot result so the panel can show what the agent read.
      // computer_use snapshot 结果同时含 artifact 和可访问性树文本——树文本也保留。
      if (text.trim() && (!shot || b.role === CU_RESULT_ROLE)) {
        if (!shot) latestText = text.trim()
        else if (/Accessibility tree/i.test(text)) latestText = text.trim()
      }
    }
  }

  return { currentUrl, latestScreenshotArtifactId, timeline, latestText, active }
}
