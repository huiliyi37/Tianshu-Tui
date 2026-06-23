/**
 * plan_submit arg processor — replaces the full `plan` field in tool call
 * arguments with a file pointer, because plan_submit.execute already writes
 * the full plan to .rivet/plans/{slug}.md.
 *
 * This is a PURE SYNC operation — no artifactStore needed, no async. It is the
 * threshold-0 instance of the shared createFileContentArgProcessor factory
 * (same pattern as write_file). When `title` is missing/empty, resolvePath
 * returns null so no dangling pointer is produced (execute would error anyway).
 */

import { createFileContentArgProcessor } from '../agent/tool-arg-post-processor.js'
import { slugify } from '../plan/plan-store.js'

const PLAN_POINTER_PREFIX = '[plan persisted to'

export const planSubmitArgProcessor = createFileContentArgProcessor({
  toolName: 'plan',
  contentField: 'plan',
  pointerPrefix: PLAN_POINTER_PREFIX,
  threshold: 0,
  resolvePath: parsed => {
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
    if (!title) return null
    return `.rivet/plans/${slugify(title)}.md`
  },
  render: ({ path, lines, chars }) =>
    `${PLAN_POINTER_PREFIX} ${path} — ${lines} lines, ${chars} chars. Use read_file to review.]`,
})
