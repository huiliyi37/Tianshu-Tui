import type { DomainEntry, ModelEntry, ProviderListItem } from './protocol.js'

export function buildSessionCatalog(
  providers: readonly ProviderListItem[],
  defaultModel: string | null | undefined,
  defaultDomain: string | undefined,
  domains: readonly { id: string; name: string; motto: string }[],
): { models: ModelEntry[]; domains: DomainEntry[] } {
  const models: ModelEntry[] = []
  for (const p of providers) {
    if (p.keyStatus.source === 'none') continue
    for (const m of p.models ?? []) {
      const ref = `${p.name}:${m.id}`
      const current = !!defaultModel && (defaultModel === ref || defaultModel === m.id || defaultModel === m.alias)
      models.push({
        id: ref,
        alias: m.alias || m.id,
        provider: p.name,
        current,
      })
    }
  }
  if (models.length > 0 && !models.some((m) => m.current)) {
    models[0] = { ...models[0]!, current: true }
  }

  const domainKey = defaultDomain?.trim() || 'auto'
  const catalogDomains: DomainEntry[] = [
    { key: 'auto', name: '自动', motto: '按任务选域', meta: '', current: domainKey === 'auto' },
    ...domains.map((d) => ({
      key: d.id,
      name: d.name,
      motto: d.motto,
      meta: '',
      current: d.id === domainKey,
    })),
  ]
  return { models, domains: catalogDomains }
}

export function catalogSelection(models: readonly ModelEntry[], domains: readonly DomainEntry[]): { model?: string; domain?: string } {
  return {
    model: models.find((m) => m.current)?.id,
    domain: domains.find((d) => d.current)?.key ?? 'auto',
  }
}
