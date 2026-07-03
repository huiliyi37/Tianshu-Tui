// Approval consent bridge (Q). When a tool is waiting on an explicit user
// approval, users often type their consent as a chat message ("继续执行",
// "同意", "go") instead of clicking the approval control. Those messages land
// in the chat/steer channel and never resolve the pending approval, so the
// model keeps re-hitting the same gate — the "requires user approval" retry
// loop. This maps an unambiguous whole-message consent to the approval channel.
//
// Deliberately conservative: only an exact whole-message match (after trimming
// surrounding punctuation/whitespace) counts, so "继续，但先读文件" or
// "approve only the rename" is NOT treated as blanket approval. Anything longer
// or qualified falls through to the normal send/steer path.

/** Whole-message consent tokens (normalized: lowercased, punctuation stripped). */
const CONSENT_TOKENS: ReadonlySet<string> = new Set([
  // zh
  '继续', '继续执行', '继续吧', '同意', '批准', '允许', '确认', '通过',
  '去做', '去做吧', '执行', '执行吧', '可以', '可以的', '好', '好的', '行',
  // en
  'ok', 'okay', 'yes', 'y', 'go', 'goahead', 'approve', 'approved',
  'proceed', 'continue', 'doit', 'confirm',
])

/**
 * True when `text` is, on its own, an unambiguous approval of a pending action.
 * Normalizes by lowercasing and stripping whitespace and common punctuation
 * (including CJK punctuation), then requires an exact token match.
 */
export function isApprovalConsent(text: string): boolean {
  if (!text) return false
  const normalized = text
    .toLowerCase()
    .replace(/[\s!！.。,，、~～·"'`：:；;\-—]+/g, '')
    .trim()
  if (!normalized) return false
  return CONSENT_TOKENS.has(normalized)
}
