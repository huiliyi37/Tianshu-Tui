/**
 * 统一劝导总线 — 将五条独立纠偏通道收敛为单一 <harness-advisory> 汇聚器。
 *
 * 通道来源：
 *   1. immune projection（loop.ts — 自体免疫投射）
 *   2. repair-hint appendix（volatile.ts — 修复提示）
 *   3. MistakeNotebook（tool-pipeline.ts — 工具错误模式匹配）
 *   4. dedup-guard（dedup-guard-hook.ts — 重复输出检测）
 *   5. stigmergy dead-end（signal-consumer-hook.ts — 死路信号）
 *
 * 约束：
 *   - 每轮最多渲染 3 条（按优先级倒序取 Top-3）
 *   - 同 key 去重（同一劝导不在同轮重复出现）
 *   - 经由 GWT salience 机制走 dynamic appendix 单一出口
 */

export interface AdvisoryEntry {
  /** 去重键 — 同 key 在同轮只保留优先级最高的一条 */
  key: string
  /** 优先级，越高越靠前（0-1 归一化） */
  priority: number
  /** 分类标签 */
  category: AdvisoryCategory
  /** 渲染内容 — 单行纯文本，不包含 XML 标签 */
  content: string
  /** TTL（轮次），默认为 1（仅本轮） */
  ttl?: number
}

export type AdvisoryCategory =
  | 'immune'
  | 'repair'
  | 'mistake'
  | 'dedup'
  | 'dead_end'
  | 'cerebellar'

/** 每轮最大渲染条数 */
const MAX_ADVISORIES_PER_TURN = 3

export class AdvisoryBus {
  private entries: AdvisoryEntry[] = []
  /** 存活条目 — 未过期的跨轮条目 */
  private alive: AdvisoryEntry[] = []

  /** 投递一条劝导 */
  submit(entry: AdvisoryEntry): void {
    this.entries.push(entry)
  }

  /** 批量投递 */
  submitAll(entries: AdvisoryEntry[]): void {
    this.entries.push(...entries)
  }

  /**
   * 渲染本轮劝导为 `<harness-advisory>` XML 块。
   * 去重 → Top-3 排序 → 减 TTL → 返回字符串（无条目时返回空串）。
   * 调用后清空本轮 entries，alive 条目进入下轮。
   */
  render(): string {
    // 合并 alive（上轮未过期） + 本轮新投递
    const all = [...this.alive, ...this.entries]

    // 去重：同 key 只保留优先级最高的一条
    const deduped = new Map<string, AdvisoryEntry>()
    for (const entry of all) {
      const existing = deduped.get(entry.key)
      if (!existing || entry.priority > existing.priority) {
        deduped.set(entry.key, entry)
      }
    }

    // 按优先级倒序取 Top-3
    const sorted = [...deduped.values()]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_ADVISORIES_PER_TURN)

    // 渲染
    if (sorted.length === 0) {
      this.entries = []
      this.alive = []
      return ''
    }

    const lines = sorted.map(e =>
      `  <entry key="${escapeXml(e.key)}" priority="${e.priority.toFixed(2)}" category="${e.category}">${escapeXml(e.content)}</entry>`
    )

    // TTL 递减：TTL > 1 的条目保留到 alive，下轮继续
    this.alive = sorted
      .filter(e => (e.ttl ?? 1) > 1)
      .map(e => ({ ...e, ttl: (e.ttl ?? 1) - 1 }))

    // 清空本轮 entries
    this.entries = []

    return `<harness-advisory>\n${lines.join('\n')}\n</harness-advisory>`
  }

  /** 清空所有状态 */
  reset(): void {
    this.entries = []
    this.alive = []
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
