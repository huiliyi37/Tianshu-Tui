/**
 * 自包含运行时版本候选。
 *
 * 构建期 RUNTIME_VERSION 跟根仓内核。新内核 Release 往往还没挂齐
 * 四平台资产——当前版本 404 时回退到最近一次已发布的 runtime tag。
 */
export const RUNTIME_FALLBACK_VERSIONS = ['3.4.0'] as const

export function runtimeVersionCandidates(current: string, fallbacks: readonly string[] = RUNTIME_FALLBACK_VERSIONS): string[] {
  const out: string[] = []
  const push = (v: string) => {
    const t = v.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  push(current)
  for (const v of fallbacks) push(v)
  return out
}
