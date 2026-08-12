/**
 * Unified zod-issue formatting — translates ZodError paths into
 * `provider.providers.deepseek.models[0].contextWindow: <message>` lines.
 * Shared by config loading (manager.ts) and any future schema boundary so a
 * validation failure always names the exact offending field.
 */
import type { ZodError, ZodIssue } from 'zod'

/** Join an issue path: ['provider','providers','x','models',0] → provider.providers.x.models[0]. */
export function formatZodPath(path: ReadonlyArray<PropertyKey>): string {
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out ? `.${String(seg)}` : String(seg)
  }
  return out || '(root)'
}

export function formatZodIssues(issues: readonly ZodIssue[], source: string): string {
  // Cap the list — a deeply broken config can produce dozens of issues and the
  // first few almost always point at the real mistake.
  const shown = issues.slice(0, 8).map(issue => `  ${formatZodPath(issue.path)}: ${issue.message}`)
  const more = issues.length > shown.length ? `\n  …（另有 ${issues.length - shown.length} 处错误未列出）` : ''
  return `${source} 配置校验失败：\n${shown.join('\n')}${more}`
}

export function formatZodError(error: ZodError, source: string): string {
  return formatZodIssues(error.issues, source)
}
