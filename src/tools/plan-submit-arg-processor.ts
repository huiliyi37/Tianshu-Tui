/**
 * plan_submit arg processor — replaces the full `plan` field in tool call
 * arguments with a file pointer, because plan_submit.execute already writes
 * the full plan to .rivet/plans/{slug}.md.
 *
 * This is a PURE SYNC operation — no artifactStore needed, no async.
 */

import type { ToolArgProcessor } from '../agent/tool-arg-post-processor.js'
import { slugify } from '../plan/plan-store.js'

const PLAN_POINTER_PREFIX = '[plan persisted to'

export const planSubmitArgProcessor: ToolArgProcessor = {
  toolName: 'plan_submit',

  process(args: string): string | null {
    let parsed: { title?: string; plan?: string; [k: string]: unknown }
    try { parsed = JSON.parse(args) } catch { return null }

    if (typeof parsed.plan !== 'string' || parsed.plan.length === 0) return null

    // Idempotent: already replaced
    if (parsed.plan.startsWith(PLAN_POINTER_PREFIX)) return null

    const planLen = parsed.plan.length
    const planLines = parsed.plan.split('\n').length
    const title = typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : 'untitled'
    const slug = slugify(title)
    const fileRef = `.rivet/plans/${slug}.md`

    return JSON.stringify({
      ...parsed,
      plan: `${PLAN_POINTER_PREFIX} ${fileRef} — ${planLines} lines, ${planLen} chars. Use read_file to review.]`,
    })
  },
}
