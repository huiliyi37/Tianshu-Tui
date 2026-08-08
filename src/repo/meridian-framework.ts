import type { MeridianSymbol, MeridianEdge, MeridianSymbolKind } from './meridian-types.js'

/**
 * Framework-level extraction absorbed from CodeGraph's express resolver
 * (.rivet/scratch/scout/codegraph/src/resolution/frameworks/express.ts) and
 * the JSX-tag pass of its callback-synthesizer.
 *
 * Unlike the tree-sitter symbol pass (meridian-parser), these extractors are
 * regex-based over comment-stripped source. All emitted edges carry
 * `inferred` confidence: the handler/child target is resolved by name against
 * the caller-supplied known-symbol table, so nothing is connected to a symbol
 * this repo does not actually have (anti over-extraction).
 *
 * Edge kinds (see meridian-types.ts):
 *  - route_handles: route symbol → named handler symbol (Express routes)
 *  - jsx_children:  enclosing component → known child component (PascalCase JSX)
 */

/** Remove line + block comments while preserving string-literal contents. */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let inStr: string | null = null
  while (i < source.length) {
    const ch = source[i]!
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1]!
        i += 2
        continue
      }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      // Block comment: drop the content but keep newlines so downstream
      // line numbers (route line, JSX enclosing order) stay aligned with
      // the original source (review MEDIUM-4).
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

const ROUTE_HEAD_RE = /\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,/g

/** Tail identifier of an expression: `auth, listUsers` → `listUsers`. */
function tailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '')
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/)
  return m ? m[1]! : null
}

/**
 * Express-style route extraction: `(app|router).METHOD('/path', handler[, …])`
 * → a `route` symbol + a `route_handles` edge to the handler, but only when
 * the handler resolves to a symbol in `knownSymbols` (by exact name). Named
 * handler = last comma-separated arg of the call; middleware args before it
 * are ignored. Inline arrows produce a route symbol but no edge (no name to
 * resolve against).
 */
export function extractExpressRoutes(
  filePath: string,
  source: string,
  knownSymbols: MeridianSymbol[],
): { symbols: MeridianSymbol[]; edges: MeridianEdge[] } {
  const symbols: MeridianSymbol[] = []
  const edges: MeridianEdge[] = []
  const safe = stripComments(source)
  const knownByName = new Map<string, MeridianSymbol[]>()
  for (const s of knownSymbols) {
    const arr = knownByName.get(s.name) ?? []
    arr.push(s)
    knownByName.set(s.name, arr)
  }

  let m: RegExpExecArray | null
  while ((m = ROUTE_HEAD_RE.exec(safe)) !== null) {
    const method = m[2]!.toUpperCase()
    const routePath = m[3]!
    if (method === 'USE' && !routePath.startsWith('/')) continue
    const line = safe.slice(0, m.index).split('\n').length
    const name = `${method} ${routePath}`
    const routeId = `${filePath}:${name}:${line}`
    symbols.push({ id: routeId, name, kind: 'route', filePath, line, exported: false, contentHash: '' })

    // Argument list = balanced parens from the call's open paren, so inline
    // arrow handlers with nested braces don't truncate it.
    const openParen = safe.indexOf('(', m.index)
    const closeParen = openParen >= 0 ? matchDelim(safe, openParen, '(', ')') : -1
    const args = closeParen > openParen ? safe.slice(openParen + 1, closeParen) : ''
    if (args.includes('=>')) continue // anonymous arrow — nothing to name-resolve

    const parts = args.split(',').map(s => s.trim()).filter(Boolean)
    const last = parts[parts.length - 1]
    const handlerName = last ? tailIdent(last) : null
    if (!handlerName) continue
    const matches = knownByName.get(handlerName)
    if (matches && matches.length === 1) {
      edges.push({
        sourceId: routeId,
        targetId: matches[0]!.id,
        kind: 'route_handles',
        weight: 1.0,
        confidence: 'inferred',
      })
    }
  }
  return { symbols, edges }
}

const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g

/**
 * PascalCase JSX tag → `jsx_children` edge from the enclosing component to a
 * known child symbol. Source = nearest symbol whose start line precedes the
 * tag (enclosing component); target = child tag matched against
 * `knownSymbols` by exact name — a tag for a symbol this repo does not have
 * emits nothing (anti over-extraction). Lowercase tags are HTML, not
 * components, and are ignored.
 */
export function extractJsxChildren(
  filePath: string,
  source: string,
  fileSymbols: MeridianSymbol[],
  knownSymbols: MeridianSymbol[],
): { symbols: MeridianSymbol[]; edges: MeridianEdge[] } {
  const edges: MeridianEdge[] = []
  const safe = stripComments(source)
  const knownByName = new Map<string, MeridianSymbol[]>()
  for (const s of knownSymbols) {
    const arr = knownByName.get(s.name) ?? []
    arr.push(s)
    knownByName.set(s.name, arr)
  }
  // Enclosing candidates: file-local symbols ordered by start line.
  const enclosing = [...fileSymbols].sort((a, b) => a.line - b.line)

  let m: RegExpExecArray | null
  while ((m = JSX_TAG_RE.exec(safe)) !== null) {
    const tag = m[1]!
    const line = safe.slice(0, m.index).split('\n').length
    const matches = knownByName.get(tag)
    if (!matches || matches.length !== 1) continue
    const target = matches[0]!
    // Nearest symbol starting at or before this tag's line.
    let parent: MeridianSymbol | null = null
    for (const s of enclosing) {
      if (s.line <= line) parent = s
      else break
    }
    if (!parent) continue
    edges.push({
      sourceId: parent.id,
      targetId: target.id,
      kind: 'jsx_children',
      weight: 1.0,
      confidence: 'inferred',
    })
  }
  return { symbols: [], edges }
}

/** Index of the delimiter matching the one at `open`, skipping string literals. */
function matchDelim(s: string, open: number, oc: string, cc: string): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < s.length && s[i] !== ch) {
        if (s[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === oc) depth++
    else if (ch === cc) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export type { MeridianSymbolKind }
