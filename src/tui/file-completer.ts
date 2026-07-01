import { execSync } from 'node:child_process'

/**
 * Tab 补全的 `@` 触发后从光标前最近 `@` 起的非空白 token。
 * token 内的 emoji/CJK 不会被切碎——正则用 `[^\s]` 锁住空白边界，
 * 让用户粘贴「@🎯 目标.md」或「@中文 路径.md」类带表情符号/中文的
 * 路径请求走完整个 token，再交由 `getCompletions` 走 git ls-files 过滤。
 */
export function extractAtToken(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^\s]*)$/)
  return match ? match[1]! : null
}

/**
 * 走 `git ls-files` 拿补全候选。
 *
 * 超时降到 500ms：领航星 2026-06-11 实测原 3000ms 让 Tab 补全在大仓库下
 * 体验卡顿（用户按 Tab 之后光标停 1-3 秒），而正常 git ls-files 在
 * 1k-10k 文件仓库上 < 100ms 完成。500ms 仍是常规仓库 P99.9 的 3-5 倍
 * 安全边际，但已经是用户感知「即时」的临界。
 *
 * 非 git 目录 / 命令失败 / 超时 → 静默返回 []，**不抛错**：
 * @-补全是输入便利功能，不应污染主流程；上层也只把候选列表当作
 * 「建议」，空候选就当普通 @-token 提交给 agent。
 */
const GIT_LS_FILES_TIMEOUT_MS = 500

export function getCompletions(partial: string, cwd: string, limit: number): string[] {
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const lower = partial.toLowerCase()
    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .filter(f => f.toLowerCase().includes(lower))
      .sort((a, b) => {
        const aS = a.toLowerCase().startsWith(lower) ? 0 : 1
        const bS = b.toLowerCase().startsWith(lower) ? 0 : 1
        return aS - bS || a.length - b.length
      })
      .slice(0, limit)
  } catch {
    return []
  }
}

export function applyCompletion(text: string, cursorPos: number, completion: string): { text: string; cursor: number } {
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const atIdx = before.lastIndexOf('@')
  const newText = before.slice(0, atIdx) + '@' + completion + ' ' + after
  return { text: newText, cursor: atIdx + 1 + completion.length + 1 }
}
