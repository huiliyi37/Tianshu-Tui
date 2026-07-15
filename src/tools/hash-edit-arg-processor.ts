/**
 * hash_edit arg processor — collapses a large `new_string` replacement block
 * into a file pointer, because hash_edit.execute applies the edit to `file_path`
 * on disk and later turns can read the current content back.
 *
 * hash_edit is the anchor-based sibling of edit_file: `anchors` are tiny by
 * design (L<line>:<hash>), so the only bloat source is `new_string`. This is
 * the threshold instance of the shared createFileContentArgProcessor factory
 * (same single-large-field pattern as write_file.content).
 *
 * Like the write_file/edit_file processors, this only touches the stringified
 * arguments in oaiMessages — `block.input` is untouched, so execute still gets
 * the real new_string to apply.
 */

import { createFileContentArgProcessor } from '../agent/tool-arg-post-processor.js'
import { POINTER_INTERNAL_TAG } from './pointer-tag.js'

export const HASH_EDIT_POINTER_PREFIX = '[hash_edit applied to'

/** new_string length (chars) above which we collapse to a pointer. */
export const HASH_EDIT_THRESHOLD = 2000

export const hashEditArgProcessor = createFileContentArgProcessor({
  toolName: 'hash_edit',
  contentField: 'new_string',
  pointerPrefix: HASH_EDIT_POINTER_PREFIX,
  threshold: HASH_EDIT_THRESHOLD,
  resolvePath: parsed => {
    const fp = parsed.file_path
    return typeof fp === 'string' && fp.length > 0 ? fp : null
  },
  render: ({ path, lines, chars }) =>
    `${HASH_EDIT_POINTER_PREFIX} ${path} — new block ${lines} lines, ${chars} chars. ${POINTER_INTERNAL_TAG} Display placeholder — never emit this as content; use read_file to review.]`,
})
