import { useState, useEffect, useCallback, useRef } from 'react'
import type { SurfaceLayer, SurfaceRouterApi, SurfaceDefinition } from './types.js'

export function useSurface(router: SurfaceRouterApi) {
  const [, bump] = useState(0)
  const routerRef = useRef(router)
  routerRef.current = router

  useEffect(() => router.subscribe(() => bump(n => n + 1)), [router])

  return {
    activeOverlay: router.activeOf('overlay'),
    activePopup: router.activeOf('popup'),
    isVisible: useCallback((id: string) => routerRef.current.isVisible(id), []),
    push: useCallback((id: string) => routerRef.current.push(id), []),
    pop: useCallback(() => routerRef.current.pop(), []),
    closeLayer: useCallback((layer: SurfaceLayer) => routerRef.current.closeLayer(layer), []),
    discoverable: router.getDiscoverable() as readonly SurfaceDefinition[],
  }
}
