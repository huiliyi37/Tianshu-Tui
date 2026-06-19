import type { PagerData, StarmapData, PaletteData, ChronicleData, TasksData, TasksGroup, TasksWorkerRow, DomainPickerData, ModelPickerData, ThemePickerData } from '../format/overlay.js'
import type { CockpitSnapshot, Panel } from '../cockpit/types.js'
import type { RewindData } from '../format/rewind.js'
import type { HistorySearchData } from '../format/history-search.js'

export interface OverlayNavState {
  pagerPage: number
  paletteIndex: number
  rewindIndex: number
  historySearchIndex: number
  chronicleIndex: number
  domainPickerIndex: number
  modelPickerIndex: number
  themePickerIndex: number
  query: string
}

export interface OverlayDataProviders {
  pagerContent?: () => PagerData
  starmapEntries?: () => StarmapData
  paletteCommands?: () => PaletteData
  chronicleEntries?: () => ChronicleData
  cockpitSnapshot?: () => CockpitSnapshot
  rewindEntries?: () => RewindData
  historySearchData?: () => HistorySearchData
  tasksData?: () => TasksData
  domainPickerData?: () => DomainPickerData
  modelPickerData?: () => ModelPickerData
  themePickerData?: () => ThemePickerData
}

/**
 * Overlay navigation state manager — holds the 6 overlay-related state fields
 * extracted from TuiApp (W-B2). Overlay rendering and key handling stay in
 * TuiApp; this class only manages nav state / data providers / exec callbacks.
 */
export class OverlayController {
  private overlayNav = { pagerPage: 0, paletteIndex: 0, rewindIndex: 0, historySearchIndex: 0, chronicleIndex: 0, domainPickerIndex: 0, modelPickerIndex: 0, themePickerIndex: 0, query: '' }
  private overlayData?: OverlayDataProviders
  private paletteExec?: (index: number) => void
  private rewindExec?: (content: string) => void
  private chronicleExec?: (id: string) => void
  private domainPickerExec?: (key: string) => void
  private modelPickerExec?: (key: string) => void
  private themePickerExec?: (key: string) => void
  private cockpitPanel: Panel = 'summary'

  // ── nav state ──
  /** Direct mutable access to nav state object */
  nav(): OverlayNavState { return this.overlayNav }
  resetNav(): void {
    this.overlayNav = { pagerPage: 0, paletteIndex: 0, rewindIndex: 0, historySearchIndex: 0, chronicleIndex: 0, domainPickerIndex: 0, modelPickerIndex: 0, themePickerIndex: 0, query: '' }
  }

  get pagerPage(): number { return this.overlayNav.pagerPage }
  setPagerPage(v: number): void { this.overlayNav.pagerPage = v }
  get paletteIndex(): number { return this.overlayNav.paletteIndex }
  setPaletteIndex(v: number): void { this.overlayNav.paletteIndex = v }
  get rewindIndex(): number { return this.overlayNav.rewindIndex }
  setRewindIndex(v: number): void { this.overlayNav.rewindIndex = v }
  get historySearchIndex(): number { return this.overlayNav.historySearchIndex }
  setHistorySearchIndex(v: number): void { this.overlayNav.historySearchIndex = v }
  get chronicleIndex(): number { return this.overlayNav.chronicleIndex }
  setChronicleIndex(v: number): void { this.overlayNav.chronicleIndex = v }
  get domainPickerIndex(): number { return this.overlayNav.domainPickerIndex }
  setDomainPickerIndex(v: number): void { this.overlayNav.domainPickerIndex = v }
  get modelPickerIndex(): number { return this.overlayNav.modelPickerIndex }
  setModelPickerIndex(v: number): void { this.overlayNav.modelPickerIndex = v }
  get themePickerIndex(): number { return this.overlayNav.themePickerIndex }
  setThemePickerIndex(v: number): void { this.overlayNav.themePickerIndex = v }

  getQuery(): string { return this.overlayNav.query }
  editQuery(ch: string | null): void {
    if (ch === null) {
      if (this.overlayNav.query.length === 0) return
      this.overlayNav.query = this.overlayNav.query.slice(0, -1)
    } else {
      this.overlayNav.query += ch
    }
    this.overlayNav.paletteIndex = 0
    this.overlayNav.historySearchIndex = 0
  }

  // ── data providers ──
  getData(): OverlayDataProviders | undefined { return this.overlayData }
  setData(data: OverlayDataProviders | undefined): void { this.overlayData = data }

  // ── exec callbacks ──
  getPaletteExec(): ((index: number) => void) | undefined { return this.paletteExec }
  setPaletteExec(fn: ((index: number) => void) | undefined): void { this.paletteExec = fn }
  getRewindExec(): ((content: string) => void) | undefined { return this.rewindExec }
  setRewindExec(fn: ((content: string) => void) | undefined): void { this.rewindExec = fn }
  getChronicleExec(): ((id: string) => void) | undefined { return this.chronicleExec }
  setChronicleExec(fn: ((id: string) => void) | undefined): void { this.chronicleExec = fn }
  getDomainPickerExec(): ((key: string) => void) | undefined { return this.domainPickerExec }
  setDomainPickerExec(fn: ((key: string) => void) | undefined): void { this.domainPickerExec = fn }
  getModelPickerExec(): ((key: string) => void) | undefined { return this.modelPickerExec }
  setModelPickerExec(fn: ((key: string) => void) | undefined): void { this.modelPickerExec = fn }
  getThemePickerExec(): ((key: string) => void) | undefined { return this.themePickerExec }
  setThemePickerExec(fn: ((key: string) => void) | undefined): void { this.themePickerExec = fn }

  // ── cockpit panel ──
  getCockpitPanel(): Panel { return this.cockpitPanel }
  setCockpitPanel(panel: Panel): void { this.cockpitPanel = panel }
}
