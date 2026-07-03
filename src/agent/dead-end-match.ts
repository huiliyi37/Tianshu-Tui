/** 匹配开头的 `cd <path> && `（path 可带单/双引号），可重复出现。 */
const CD_BOILERPLATE_RE = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/

/** legacy 摘要前缀 `处理 `（summarizeTarget 生成）+ 尾部 `...` 截断标记。 */
const SUMMARY_PREFIX_RE = /^处理 /

/**
 * Normalize a dead-end pheromone path for matching against recent tool targets.
 *
 * 三步消毒（会话 5158719d 噪音链修复）：
 * 1. 剥 legacy `处理 ` 摘要前缀与 `...` 截断尾（迁移自 extractDeadEndPath）。
 * 2. 剥 cd 样板（复用 bashCommandTarget 的正则逻辑）——但剥完为空则返回 ''，
 *    不做「纯 cd 保留」（匹配端语义是消毒，target 提取端才保留纯 cd）。
 *    这让存量脏数据 `cd <repo> && `（截断尾）自然失效，无需存储迁移。
 * 3. trim。
 */
export function normalizeDeadEndTarget(path: string): string {
  let rest = path.replace(SUMMARY_PREFIX_RE, '').replace(/\.\.\.$/, '')
  while (CD_BOILERPLATE_RE.test(rest)) {
    rest = rest.replace(CD_BOILERPLATE_RE, '')
  }
  return rest.trim()
}

/**
 * 判断 dead-end 信息素路径是否与当前工具 targets 关联（两个消费端共享）。
 *
 * - 两端各 normalize 一遍（deadEndPath 与每个 target 都过 normalize），
 *   兼容旧会话恢复（历史 entry 未剥 cd 样板）。
 * - normalize 后长度 < 5 → 永不匹配（消毒存量 `cd <repo> && ` 脏数据 + 防短碎片误命中）。
 * - 占位 target（`<` 开头，如 `<pending>`）跳过。
 * - 其余保持双向子串语义（extracted.includes(t) || t.includes(extracted)）。
 */
export function matchesDeadEnd(deadEndPath: string, targets: string[]): boolean {
  const extracted = normalizeDeadEndTarget(deadEndPath)
  if (!extracted || extracted.length < 5 || extracted === '继续执行当前计划') return false
  return targets.some(rawTarget => {
    if (!rawTarget || rawTarget.startsWith('<')) return false
    const t = normalizeDeadEndTarget(rawTarget)
    if (!t) return false
    return extracted.includes(t) || t.includes(extracted)
  })
}
