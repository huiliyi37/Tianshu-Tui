import type { ReactNode } from 'react'
import type { StarDomainId } from '../../agent/star-domain.js'

export type SurfaceLayer = 'base' | 'overlay' | 'popup'

export interface GlancePulse {
  readonly domain: StarDomainId
  readonly level: 'quiet' | 'active' | 'alert'
  readonly hint?: string
}

export interface SurfaceRenderContext {
  readonly width: number
  readonly height: number
}

export interface SurfaceGlanceContext {
  readonly isStreaming: boolean
  readonly turnCount: number
}

export interface PaletteEntry {
  readonly label: string
  readonly hint?: string
  readonly hotkey?: string
}

export interface SurfaceDefinition {
  readonly id: string
  readonly layer: SurfaceLayer
  readonly discoverable: boolean
  readonly paletteEntry?: PaletteEntry
  readonly render: (ctx: SurfaceRenderContext) => ReactNode
  readonly glance?: (state: SurfaceGlanceContext) => GlancePulse | null
  readonly onEnter?: () => void
  readonly onExit?: () => void
}

export type SurfaceEvent =
  | { type: 'pushed'; id: string; layer: SurfaceLayer }
  | { type: 'popped'; id: string; layer: SurfaceLayer }
  | { type: 'replaced'; prev: string; next: string; layer: SurfaceLayer }

export type Unsubscribe = () => void

export interface SurfaceRouterApi {
  register(def: SurfaceDefinition): Unsubscribe
  push(id: string): void
  pop(): void
  replace(id: string): void
  closeLayer(layer: SurfaceLayer): void
  activeOf(layer: SurfaceLayer): string | null
  isVisible(id: string): boolean
  glanceSnapshot(): readonly GlancePulse[]
  subscribe(cb: (event: SurfaceEvent) => void): Unsubscribe
  getDiscoverable(): readonly SurfaceDefinition[]
}
