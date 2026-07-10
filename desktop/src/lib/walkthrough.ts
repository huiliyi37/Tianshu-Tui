// 付费版 v1 · T1 — 走查工件（walkthrough-recorder hook 输出）的解析与类型。
// 与 src/agent/hooks/walkthrough-recorder.ts 的 WalkthroughDocument 保持字段对齐。

export interface WalkthroughStep {
  index: number
  turn: number
  ts: number
  action: string
  app: string
  detail?: string
  success: boolean
  screenshotArtifactId?: string
  uiDiff?: string
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
    halted: boolean
  }
  steps: WalkthroughStep[]
  markdown: string
}

/** Parse the raw walkthrough artifact; null on malformed/incompatible input. */
export function parseWalkthrough(raw: string): WalkthroughDocument | null {
  try {
    const doc = JSON.parse(raw) as WalkthroughDocument
    if (doc?.version !== 1 || !Array.isArray(doc.steps) || typeof doc.summary !== 'object' || doc.summary === null) {
      return null
    }
    return doc
  } catch {
    return null
  }
}

/** 步骤评论回炉（T3）：组装带步骤锚点的续跑消息。anchor 由调用方 i18n 提供。 */
export function buildStepComment(anchor: string, comment: string): string {
  return `${anchor}\n${comment.trim()}`
}
