/**
 * System-reminder marker for injected pseudo-user messages.
 *
 * TTSR / convergence kick / hook nudges / thinking-retry inject guidance as
 * role:user messages. Without a marker, each injection looks like a real user
 * boundary to PromptEngine — triggering appendix rebuild + volatileBlock swap
 * and breaking the DeepSeek exact-prefix cache mid-task (cache-log #10/#12/#35).
 *
 * Convention: every injected message is wrapped in <system-reminder> tags.
 * PromptEngine passes such messages through untouched (no trailer merge, no
 * boundary detection); session persistence already excludes them from turn
 * counting and history replay.
 */

export const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/** True when a message content string is an injected system reminder. */
export function isSystemReminder(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(SYSTEM_REMINDER_OPEN)
}

/** Wrap injected guidance in reminder tags (idempotent). */
export function wrapSystemReminder(text: string): string {
  if (text.startsWith(SYSTEM_REMINDER_OPEN)) return text
  return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`
}
