export type MeridianSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'enum'

export type MeridianEdgeKind = 'imports' | 'calls' | 'contains' | 'type_of' | 'co_edit' | 'tested_by'

export type EdgeConfidence = 'extracted' | 'inferred' | 'ambiguous'

export const CONFIDENCE_MULTIPLIER: Record<EdgeConfidence, number> = {
  extracted: 1.0,
  inferred: 0.7,
  ambiguous: 0.4,
}

export interface MeridianSymbol {
  id: string
  name: string
  kind: MeridianSymbolKind
  filePath: string
  line: number
  exported: boolean
  contentHash: string
}

export interface MeridianEdge {
  sourceId: string
  targetId: string
  kind: MeridianEdgeKind
  weight: number
  confidence?: EdgeConfidence
}

export interface ParseResult {
  filePath: string
  contentHash: string
  symbols: MeridianSymbol[]
  edges: MeridianEdge[]
  imports: string[]
}

export interface RepoMapEntry {
  filePath: string
  symbols: Array<{ name: string; kind: MeridianSymbolKind; line: number }>
  score: number
}

export interface RepoMapResult {
  entries: RepoMapEntry[]
  totalSymbols: number
  graphSize: number
}

// ─── Codebase index types (project perception layer) ──────────────────

export interface ModuleSummaryEntry {
  /** Directory path relative to cwd, e.g. "src/agent/" */
  dirPath: string
  /** One-line responsibility summary */
  summary: string
  /** Key exported symbol names */
  keyExports: string[]
  /** Number of source files in this module */
  fileCount: number
  /** active | deprecated | experimental */
  status: string
  /** Aggregate content hash of all files in dir (for incremental detection) */
  contentHash: string
  /** Git commit SHA when this entry was last verified */
  verifiedAtCommit?: string
}

export interface CliEntry {
  /** CLI flag, e.g. "--print" or "-p" */
  flag: string
  /** Handler location — source file only (grep-derived line numbers are unreliable).
   *  Agent should verify exact line via read_file before relying on this. */
  handler: string
  /** Whether the flag is known to be wired to actual logic.
   *  false = detected but not yet verified; true = agent has confirmed wiring. */
  wired: boolean
  /** Git commit SHA when this entry was last verified */
  verifiedAtCommit?: string
  /** Source file where the flag is referenced */
  sourceFile: string
}
