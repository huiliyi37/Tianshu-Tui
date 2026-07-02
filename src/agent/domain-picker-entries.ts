/**
 * Shared star-domain picker entry builder.
 *
 * Single source of truth for the "Auto / <built-in & custom domains>"
 * selection list, consumed by BOTH the TUI domain-picker overlay (src/main.ts)
 * and the desktop server's GET /sessions/:id/domains route. Keeps the two
 * surfaces byte-identical instead of drifting copies.
 */
import { starDomainRegistry } from './star-domain-registry.js'
import type { ActiveStarDomain } from './star-domain.js'

/**
 * Shared warning shown when a star-domain is switched MID-SESSION. Swapping the
 * volatileBlock rewrites frozenBase, so the prefix cache is fully invalidated and
 * the next request rebuilds the whole context (~10x cost). New sessions / picking
 * a domain before the first turn pay nothing.
 */
export const DOMAIN_SWITCH_CACHE_WARNING =
  '⚠ 会话中途切换星域会使前缀缓存整体失效，下一次请求需全量重建上下文（成本约 10 倍+）。建议新开会话或在会话开始时选择。'

export interface DomainPickerEntry {
  /** Selection key: 'auto' | domain id. */
  key: string
  name: string
  motto: string
  /** Secondary dim meta: decisionStyle · keywords. */
  meta: string
  /** One-shot essence preview (never the full volatileBlock). */
  essence: string
  /** Whether this is the session's current selection. */
  current: boolean
  uiPersona?: {
    separator: 'thin' | 'thick' | 'dots'
    accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
    glyph: string
  }
}

/**
 * Build the domain picker entries given the session's current domain state.
 *
 * User-selectable options: `Auto` + each built-in/custom domain. The `Off`
 * option was removed — a session with no persona is only reachable via the
 * `STAR_SOUL=0` env kill switch, not a picker choice.
 *
 * Tri-state mirrors AgentLoop.getSessionDomain():
 *  - `undefined` → Auto (per-message keyword match)
 *  - `null`      → no persona (env kill switch only; not user-selectable)
 *  - object      → a specific domain is pinned
 */
export function buildDomainPickerEntries(
  current: ActiveStarDomain | null | undefined,
): DomainPickerEntry[] {
  return [
    {
      key: 'auto',
      name: 'Auto',
      motto: '按任务匹配',
      meta: 'auto · 关键词自动匹配星域',
      essence: '根据每条消息内容自动匹配最合适的星域方法论；未命中时回退天枢。',
      // null (env kill switch) has no picker entry → also reflect as Auto-selected.
      current: current === undefined || current === null,
      uiPersona: { separator: 'thin', accent: 'primary', glyph: '⚙' },
    },
    ...starDomainRegistry.list().map((d) => {
      const firstLine = (d.volatileBlock || '')
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s.length > 0) ?? ''
      const essence = [d.motto, firstLine].filter(Boolean).join(' — ').slice(0, 400)
      return {
        key: d.id,
        name: d.name,
        motto: d.motto ?? '',
        meta: `${d.decisionStyle} · ${d.keywords.slice(0, 4).join(',')}`,
        essence,
        current: current != null && current.id === d.id,
        uiPersona: d.uiPersona,
      }
    }),
  ]
}
