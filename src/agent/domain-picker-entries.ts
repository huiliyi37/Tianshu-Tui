/**
 * Shared star-domain picker entry builder.
 *
 * Single source of truth for the "Auto / Off / <built-in & custom domains>"
 * selection list, consumed by BOTH the TUI domain-picker overlay (src/main.ts)
 * and the desktop server's GET /sessions/:id/domains route. Keeps the two
 * surfaces byte-identical instead of drifting copies.
 */
import { starDomainRegistry } from './star-domain-registry.js'
import type { ActiveStarDomain } from './star-domain.js'

export interface DomainPickerEntry {
  /** Selection key: 'auto' | 'off' | domain id. */
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
 * Tri-state mirrors AgentLoop.getSessionDomain():
 *  - `undefined` → Auto (per-message keyword match)
 *  - `null`      → Off (no domain persona)
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
      essence: '根据每条消息内容自动匹配最合适的星域方法论；未命中时不激活任何人格。',
      current: current === undefined,
      uiPersona: { separator: 'thin', accent: 'primary', glyph: '⚙' },
    },
    {
      key: 'off',
      name: 'Off',
      motto: '无星域',
      meta: '关闭星域人格',
      essence: '本会话不激活任何星域方法论，仅使用基础执行纪律。',
      current: current === null,
      uiPersona: { separator: 'thin', accent: 'dim', glyph: '⊘' },
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
