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
import { APPLY_PATCH_POINTER_PREFIX } from './apply-patch-arg-processor.js'
import { POINTER_INTERNAL_TAG } from './pointer-tag.js'
import { readFile } from 'node:fs/promises'
import { toPosixPath } from '../path-format.js'
import { canonicalizePathForCompare } from '../agent/plan-mode.js'

/** edit_file's new_string collapse marker (see edit-file-arg-processor render). */
export const EDIT_NEW_BLOCK_POINTER_PREFIX = '[new block'
/** plan_submit's plan collapse marker (local const in plan-submit-arg-processor). */
export const PLAN_POINTER_PREFIX = '[plan persisted to'

export const POINTER_PLACEHOLDER_PREFIXES: readonly string[] = [
  WRITE_FILE_POINTER_PREFIX,
  EDIT_FILE_POINTER_PREFIX,
  HASH_EDIT_POINTER_PREFIX,
  APPLY_PATCH_POINTER_PREFIX,
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
 * Rejection message visible to both the model (as tool result) and the user
 * (on the TUI).  Explains *what happened* in plain terms first, then gives
 * the model a concrete recovery path.  Avoids internal jargon that a human
 * reader cannot decode.  A machine-only marker is appended for hook detection.
 */
export function pointerPlaceholderError(opts: {
  toolName: string
  field: string
  matchedPrefix: string
  filePath: string
}): string {
  return (
    `❌ 写入被拦截：${opts.field} 的内容是历史消息里的显示指针（"${opts.matchedPrefix} …"），不是真实的文件内容。\n\n`
    + `机制：大内容写入成功后，历史消息中的参数会被替换成这种显示指针（节省上下文 token）——你之前的写入已成功落盘，没有出错；这次是把历史里的指针误当正文传了回来。\n\n`
    + `修复：先 read_file ${opts.filePath} 看磁盘当前内容——它很可能已经是你要写的完整内容（若是，直接继续下一步，不要重写）；确认需要修改时，再用真实完整内容调用 ${opts.toolName}。\n\n`
    + `[${POINTER_GUARD_ERROR_MARKER}]`
  )
}

// ── Idempotent pointer resolution (shared across write_file / edit_file / hash_edit / plan) ──

/** 从任意工具的回吐指针首行解析出路径。
 *  各工具指针格式统一为 `<prefix> <path> — …` 或 `<prefix> <path>: …`。
 *  — 分隔符见于 write_file / hash_edit / plan；
 *  : 分隔符见于 edit_file 的 old_string 指针（`[edit on <path>: replaced …]`）。 */
function parsePointerPath(value: string, prefix: string): string | null {
  const firstLine = value.trimStart().split(/\r?\n/, 1)[0] ?? ''
  if (!firstLine.startsWith(prefix)) return null
  const after = firstLine.slice(prefix.length).trimStart()
  // Find the earliest separator — both " — " and ": " can appear in
  // descriptive text; the one closest to the prefix is the path delimiter.
  let bestIdx = Infinity
  for (const sep of [' — ', ': ']) {
    const idx = after.indexOf(sep)
    if (idx >= 0 && idx < bestIdx) bestIdx = idx
  }
  if (bestIdx < Infinity) return after.slice(0, bestIdx).trim()
  const path = after.split(/\s/, 1)[0]?.trim()
  return path && path.length > 0 ? path : null
}

export interface IdempotentResolveInput {
  mode: 'full' | 'edit'
  filePath: string
  value: string
  matchedPrefix: string
}

/**
 * 通用幂等化解：模型把历史里的显示指针当内容回吐时，若指针路径与本次目标一致
 * 且磁盘状态自洽，则按幂等成功返回（正向断模仿循环）；否则返回 null 让调用方
 * 走原 pointer-guard 硬错误。绝不把真实错误吞成成功。
 *
 * - mode='full'（write_file）：磁盘行数须与指针记录精确一致，chars 容 CRLF 偏差。
 * - mode='edit'（edit_file/hash_edit/plan）：指针记录的是块大小非整文件——只校验
 *   路径一致 + 目标文件存在，视为「该编辑上一轮已应用」的 no-op。
 */
export async function resolveIdempotentPointer(
  input: IdempotentResolveInput,
): Promise<{ content: string; isError?: false } | null> {
  const ptrPath = parsePointerPath(input.value, input.matchedPrefix)
  if (!ptrPath) return null
  if (canonicalizePathForCompare(ptrPath) !== canonicalizePathForCompare(toPosixPath(input.filePath))) return null

  let onDisk: string
  try {
    onDisk = (await readFile(input.filePath, 'utf-8')).replace(/\r\n/g, '\n')
  } catch {
    return null
  }

  if (input.mode === 'full') {
    const m = /(\d+) lines?, (\d+) chars/.exec(input.value)
    if (!m) return null
    const wantLines = Number(m[1]); const wantChars = Number(m[2])
    const lines = onDisk.split('\n').length
    if (lines !== wantLines || Math.abs(onDisk.length - wantChars) > wantLines) return null
    return {
      content: `该文件已是指针所指向的内容（磁盘为凭：${lines} lines，路径一致），本次按幂等成功处理、未做写入。`
        + `那是消息历史里的显示指针被当作内容回传的自动化解——以后如需修改请先 read_file 再编辑；如需整文件重写，请写出完整真实内容。`,
    }
  }

  return {
    content: `该编辑已应用到磁盘（路径一致，文件存在），本次按幂等无需重复应用。`
      + `你回传的是消息历史里的 "${input.matchedPrefix} …" 显示指针（不是真实内容）——如需继续修改请先 read_file ${toPosixPath(input.filePath)} 看当前内容。`,
  }
}
