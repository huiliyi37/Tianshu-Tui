import type { PagerData, StarmapData, PaletteData, ChronicleData, TasksData, TasksGroup, TasksWorkerRow, DomainPickerData, ModelPickerData, ThemePickerData, ChoicePanelData } from '../format/overlay.js'
import type { CockpitSnapshot, Panel } from '../cockpit/types.js'
import type { RewindData, RewindFile, RewindMode } from '../format/rewind.js'
import type { HistorySearchData } from '../format/history-search.js'
import type { ConnectCommit } from '../connect-flow.js'

export interface OverlayNavState {
  pagerPage: number
  pagerMode: 'page' | 'search' | 'message'
  pagerSearchQuery: string
  pagerSearchCurrent: number
  pagerSelectedMessage: number
  paletteIndex: number
  rewindIndex: number
  /** Rewind overlay sub-phase: message list vs restore-granularity chooser. */
  rewindPhase: 'list' | 'action'
  rewindActionIndex: number
  historySearchIndex: number
  chronicleIndex: number
  tasksIndex: number
  tasksFilter: import('../format/overlay.js').TasksFilter
  domainPickerIndex: number
  modelPickerIndex: number
  themePickerIndex: number
  choicePanelIndex: number
  connectIndex: number
  query: string
}

export interface OverlayDataProviders {
  pagerContent?: () => PagerData
  starmapEntries?: () => StarmapData
  paletteCommands?: () => PaletteData
  chronicleEntries?: () => ChronicleData
  cockpitSnapshot?: () => CockpitSnapshot
  rewindEntries?: () => RewindData
  /** Precise code-rewind preview for the selected message (phase 2 display). */
  rewindFilePreview?: (messageIndex: number) => RewindFile[]
  historySearchData?: () => HistorySearchData
  tasksData?: () => TasksData
  domainPickerData?: () => DomainPickerData
  modelPickerData?: () => ModelPickerData
  themePickerData?: () => ThemePickerData
  choicePanelData?: () => ChoicePanelData
}

/**
 * Overlay navigation state manager — holds the 6 overlay-related state fields
 * extracted from TuiApp (W-B2). Overlay rendering and key handling stay in
 * TuiApp; this class only manages nav state / data providers / exec callbacks.
 */
export class OverlayController {
  private overlayNav: OverlayNavState = { pagerPage: 0, pagerMode: 'page', pagerSearchQuery: '', pagerSearchCurrent: 0, pagerSelectedMessage: 0, paletteIndex: 0, rewindIndex: 0, rewindPhase: 'list', rewindActionIndex: 0, historySearchIndex: 0, chronicleIndex: 0, tasksIndex: 0, tasksFilter: 'running', domainPickerIndex: 0, modelPickerIndex: 0, themePickerIndex: 0, choicePanelIndex: 0, connectIndex: 0, query: '' }
  private overlayData?: OverlayDataProviders
  private paletteExec?: (index: number) => void
  private rewindExec?: (messageIndex: number, mode: RewindMode) => void
  private chronicleExec?: (id: string) => void
  private domainPickerExec?: (key: string) => void
  private modelPickerExec?: (key: string) => void
  private themePickerExec?: (key: string) => void
  private themePickerSaveDefaultExec?: (key: string) => void
  private choicePanelExec?: (id: string) => void
  private connectExec?: (commit: ConnectCommit, summary: string) => void
  private cockpitPanel: Panel = 'summary'

  // ── nav state ──
  /** Direct mutable access to nav state object */
  nav(): OverlayNavState { return this.overlayNav }
  resetNav(): void {
    this.overlayNav = { pagerPage: 0, pagerMode: 'page' as const, pagerSearchQuery: '', pagerSearchCurrent: 0, pagerSelectedMessage: 0, paletteIndex: 0, rewindIndex: 0, rewindPhase: 'list' as const, rewindActionIndex: 0, historySearchIndex: 0, chronicleIndex: 0, tasksIndex: 0, tasksFilter: 'running' as const, domainPickerIndex: 0, modelPickerIndex: 0, themePickerIndex: 0, choicePanelIndex: 0, connectIndex: 0, query: '' }
  }

  get pagerPage(): number { return this.overlayNav.pagerPage }
  setPagerPage(v: number): void { this.overlayNav.pagerPage = v }
  get pagerMode(): 'page' | 'search' | 'message' { return this.overlayNav.pagerMode }
  setPagerMode(v: 'page' | 'search' | 'message'): void { this.overlayNav.pagerMode = v }
  get pagerSearchQuery(): string { return this.overlayNav.pagerSearchQuery }
  setPagerSearchQuery(v: string): void { this.overlayNav.pagerSearchQuery = v }
  get pagerSearchCurrent(): number { return this.overlayNav.pagerSearchCurrent }
  setPagerSearchCurrent(v: number): void { this.overlayNav.pagerSearchCurrent = v }
  get pagerSelectedMessage(): number { return this.overlayNav.pagerSelectedMessage }
  setPagerSelectedMessage(v: number): void { this.overlayNav.pagerSelectedMessage = v }
  get paletteIndex(): number { return this.overlayNav.paletteIndex }
  setPaletteIndex(v: number): void { this.overlayNav.paletteIndex = v }
  get rewindIndex(): number { return this.overlayNav.rewindIndex }
  setRewindIndex(v: number): void { this.overlayNav.rewindIndex = v }
  get historySearchIndex(): number { return this.overlayNav.historySearchIndex }
  setHistorySearchIndex(v: number): void { this.overlayNav.historySearchIndex = v }
  get chronicleIndex(): number { return this.overlayNav.chronicleIndex }
  setChronicleIndex(v: number): void { this.overlayNav.chronicleIndex = v }
  get tasksIndex(): number { return this.overlayNav.tasksIndex }
  setTasksIndex(v: number): void { this.overlayNav.tasksIndex = v }
  get tasksFilter(): import('../format/overlay.js').TasksFilter { return this.overlayNav.tasksFilter }
  setTasksFilter(v: import('../format/overlay.js').TasksFilter): void { this.overlayNav.tasksFilter = v }
  get domainPickerIndex(): number { return this.overlayNav.domainPickerIndex }
  setDomainPickerIndex(v: number): void { this.overlayNav.domainPickerIndex = v }
  get modelPickerIndex(): number { return this.overlayNav.modelPickerIndex }
  get choicePanelIndex(): number { return this.overlayNav.choicePanelIndex }
  setChoicePanelIndex(v: number): void { this.overlayNav.choicePanelIndex = v }
  get connectIndex(): number { return this.overlayNav.connectIndex }
  setConnectIndex(v: number): void { this.overlayNav.connectIndex = v }
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
  getRewindExec(): ((messageIndex: number, mode: RewindMode) => void) | undefined { return this.rewindExec }
  setRewindExec(fn: ((messageIndex: number, mode: RewindMode) => void) | undefined): void { this.rewindExec = fn }
  getChronicleExec(): ((id: string) => void) | undefined { return this.chronicleExec }
  setChronicleExec(fn: ((id: string) => void) | undefined): void { this.chronicleExec = fn }
  getDomainPickerExec(): ((key: string) => void) | undefined { return this.domainPickerExec }
  setDomainPickerExec(fn: ((key: string) => void) | undefined): void { this.domainPickerExec = fn }
  getModelPickerExec(): ((key: string) => void) | undefined { return this.modelPickerExec }
  setModelPickerExec(fn: ((key: string) => void) | undefined): void { this.modelPickerExec = fn }
  getThemePickerExec(): ((key: string) => void) | undefined { return this.themePickerExec }
  setThemePickerExec(fn: ((key: string) => void) | undefined): void { this.themePickerExec = fn }
  getThemePickerSaveDefaultExec(): ((key: string) => void) | undefined { return this.themePickerSaveDefaultExec }
  setThemePickerSaveDefaultExec(fn: ((key: string) => void) | undefined): void { this.themePickerSaveDefaultExec = fn }
  getChoicePanelExec(): ((id: string) => void) | undefined { return this.choicePanelExec }
  setChoicePanelExec(fn: ((id: string) => void) | undefined): void { this.choicePanelExec = fn }
  getConnectExec(): ((commit: ConnectCommit, summary: string) => void) | undefined { return this.connectExec }
  setConnectExec(fn: ((commit: ConnectCommit, summary: string) => void) | undefined): void { this.connectExec = fn }

  // ── cockpit panel ──
  getCockpitPanel(): Panel { return this.cockpitPanel }
  setCockpitPanel(panel: Panel): void { this.cockpitPanel = panel }
}
