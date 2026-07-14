/**
 * Walkthrough Recorder — 运行走查工件（付费版 v1 · T1）
 *
 * postTool 阶段捕获每个 computer_use / browser_debug 调用（动作、目标 app 或
 * URL、截图 artifact id、反馈 diff 摘要、失败原因），累积成步骤时间线；
 * postSession 把时间线组装成结构化 walkthrough 工件（JSON，内嵌 markdown
 * 渲染稿）经 ArtifactStore 持久化——浏览器操作也有可回放走查（2026-07-15）。
 *
 * 记录器恒开（成本低），回放查看器在桌面端做 Pro gate。
 * 数据只来自已有的 tool 事件流——不额外截图、不重放 UI。
 */

import type { PostSessionRuntimeHook, PostToolRuntimeHook, RuntimeToolEvent } from '../runtime-hooks.js'

export interface WalkthroughStep {
  /** 1-based step number in capture order. */
  index: number
  /** Session turn the step happened on. */
  turn: number
  /** Unix ms. */
  ts: number
  /** Source tool. Optional for backward compat — absent means computer_use. */
  tool?: 'computer_use' | 'browser_debug'
  /** computer_use / browser_debug action, e.g. click / type / snapshot / navigate. */
  action: string
  /** Target application, or browser page URL for browser_debug ('' for app-less actions). */
  app: string
  /** Compact human-readable target detail (ref / query / text / keys …). */
  detail?: string
  success: boolean
  /** Screenshot artifact id when the action persisted one. */
  screenshotArtifactId?: string
  /** Post-action UI diff summary from the feedback loop. */
  uiDiff?: string
  /** First line of the error when the action failed (approval denial included). */
  errorNote?: string
}

export interface WalkthroughDocument {
  version: 1
  sessionId: string
  createdAt: number
  summary: {
    totalSteps: number
    failedSteps: number
    apps: string[]
    /** True when a step failed on an approval gate (unattended fail-closed halt). */
    halted: boolean
  }
  steps: WalkthroughStep[]
  /** Pre-rendered markdown for viewers without a dedicated renderer. */
  markdown: string
}

// computer_use 用 `(screenshot → artifact <id>)`；browser_debug 用
// `Captured screenshot of <url> → artifact <id>`（无括号）——统一按 id 字符集截取。
const SCREENSHOT_ARTIFACT_RE = /(?:screenshot[^\n]*)?→ artifact ([\w.:-]+)/
const UI_DIFF_RE = /^UI (changed|unchanged)[^\n]*(?:\n[+-] [^\n]*)*/m
const APPROVAL_DENY_RE = /requires (?:explicit user )?(?:an )?approval/i

/** Keys of computer_use input that make a useful one-line detail. */
const DETAIL_KEYS = ['ref', 'query', 'text', 'keys', 'direction', 'url', 'path', 'title', 'selector'] as const

function stepDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  const parts: string[] = []
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}=${rendered.length > 80 ? `${rendered.slice(0, 77)}…` : rendered}`)
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

const RECORDED_TOOLS = new Set(['computer_use', 'browser_debug'])

/** browser_debug 结果里的当前页 URL（`Navigated to <url>` / `screenshot of <url>`）。 */
const BROWSER_URL_RE = /(?:Navigated to|screenshot of) (\S+)/i

/**
 * Convert one postTool event into a walkthrough step. Returns null for
 * tools outside computer_use / browser_debug. Pure — fully unit-testable
 * without a live loop.
 */
export function extractWalkthroughStep(
  tool: RuntimeToolEvent,
  meta: { index: number; turn: number; ts: number },
): WalkthroughStep | null {
  if (!RECORDED_TOOLS.has(tool.name)) return null
  const input = tool.input ?? {}
  const action = typeof input.action === 'string' && input.action ? input.action : '?'
  const content = tool.resultContent ?? ''
  // computer_use 的目标是 app；browser_debug 的"位置"是页面 URL（input.url
  // 优先，其次从结果反推）。
  const app = typeof input.app === 'string' && input.app
    ? input.app
    : tool.name === 'browser_debug'
      ? (typeof input.url === 'string' ? input.url : BROWSER_URL_RE.exec(content)?.[1]?.replace(/[.,;)]+$/, '') ?? '')
      : ''

  const step: WalkthroughStep = {
    index: meta.index,
    turn: meta.turn,
    ts: meta.ts,
    tool: tool.name as 'computer_use' | 'browser_debug',
    action,
    app,
    success: tool.success,
  }

  const detail = stepDetail(tool.input)
  if (detail) step.detail = detail

  const shot = SCREENSHOT_ARTIFACT_RE.exec(content)
  if (shot?.[1]) step.screenshotArtifactId = shot[1]

  if (tool.success) {
    const diff = UI_DIFF_RE.exec(content)
    if (diff?.[0]) {
      const summary = diff[0]
      step.uiDiff = summary.length > 400 ? `${summary.slice(0, 397)}…` : summary
    }
  } else {
    const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
    step.errorNote = firstLine.length > 300 ? `${firstLine.slice(0, 297)}…` : firstLine
  }

  return step
}

/** Whether a failed step failed on the approval gate (fail-closed halt marker). */
export function isApprovalHaltStep(step: WalkthroughStep): boolean {
  return !step.success && !!step.errorNote && APPROVAL_DENY_RE.test(step.errorNote)
}

export function buildWalkthroughMarkdown(
  steps: readonly WalkthroughStep[],
  meta: { sessionId: string; createdAt: number },
): string {
  const failed = steps.filter((s) => !s.success)
  const halted = steps.some(isApprovalHaltStep)
  const apps = [...new Set(steps.map((s) => s.app).filter(Boolean))]

  const lines: string[] = [
    '# 运行走查 Run Walkthrough',
    '',
    `- 会话: ${meta.sessionId}`,
    `- 生成时间: ${new Date(meta.createdAt).toISOString()}`,
    `- 步骤: ${steps.length}（失败 ${failed.length}）`,
    `- 涉及应用: ${apps.length > 0 ? apps.join(', ') : '—'}`,
  ]
  if (halted) {
    lines.push('- ⚠️ 本次运行包含被审批门禁拦截的动作（fail-closed 中止）')
  }
  lines.push('', '## 步骤时间线', '')

  for (const step of steps) {
    const status = step.success ? '✓' : '✗'
    const head = `### ${step.index}. ${status} ${step.action}${step.app ? ` @ ${step.app}` : ''}`
    lines.push(head, '')
    lines.push(`- turn ${step.turn} · ${new Date(step.ts).toISOString()}`)
    if (step.detail) lines.push(`- 目标: ${step.detail}`)
    if (step.screenshotArtifactId) lines.push(`- 截图: artifact \`${step.screenshotArtifactId}\``)
    if (step.uiDiff) lines.push(`- UI 变化: ${step.uiDiff.split('\n')[0]}`)
    if (step.errorNote) lines.push(`- 失败: ${step.errorNote}`)
    lines.push('')
  }

  return lines.join('\n')
}

export function buildWalkthroughDocument(
  steps: readonly WalkthroughStep[],
  meta: { sessionId: string; createdAt: number },
): WalkthroughDocument {
  const failed = steps.filter((s) => !s.success)
  return {
    version: 1,
    sessionId: meta.sessionId,
    createdAt: meta.createdAt,
    summary: {
      totalSteps: steps.length,
      failedSteps: failed.length,
      apps: [...new Set(steps.map((s) => s.app).filter(Boolean))],
      halted: steps.some(isApprovalHaltStep),
    },
    steps: [...steps],
    markdown: buildWalkthroughMarkdown(steps, meta),
  }
}

/** Minimal ArtifactStore surface the recorder needs (keeps the dep injectable). */
export interface WalkthroughArtifactSink {
  save(input: {
    tool: string
    target: string
    rawContent: string
    summary: string
    sections: Array<{ name: string; lineStart: number; lineEnd: number; charCount: number }>
  }): Promise<string>
}

export interface WalkthroughRecorderDeps {
  getArtifactStore: () => WalkthroughArtifactSink | undefined
  sessionId?: string
  now?: () => number
}

/**
 * Create the recorder hook pair: postTool captures computer_use steps,
 * postSession persists the assembled walkthrough artifact (skips silently
 * when the run had no computer_use activity or the store is absent).
 */
export function createWalkthroughRecorderHooks(deps: WalkthroughRecorderDeps): [PostToolRuntimeHook, PostSessionRuntimeHook] {
  const now = deps.now ?? Date.now
  const steps: WalkthroughStep[] = []
  let persisted = false

  const postTool: PostToolRuntimeHook = {
    phase: 'postTool',
    name: 'walkthrough-recorder',
    run(ctx, tool) {
      const step = extractWalkthroughStep(tool, {
        index: steps.length + 1,
        turn: ctx.snapshot.turn,
        ts: now(),
      })
      if (step) steps.push(step)
    },
  }

  const postSession: PostSessionRuntimeHook = {
    phase: 'postSession',
    name: 'walkthrough-recorder-flush',
    async run() {
      if (persisted || steps.length === 0) return
      const store = deps.getArtifactStore()
      if (!store) return
      persisted = true
      const doc = buildWalkthroughDocument(steps, {
        sessionId: deps.sessionId ?? 'unknown',
        createdAt: now(),
      })
      const failNote = doc.summary.failedSteps > 0 ? `，失败 ${doc.summary.failedSteps}` : ''
      const haltNote = doc.summary.halted ? '，含审批门禁中止' : ''
      const kind = doc.steps.some(s => s.tool === 'browser_debug')
        ? (doc.steps.some(s => (s.tool ?? 'computer_use') === 'computer_use') ? '桌面+浏览器自动化' : '浏览器自动化')
        : '桌面自动化'
      await store.save({
        tool: 'walkthrough',
        target: 'run-walkthrough.json',
        rawContent: JSON.stringify(doc, null, 2),
        summary: `${kind}走查：${doc.summary.totalSteps} 步${failNote}${haltNote}（${doc.summary.apps.join(', ') || '无应用'}）`,
        sections: [],
      })
    },
  }

  return [postTool, postSession]
}
