import type { StarDomainId } from '../../agent/star-domain.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'
import type { GlancePulse } from './types.js'

export interface GlanceBus {
  snapshot(): readonly GlancePulse[]
  pushAlert(domain: StarDomainId, hint: string): void
  setActive(domain: StarDomainId): void
  reset(domain: StarDomainId): void
  subscribe(cb: () => void): () => void
}

export function createGlanceBus(): GlanceBus {
  const state = new Map<StarDomainId, GlancePulse>(
    starDomainRegistry.getDomainIds().map(d => [d as StarDomainId, { domain: d as StarDomainId, level: 'quiet' }])
  )
  const listeners = new Set<() => void>()

  function notify() {
    for (const cb of listeners) {
      try { cb() } catch { /* listener errors non-fatal */ }
    }
  }

  return {
    snapshot() { return [...state.values()] },

    pushAlert(domain, hint) {
      state.set(domain, { domain, level: 'alert', hint })
      notify()
    },

    setActive(domain) {
      state.set(domain, { domain, level: 'active' })
      notify()
    },

    reset(domain) {
      state.set(domain, { domain, level: 'quiet' })
      notify()
    },

    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
}
