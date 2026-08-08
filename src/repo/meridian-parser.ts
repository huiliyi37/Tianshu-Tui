import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { MeridianSymbol, MeridianEdge, ParseResult, MeridianSymbolKind, CallSite } from './meridian-types.js'

// web-tree-sitter 0.24.x uses declare module, import as namespace
import type Parser from 'web-tree-sitter'

type SyntaxNode = Parser.SyntaxNode

let parserModule: typeof Parser | null = null
const parsers = new Map<string, Parser>()
let parseCount = 0
const MAX_PARSES_BEFORE_RESET = 250

export type SupportedLang = 'typescript' | 'python' | 'go'

const LANG_WASM: Record<SupportedLang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
}

const EXT_TO_LANG: Record<string, SupportedLang> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
}

export function detectLang(filePath: string): SupportedLang | null {
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  return EXT_TO_LANG[ext] ?? null
}

export async function initParser(): Promise<void> {
  const TreeSitter = (await import('web-tree-sitter')).default
  await TreeSitter.init()
  parserModule = TreeSitter
  parsers.clear()
  parseCount = 0
}

async function getParser(lang: SupportedLang): Promise<Parser> {
  if (!parserModule || parseCount >= MAX_PARSES_BEFORE_RESET) {
    await initParser()
  }
  if (!parsers.has(lang)) {
    const p = new parserModule!()
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${LANG_WASM[lang]}`)
    const language = await parserModule!.Language.load(wasmPath)
    p.setLanguage(language)
    parsers.set(lang, p)
  }
  return parsers.get(lang)!
}

function makeId(filePath: string, name: string, line: number): string {
  return `${filePath}:${name}:${line}`
}

// --- Unified parse entry point ---

export async function parseFile(filePath: string, source: string): Promise<ParseResult> {
  const lang = detectLang(filePath)
  if (!lang) throw new Error(`Unsupported language for: ${filePath}`)
  switch (lang) {
    case 'typescript': return parseTypeScriptFile(filePath, source)
    case 'python': return parsePythonFile(filePath, source)
    case 'go': return parseGoFile(filePath, source)
  }
}

// --- TypeScript parser (existing) ---

export async function parseTypeScriptFile(filePath: string, source: string): Promise<ParseResult> {
  const p = await getParser('typescript')
  const tree = p.parse(source)
  parseCount++

  const symbols: MeridianSymbol[] = []
  const edges: MeridianEdge[] = []
  const imports: string[] = []
  const calls: CallSite[] = []
  const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

  // Pass 1: symbols + contains edges
  function walkSymbols(node: SyntaxNode, parentId?: string): void {
    const row = node.startPosition.row + 1
    const isExported = node.parent?.type === 'export_statement'

    if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName('source')
      if (sourceNode) {
        const raw = sourceNode.text.replace(/['"]/g, '')
        if (raw.startsWith('.')) imports.push(raw)
      }
      return
    }

    const info = tsSymbolInfo(node)
    if (info) {
      const id = makeId(filePath, info.name, row)
      symbols.push({ id, name: info.name, kind: info.kind, filePath, line: row, exported: isExported, contentHash })
      if (parentId) {
        edges.push({ sourceId: parentId, targetId: id, kind: 'contains', weight: 1.0, confidence: 'extracted' })
      }
      for (const child of node.namedChildren) {
        walkSymbols(child, id)
      }
      return
    }

    for (const child of node.namedChildren) {
      walkSymbols(child, parentId)
    }
  }

  walkSymbols(tree.rootNode)

  // Pass 2: call edges — resolve callee names against the complete local
  // symbol table (hoisting-safe), leave the rest for cross-file matching.
  const localByName = new Map<string, MeridianSymbol[]>()
  for (const s of symbols) {
    const arr = localByName.get(s.name) ?? []
    arr.push(s)
    localByName.set(s.name, arr)
  }

  function walkCalls(node: SyntaxNode, ownerId?: string): void {
    const info = tsSymbolInfo(node)
    if (info) ownerId = makeId(filePath, info.name, node.startPosition.row + 1)

    if (node.type === 'call_expression' && ownerId) {
      const name = calleeName(node)
      if (name) {
        const locals = localByName.get(name)
        if (locals && locals.length > 0) {
          for (const l of locals) {
            edges.push({ sourceId: ownerId, targetId: l.id, kind: 'calls', weight: 1.0, confidence: 'extracted' })
          }
        } else {
          calls.push({ sourceId: ownerId, name, line: node.startPosition.row + 1 })
        }
      }
    }

    for (const child of node.namedChildren) {
      walkCalls(child, ownerId)
    }
  }

  walkCalls(tree.rootNode)
  tree.delete()

  return { filePath, contentHash, symbols, edges, imports, calls }
}

/** Extract the declared kind+name of a TS symbol node, or null. */
function tsSymbolInfo(node: SyntaxNode): { kind: MeridianSymbolKind; name: string } | null {
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
  }

  if (kind && name) return { kind, name }
  return null
}

/** Extract the callee name of a call_expression, or null for dynamic callees
 *  (IIFEs, chained calls, computed members). member_expression yields its
 *  property name — local method calls resolve extracted, foreign ones usually
 *  degrade to ambiguous via cross-file name matching. */
function calleeName(node: SyntaxNode): string | null {
  const fn = node.childForFieldName('function')
  if (!fn) return null
  if (fn.type === 'identifier') return fn.text
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property')
    if (prop && prop.type === 'property_identifier') return prop.text
  }
  return null
}

// --- Python parser ---

export async function parsePythonFile(filePath: string, source: string): Promise<ParseResult> {
  const p = await getParser('python')
  const tree = p.parse(source)
  parseCount++

  const symbols: MeridianSymbol[] = []
  const edges: MeridianEdge[] = []
  const imports: string[] = []
  const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

  function walk(node: SyntaxNode, parentId?: string): void {
    const row = node.startPosition.row + 1
    let kind: MeridianSymbolKind | null = null
    let name: string | null = null

    switch (node.type) {
      case 'function_definition':
        kind = 'function'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'class_definition':
        kind = 'class'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'import_statement': {
        // import foo, import foo.bar
        const modNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'dotted_name')
        if (modNode) imports.push(modNode.text)
        return
      }
      case 'import_from_statement': {
        // from foo import bar
        const modName = node.childForFieldName('module_name')
        if (modName) {
          const raw = modName.text
          if (raw.startsWith('.')) imports.push(raw)
          else imports.push(raw)
        }
        return
      }
    }

    if (kind && name) {
      const id = makeId(filePath, name, row)
      // Python: top-level defs are "exported" (no explicit export keyword)
      const isExported = node.parent?.type === 'module'
      symbols.push({ id, name, kind, filePath, line: row, exported: isExported ?? false, contentHash })
      if (parentId) {
        edges.push({ sourceId: parentId, targetId: id, kind: 'contains', weight: 1.0, confidence: 'extracted' })
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

  return { filePath, contentHash, symbols, edges, imports, calls: [] }
}

// --- Go parser ---

export async function parseGoFile(filePath: string, source: string): Promise<ParseResult> {
  const p = await getParser('go')
  const tree = p.parse(source)
  parseCount++

  const symbols: MeridianSymbol[] = []
  const edges: MeridianEdge[] = []
  const imports: string[] = []
  const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

  function walk(node: SyntaxNode): void {
    const row = node.startPosition.row + 1
    let kind: MeridianSymbolKind | null = null
    let name: string | null = null

    switch (node.type) {
      case 'function_declaration':
        kind = 'function'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'method_declaration':
        kind = 'method'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'type_declaration': {
        const spec = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_spec')
        if (spec) {
          name = spec.childForFieldName('name')?.text ?? null
          const typeNode = spec.childForFieldName('type')
          kind = typeNode?.type === 'interface_type' ? 'interface' : 'type'
        }
        break
      }
      case 'import_declaration': {
        for (const child of node.namedChildren) {
          if (child.type === 'import_spec' || child.type === 'interpreted_string_literal') {
            const raw = child.text.replace(/['"]/g, '')
            if (raw && !raw.startsWith('//')) imports.push(raw)
          }
          if (child.type === 'import_spec_list') {
            for (const spec of child.namedChildren) {
              const pathNode = spec.childForFieldName('path') ?? spec.namedChildren.find((c: SyntaxNode) => c.type === 'interpreted_string_literal')
              if (pathNode) imports.push(pathNode.text.replace(/['"]/g, ''))
            }
          }
        }
        return
      }
    }

    if (kind && name) {
      const id = makeId(filePath, name, row)
      // Go: exported = starts with uppercase
      const isExported = /^[A-Z]/.test(name)
      symbols.push({ id, name, kind, filePath, line: row, exported: isExported, contentHash })
    }

    for (const child of node.namedChildren) {
      walk(child)
    }
  }

  walk(tree.rootNode)
  tree.delete()

  return { filePath, contentHash, symbols, edges, imports, calls: [] }
}
