// ── Pure tab state logic (no React / xterm imports) ─────────────
// Extracted into a standalone module so unit tests can run in Node without
// pulling in browser-only CSS.

export interface TerminalTab {
  id: string
  cwd: string
  title: string
}

export class TerminalTabsState {
  tabs: TerminalTab[] = []
  activeId: string = ''
  private counter = 0

  constructor(cwd: string) {
    this.addTab(cwd)
  }

  private nextId(): string {
    this.counter++
    return `term-${Date.now()}-${this.counter}`
  }

  addTab(cwd?: string): TerminalTab {
    const id = this.nextId()
    const count = this.tabs.length
    const title = count === 0 ? 'bash' : `bash ${count + 1}`
    const tab: TerminalTab = { id, cwd: cwd ?? this.tabs[0]?.cwd ?? '', title }
    this.tabs.push(tab)
    this.activeId = id
    return tab
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    this.tabs.splice(idx, 1)
    if (this.tabs.length === 0) {
      // Always keep at least one tab — create a fresh one
      this.addTab()
      return
    }
    if (this.activeId === id) {
      // Select the previous neighbor (or first if closing first)
      const next = Math.max(0, idx - 1)
      this.activeId = this.tabs[next]!.id
    }
  }

  closeOtherTabs(): void {
    this.tabs = this.tabs.filter((t) => t.id === this.activeId)
  }

  setActive(id: string): void {
    if (this.tabs.some((t) => t.id === id)) {
      this.activeId = id
    }
  }
}

export function createTerminalTabsState(cwd: string): TerminalTabsState {
  return new TerminalTabsState(cwd)
}
