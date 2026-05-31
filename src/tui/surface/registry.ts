import type { SurfaceDefinition } from './types.js'

export function createSurfaceDefinitions(): SurfaceDefinition[] {
  return [
    { id: 'chat', layer: 'base', discoverable: false, render: () => null },
    { id: 'cockpit', layer: 'overlay', discoverable: true, paletteEntry: { label: 'Cockpit', hint: 'trace / verify / context / safety', hotkey: 'c' }, render: () => null },
    { id: 'starmap', layer: 'overlay', discoverable: true, paletteEntry: { label: 'Starmap', hint: '星图总览', hotkey: 's' }, render: () => null },
    { id: 'chronicle', layer: 'overlay', discoverable: true, paletteEntry: { label: 'Chronicle', hint: '阶段传说', hotkey: 'h' }, render: () => null },
    { id: 'pager', layer: 'overlay', discoverable: true, paletteEntry: { label: 'Scrollback', hint: '浏览会话历史', hotkey: 'p' }, render: () => null },
    { id: 'command-palette', layer: 'popup', discoverable: false, render: () => null },
    { id: 'approval', layer: 'popup', discoverable: false, render: () => null },
    { id: 'intent', layer: 'popup', discoverable: false, render: () => null },
    { id: 'rewind', layer: 'popup', discoverable: false, render: () => null },
  ]
}
