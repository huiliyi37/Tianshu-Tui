/**
 * edit_file arg processor — collapses the `old_string` / `new_string` pair into
 * pointers ONLY for very large edits, because edit_file.execute applies the edit
 * to `file_path` on disk and later turns can read the current content back.
 *
 * Deliberately conservative: the combined threshold is high (8000 chars) so that
 * ordinary targeted edits keep their literal strings inline — the model often
 * reasons over the exact diff it just made. Only pathological whole-block
 * rewrites (which behave like write_file and bloat the context) are collapsed.
 *
 * Like the write_file processor, this only touches the stringified arguments in
 * oaiMessages — `block.input` is untouched, so execute still gets the real
 * old_string / new_string to perform the edit.
 */

import type { ToolArgProcessor } from '../agent/tool-arg-post-processor.js'
import { POINTER_INTERNAL_TAG } from './pointer-tag.js'

export const EDIT_FILE_POINTER_PREFIX = '[edit on'

/** Combined old_string + new_string length (chars) above which we collapse. */
export const EDIT_FILE_THRESHOLD = 8000

export const editFileArgProcessor: ToolArgProcessor = {
  toolName: 'edit_file',

  process(args: string): string | null {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(args) } catch { return null }

    const oldStr = parsed.old_string
    const newStr = parsed.new_string
    const filePath = parsed.file_path
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null
    if (typeof filePath !== 'string' || filePath.length === 0) return null

    // Idempotent: already collapsed.
    if (oldStr.startsWith(EDIT_FILE_POINTER_PREFIX)) return null
    // Threshold gate: only collapse pathologically large edits.
    if (oldStr.length + newStr.length < EDIT_FILE_THRESHOLD) return null

    // Keep a short preview of the old block so the edit stays locatable.
    const preview = oldStr.slice(0, 80).replace(/\s+/g, ' ').trim()
    return JSON.stringify({
      ...parsed,
      old_string: `${EDIT_FILE_POINTER_PREFIX} ${filePath}: replaced ${oldStr.length}-char block, preview: "${preview}". ${POINTER_INTERNAL_TAG} Display placeholder — never emit this as content; use read_file for current content.]`,
      new_string: `[new block ${newStr.length} chars — ${POINTER_INTERNAL_TAG} placeholder, never emit as content]`,
    })
  },
}
