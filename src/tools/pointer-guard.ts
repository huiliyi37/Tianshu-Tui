/**
 * Pointer-regurgitation guard — shared detection for all file-editing tools.
 *
 * The tool-arg post-processors replace large content fields in MESSAGE HISTORY
 * with pointer placeholders ("[file written to …]" etc). The model sees dozens
 * of these in its own past tool calls and — especially in long sessions with
 * many large writes — starts IMITATING the pattern, emitting pointer text as
 * the actual content of a new write/edit (user report 2026-07-06: 11 batches of
 * vocabulary files taught the model the pattern; batch 12 got a literal
 * "[hash_edit applied to …]" line written into the file).
 *
 * Every tool that accepts a large text field must reject values that start
 * with ANY pointer prefix — the model may echo a write_file pointer into
 * hash_edit's new_string and vice versa. Detection is a literal prefix check
 * on the trimmed value: real content that merely MENTIONS a pointer mid-text
 * is untouched.
 */
import { WRITE_FILE_POINTER_PREFIX } from './write-file-arg-processor.js'
import { EDIT_FILE_POINTER_PREFIX } from './edit-file-arg-processor.js'
import { HASH_EDIT_POINTER_PREFIX } from './hash-edit-arg-processor.js'
import { POINTER_INTERNAL_TAG } from './pointer-tag.js'

/** edit_file's new_string collapse marker (see edit-file-arg-processor render). */
export const EDIT_NEW_BLOCK_POINTER_PREFIX = '[new block'
/** plan_submit's plan collapse marker (local const in plan-submit-arg-processor). */
export const PLAN_POINTER_PREFIX = '[plan persisted to'

export const POINTER_PLACEHOLDER_PREFIXES: readonly string[] = [
  WRITE_FILE_POINTER_PREFIX,
  EDIT_FILE_POINTER_PREFIX,
  HASH_EDIT_POINTER_PREFIX,
  EDIT_NEW_BLOCK_POINTER_PREFIX,
  PLAN_POINTER_PREFIX,
]

/** Stable marker embedded in every guard error — the pointer-regurgitation
 *  advisory hook keys off this substring to count repeated offenses. */
export const POINTER_GUARD_ERROR_MARKER = 'pointer placeholder from message history'

/** Re-exported from pointer-tag.ts for convenience; this is the machine-only tag
 *  embedded in every real pointer produced by the arg processors. */
export { POINTER_INTERNAL_TAG }

/** Marker phrases that appear inside every real pointer produced by the arg
 *  processors. Used as a secondary guard so that real content which merely
 *  happens to start with the same bracketed prefix is not rejected. */
const POINTER_MARKER_PHRASES: readonly string[] = [
  POINTER_INTERNAL_TAG,
  'Display placeholder',
  'never emit as content',
  'Use read_file to review',
]

/**
 * Returns the matched pointer prefix when `value` (after leading whitespace)
 * starts with one AND matches the structural shape of a real pointer, or null
 * for real content.
 *
 * Real pointers are single-line and contain a marker phrase. Model imitations
 * often start with the same prefix (because they appear dozens of times in
 * compressed history) but then continue with real multi-line content; those
 * must be allowed to write.
 *
 * We also scan every line of the value, so that a pointer placeholder embedded
 * in the middle or at the end of a larger argument (e.g. the model prepends a
 * sentence and then echoes the placeholder line) is still caught.
 */
export function detectPointerPlaceholder(value: string): string | null {
  // Fast path: the whole value is a pointer (most common regurgitation pattern).
  const head = detectPointerPlaceholderInLine(value.trimStart())
  if (head) return head

  // Scan each line independently. A pointer placeholder produced by the arg
  // processors is always a single line; if any complete line matches, reject.
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trimStart()
    if (line.length === 0) continue
    const matched = detectPointerPlaceholderInLine(line)
    if (matched) return matched
  }
  return null
}

function detectPointerPlaceholderInLine(line: string): string | null {
  for (const prefix of POINTER_PLACEHOLDER_PREFIXES) {
    if (!line.startsWith(prefix)) continue
    // Literal pointers are always rendered as a single line by the arg
    // processors; any newline means the model added real content after the
    // prefix imitation.
    if (line.includes('\n') || line.includes('\r')) continue
    if (!POINTER_MARKER_PHRASES.some(phrase => line.includes(phrase))) continue
    return prefix
  }
  return null
}

/**
 * Model-facing rejection message. Explains the placeholder mechanism (the model
 * cannot know its own history was rewritten) and gives the concrete recovery
 * path, so a single rejection is enough to break the imitation loop.
 */
export function pointerPlaceholderError(opts: {
  toolName: string
  field: string
  matchedPrefix: string
  filePath: string
}): string {
  return (
    `错误：${opts.field} 的内容是 ${POINTER_GUARD_ERROR_MARKER}（"${opts.matchedPrefix} …"），不是真实的文件内容。 `
    + `这类占位符只在你的历史消息中出现——大内容写入成功后参数会被替换成显示指针，它们从来不是合法输入。 `
    + `不要模仿历史里的占位符格式。修复：在 ${opts.field} 参数中写出完整的真实内容（可以是完整代码）；`
    + `如果需要此文件的旧版本，请先 read_file ${opts.filePath}。`
  )
}
