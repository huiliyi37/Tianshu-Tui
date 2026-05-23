import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { MeridianSymbol, MeridianEdge, ParseResult, MeridianSymbolKind } from './meridian-types.js'

// web-tree-sitter 0.24.x uses declare module, import as namespace
import type Parser from 'web-tree-sitter'

type SyntaxNode = Parser.SyntaxNode

let parserModule: typeof Parser | null = null
let parser: Parser | null = null
let parseCount = 0
const MAX_PARSES_BEFORE_RESET = 250

export async function initParser(): Promise<void> {
  const TreeSitter = (await import('web-tree-sitter')).default
  await TreeSitter.init()
  parserModule = TreeSitter
  parser = new TreeSitter()
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm')
  const lang = await TreeSitter.Language.load(wasmPath)
  parser.setLanguage(lang)
  parseCount = 0
}

async function ensureParser(): Promise<Parser> {
  if (!parser || parseCount >= MAX_PARSES_BEFORE_RESET) {
    await initParser()
  }
  return parser!
}

function makeId(filePath: string, name: string, line: number): string {
  return `${filePath}:${name}:${line}`
}

export async function parseTypeScriptFile(filePath: string, source: string): Promise<ParseResult> {
  const p = await ensureParser()
  const tree = p.parse(source)
  parseCount++

  const symbols: MeridianSymbol[] = []
  const edges: MeridianEdge[] = []
  const imports: string[] = []
  const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

  function walk(node: SyntaxNode, parentId?: string): void {
    const row = node.startPosition.row + 1
    const isExported = node.parent?.type === 'export_statement'

    let kind: MeridianSymbolKind | null = null
    let name: string | null = null

    switch (node.type) {
      case 'function_declaration':
        kind = 'function'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'class_declaration':
        kind = 'class'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'interface_declaration':
        kind = 'interface'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'type_alias_declaration':
        kind = 'type'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'enum_declaration':
        kind = 'enum'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'method_definition':
        kind = 'method'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'lexical_declaration':
      case 'variable_declaration': {
        const declarator = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declarator')
        if (declarator) {
          const init = declarator.childForFieldName('value')
          if (init && (init.type === 'arrow_function' || init.type === 'function')) {
            kind = 'function'
          } else {
            kind = 'variable'
          }
          name = declarator.childForFieldName('name')?.text ?? null
        }
        break
      }
      case 'import_statement': {
        const sourceNode = node.childForFieldName('source')
        if (sourceNode) {
          const raw = sourceNode.text.replace(/['"]/g, '')
          if (raw.startsWith('.')) imports.push(raw)
        }
        return
      }
    }

    if (kind && name) {
      const id = makeId(filePath, name, row)
      symbols.push({ id, name, kind, filePath, line: row, exported: isExported, contentHash })
      if (parentId) {
        edges.push({ sourceId: parentId, targetId: id, kind: 'contains', weight: 1.0 })
      }
      for (const child of node.namedChildren) {
        walk(child, id)
      }
      return
    }

    for (const child of node.namedChildren) {
      walk(child, parentId)
    }
  }

  walk(tree.rootNode)
  tree.delete()

  return { filePath, contentHash, symbols, edges, imports }
}
