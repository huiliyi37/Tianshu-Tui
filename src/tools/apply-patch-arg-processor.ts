/**
 * apply_patch arg processor — collapses a large `diff` into a file-list summary
 * pointer, because apply_patch.execute applies the patch to the working tree and
 * the resulting changes are reconstructable via read_file / git diff.
 *
 * Unlike write_file/edit_file/hash_edit, the verbatim diff is NOT persisted to a
 * single path, so this collapse is LOSSY (the patch text itself is dropped from
 * history). That is an accepted trade-off for multi-file patches, which are the
 * primary remaining bloat source. To keep the retry loop intact:
 *
 * - `check_only: true` patches are left inline — nothing is applied yet, and the
 *   model needs to see the diff to fix it if validation fails.
 * - The threshold is high (only pathologically large patches collapse), so the
 *   common case keeps the diff visible.
 *
 * Only touches the stringified arguments in oaiMessages — `block.input` is
 * untouched, so execute still receives the real diff to apply.
 */

import type { ToolArgProcessor } from '../agent/tool-arg-post-processor.js'

export const APPLY_PATCH_POINTER_PREFIX = '[patch applied to'

/** diff length (chars) above which we collapse to a summary pointer. */
export const APPLY_PATCH_THRESHOLD = 4000

const MAX_LISTED_FILES = 5

/** Extract changed file paths from a unified diff's `+++ ` header lines. */
function parsePatchedFiles(diff: string): string[] {
  const files: string[] = []
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue
    let path = line.slice(4).trim()
    // Strip a trailing tab + timestamp some diff tools append.
    const tabIdx = path.indexOf('\t')
    if (tabIdx !== -1) path = path.slice(0, tabIdx)
    if (path === '/dev/null') continue // pure deletion target
    if (path.startsWith('b/')) path = path.slice(2)
    if (path.length > 0) files.push(path)
  }
  return files
}

export const applyPatchArgProcessor: ToolArgProcessor = {
  toolName: 'apply_patch',

  process(args: string): string | null {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(args) } catch { return null }

    const diff = parsed.diff
    if (typeof diff !== 'string' || diff.length === 0) return null
    // Idempotent: already collapsed.
    if (diff.startsWith(APPLY_PATCH_POINTER_PREFIX)) return null
    // check_only validations stay inline — model may need the diff to fix it.
    if (parsed.check_only === true) return null
    // Threshold gate: only collapse pathologically large patches.
    if (diff.length < APPLY_PATCH_THRESHOLD) return null

    const files = parsePatchedFiles(diff)
    // No parseable file headers → avoid a meaningless pointer, keep original.
    if (files.length === 0) return null

    const hunks = (diff.match(/^@@ /gm) ?? []).length
    const shown = files.slice(0, MAX_LISTED_FILES).join(', ')
    const more = files.length > MAX_LISTED_FILES ? `, …(+${files.length - MAX_LISTED_FILES})` : ''

    return JSON.stringify({
      ...parsed,
      diff: `${APPLY_PATCH_POINTER_PREFIX} ${files.length} file(s): ${shown}${more} — ${hunks} hunks, ${diff.length} chars. Use read_file / git diff to inspect.]`,
    })
  },
}
