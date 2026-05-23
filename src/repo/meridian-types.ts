export type MeridianSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'enum'

export type MeridianEdgeKind = 'imports' | 'calls' | 'contains' | 'type_of' | 'co_edit' | 'tested_by'

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
