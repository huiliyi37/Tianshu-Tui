import type { SurfaceDefinition, SurfaceEvent, SurfaceLayer, SurfaceRouterApi, GlancePulse, SurfaceGlanceContext, Unsubscribe } from './types.js'

export function createSurfaceRouter(): SurfaceRouterApi {
  const registry = new Map<string, SurfaceDefinition>()
  let base: string | null = null
  let overlay: string | null = null
  const popupStack: string[] = []
  const listeners = new Set<(event: SurfaceEvent) => void>()

  function emit(event: SurfaceEvent) {
    for (const cb of listeners) {
      try { cb(event) } catch { /* listener errors must not crash router */ }
    }
  }

  function getDef(id: string): SurfaceDefinition | undefined {
    return registry.get(id)
  }

  function callOnEnter(id: string) {
    try { getDef(id)?.onEnter?.() } catch { /* lifecycle errors non-fatal */ }
  }

  function callOnExit(id: string) {
    try { getDef(id)?.onExit?.() } catch { /* lifecycle errors non-fatal */ }
  }

  const api: SurfaceRouterApi = {
    register(def) {
      if (def.layer === 'base') {
        if (base !== null) throw new Error(`Base surface already registered: ${base}`)
        base = def.id
      }
      registry.set(def.id, def)
      return () => {
        registry.delete(def.id)
        if (base === def.id) base = null
        if (overlay === def.id) overlay = null
        const idx = popupStack.indexOf(def.id)
        if (idx >= 0) popupStack.splice(idx, 1)
      }
    },

    push(id) {
      const def = getDef(id)
      if (!def) return

      if (def.layer === 'overlay') {
        const prev = overlay
        if (prev === id) return
        if (prev) callOnExit(prev)
        overlay = id
        callOnEnter(id)
        emit({ type: 'pushed', id, layer: 'overlay' })
      } else if (def.layer === 'popup') {
        if (popupStack[popupStack.length - 1] === id) return
        popupStack.push(id)
        callOnEnter(id)
        emit({ type: 'pushed', id, layer: 'popup' })
      }
    },

    pop() {
      if (popupStack.length > 0) {
        const id = popupStack.pop()!
        callOnExit(id)
        emit({ type: 'popped', id, layer: 'popup' })
        return
      }
      if (overlay) {
        const id = overlay
        overlay = null
        callOnExit(id)
        emit({ type: 'popped', id, layer: 'overlay' })
      }
    },

    replace(id) {
      const def = getDef(id)
      if (!def) return

      if (def.layer === 'overlay') {
        const prev = overlay
        if (prev === id) return
        if (prev) callOnExit(prev)
        overlay = id
        callOnEnter(id)
        emit({ type: 'replaced', prev: prev ?? '', next: id, layer: 'overlay' })
      }
    },

    closeLayer(layer) {
      if (layer === 'popup') {
        while (popupStack.length > 0) {
          const id = popupStack.pop()!
          callOnExit(id)
          emit({ type: 'popped', id, layer: 'popup' })
        }
      } else if (layer === 'overlay' && overlay) {
        const id = overlay
        overlay = null
        callOnExit(id)
        emit({ type: 'popped', id, layer: 'overlay' })
      }
    },

    activeOf(layer) {
      if (layer === 'base') return base
      if (layer === 'overlay') return overlay
      if (layer === 'popup') return popupStack[popupStack.length - 1] ?? null
      return null
    },

    isVisible(id) {
      if (id === base) return true
      if (id === overlay) return true
      return popupStack.includes(id)
    },

    glanceSnapshot() {
      const ctx: SurfaceGlanceContext = { isStreaming: false, turnCount: 0 }
      const pulses: GlancePulse[] = []
      for (const def of registry.values()) {
        if (def.glance) {
          try {
            const p = def.glance(ctx)
            if (p) pulses.push(p)
          } catch { /* glance errors non-fatal */ }
        }
      }
      return pulses
    },

    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },

    getDiscoverable() {
      const result: SurfaceDefinition[] = []
      for (const def of registry.values()) {
        if (def.discoverable) result.push(def)
      }
      return result
    },
  }

  return api
}
