import { CollapsedReadSearchBuffer, isCollapsibleTool, type CollapsedReadSearchGroup } from '../format/collapsed-read-search.js'
import { capToolAccumulator, TOOL_ACCUMULATOR_MAX_BYTES } from './tool-accumulator.js'

export interface PendingToolMeta {
  name: string
  input: Record<string, unknown>
  startMs: number
  _approvalMode?: string
}

export interface TruncatedToolInfo {
  toolName: string
  content: string
  isError: boolean
  rawPath?: string
  toolInput?: Record<string, unknown>
}

/**
 * Tool lifecycle state manager — holds the 5 tool-related state fields
 * extracted from TuiApp (W-B1). Commit/render decisions stay in TuiApp;
 * this class only manages buffer/accumulator/metadata state.
 */
export class ToolGroupController {
  private toolAccumulator = new Map<string, string>()
  private pendingTools = new Map<string, PendingToolMeta>()
  private lastTruncatedTool: TruncatedToolInfo | null = null
  private lastCollapsedGroup: CollapsedReadSearchGroup | null = null
  private toolGroupBuffer = new CollapsedReadSearchBuffer()

  // ── pendingTools ──
  setPending(id: string, meta: PendingToolMeta): void {
    this.pendingTools.set(id, meta)
  }

  getPending(id: string): PendingToolMeta | undefined {
    return this.pendingTools.get(id)
  }

  deletePending(id: string): PendingToolMeta | undefined {
    const meta = this.pendingTools.get(id)
    this.pendingTools.delete(id)
    return meta
  }

  getPendingEntries(): IterableIterator<[string, PendingToolMeta]> {
    return this.pendingTools.entries()
  }

  getPendingSize(): number {
    return this.pendingTools.size
  }

  /** Iterate pending tools that are delegation-type */
  getDelegationPending(): [string, PendingToolMeta][] {
    return [...this.pendingTools.entries()].filter(([, meta]) => {
      // Lazy import to avoid circular — isDelegationTool is a pure filter
      return meta._approvalMode !== undefined || meta.name.startsWith('delegate') || meta.name === 'team_orchestrate'
    })
  }

  // ── toolAccumulator ──
  accumulate(id: string, chunk: string): void {
    const prev = this.toolAccumulator.get(id) ?? ''
    this.toolAccumulator.set(id, capToolAccumulator(prev + chunk, TOOL_ACCUMULATOR_MAX_BYTES))
  }

  getAccumulated(id: string): string | undefined {
    return this.toolAccumulator.get(id)
  }

  deleteAccumulated(id: string): string | undefined {
    const acc = this.toolAccumulator.get(id)
    this.toolAccumulator.delete(id)
    return acc
  }

  // ── toolGroupBuffer ──
  pushUse(id: string, name: string, input: Record<string, unknown>): void {
    this.toolGroupBuffer.pushUse(id, name, input)
  }

  isActiveGroup(): boolean {
    return this.toolGroupBuffer.isActive()
  }

  getActiveGroup() {
    return this.toolGroupBuffer.getActive()
  }

  flushGroup(): CollapsedReadSearchGroup | null {
    const group = this.toolGroupBuffer.flush()
    if (group) this.lastCollapsedGroup = group
    return group
  }

  attachResult(id: string, content: string, isError: boolean): void {
    this.toolGroupBuffer.attachResult(id, content, isError)
  }

  // ── lastCollapsedGroup ──
  getLastCollapsedGroup(): CollapsedReadSearchGroup | null {
    return this.lastCollapsedGroup
  }

  clearLastCollapsedGroup(): void {
    this.lastCollapsedGroup = null
  }

  // ── lastTruncatedTool ──
  setLastTruncatedTool(info: TruncatedToolInfo): void {
    this.lastTruncatedTool = info
  }

  getLastTruncatedTool(): TruncatedToolInfo | null {
    return this.lastTruncatedTool
  }

  clearLastTruncatedTool(): void {
    this.lastTruncatedTool = null
  }

  // ── bulk lifecycle ──
  clear(): void {
    this.pendingTools.clear()
    this.toolAccumulator.clear()
  }
}
