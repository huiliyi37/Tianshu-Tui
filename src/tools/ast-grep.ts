import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'
import { lstatSync, readdirSync } from 'node:fs'

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'Tsx',
  '.js': 'JavaScript',
  '.jsx': 'Tsx',
  '.html': 'Html',
  '.css': 'Css',
}

function inferLang(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return LANG_BY_EXT[ext] ?? null
}

function resolveLang(explicit: string | undefined, filePath: string): string | null {
  if (explicit) return explicit
  return inferLang(filePath)
}

function collectFiles(searchPath: string): string[] {
  const abs = resolve(searchPath)
  if (!existsSync(abs)) return []
  const stat = lstatSync(abs)
  if (stat.isFile()) return [abs]
  if (!stat.isDirectory()) return []
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full)
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  walk(abs)
  return files
}

export interface AstGrepInput {
  pattern: string
  paths?: string[]
  lang?: string
  limit?: number
  includeMeta?: boolean
}

export interface AstGrepMatch {
  file: string
  line: number
  column: number
  matchText: string
  metaVariables?: Record<string, string>
}

function collectMetaVarNames(pattern: string): Array<{ name: string; multi: boolean }> {
  const seen = new Set<string>()
  const vars: Array<{ name: string; multi: boolean }> = []
  // group 1: $ or $$$, group 2: name
  const re = /\$(\$\$)?([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pattern)) !== null) {
    const name = m[2]!
    if (!seen.has(name)) {
      seen.add(name)
      vars.push({ name, multi: m[1] === '$' })
    }
  }
  return vars
}

function formatMatch(m: AstGrepMatch, includeMeta: boolean): string {
  const base = `${m.file}:${m.line}:${m.column}: ${m.matchText.slice(0, 80)}`
  if (includeMeta && m.metaVariables && Object.keys(m.metaVariables).length > 0) {
    const mv = Object.entries(m.metaVariables).map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(', ')
    return `${base}  [${mv}]`
  }
  return base
}

export const AST_GREP_TOOL: Tool = {
  definition: {
    name: 'ast_grep',
    description:
      'Search code by AST structure (not text). Use ast-grep patterns like `function $NAME($$$) { $$$ }` to find syntax nodes. Returns file:line:column with matched text. For TypeScript/JavaScript/Tsx/Html/Css.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern (e.g. "function $NAME($$$) { $$$ }") or rule object' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories to search' },
        lang: { type: 'string', description: 'Language: TypeScript, Tsx, JavaScript, Html, Css' },
        limit: { type: 'integer', description: 'Max matches (default 50)' },
        includeMeta: { type: 'boolean', description: 'Include meta-variable bindings' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const input = params.input as Record<string, unknown>
    const pattern = String(input.pattern ?? '').trim()
    if (!pattern) return { content: 'Error: pattern is required', isError: true }

    const paths = Array.isArray(input.paths) ? (input.paths as string[]).filter(p => typeof p === 'string') : ['.']
    const explicitLang = typeof input.lang === 'string' && input.lang.trim() ? input.lang.trim() : undefined
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50
    const includeMeta = input.includeMeta === true

    // Dynamic import — @ast-grep/napi is a precompiled native addon
    let napi: typeof import('@ast-grep/napi')
    try {
      napi = await import('@ast-grep/napi')
    } catch {
      return { content: 'Error: @ast-grep/napi is not installed. Run: npm install @ast-grep/napi', isError: true }
    }

    const allFiles: string[] = []
    for (const p of paths) {
      const resolved = resolve(params.cwd ?? process.cwd(), p)
      allFiles.push(...collectFiles(resolved))
    }

    const matches: AstGrepMatch[] = []
    const errors: string[] = []
    let filesScanned = 0

    // Lang uses non-enumerable getters — direct property access is the only reliable way
    const LANG_MAP: Record<string, string> = {
      TypeScript: napi.Lang.TypeScript as unknown as string,
      Tsx: napi.Lang.Tsx as unknown as string,
      JavaScript: napi.Lang.JavaScript as unknown as string,
      Html: napi.Lang.Html as unknown as string,
      Css: napi.Lang.Css as unknown as string,
    }

    for (const filePath of allFiles) {
      const langStr = resolveLang(explicitLang, filePath)
      if (!langStr) {
        errors.push(`${filePath}: unsupported language (no grammar for extension)`)
        continue
      }

      const langValue = LANG_MAP[langStr]
      if (typeof langValue !== 'string') {
        errors.push(`${filePath}: unsupported language`)
        continue
      }

      let source: string
      try {
        source = readFileSync(filePath, 'utf-8')
      } catch {
        errors.push(`${filePath}: cannot read file`)
        continue
      }

      filesScanned++

      let root: ReturnType<ReturnType<typeof napi.parse>['root']>
      try {
        root = napi.parse(langValue, source).root()
      } catch {
        errors.push(`${filePath}: parse error`)
        continue
      }

      // tree-sitter error recovery produces ERROR nodes — detect broken syntax
      const errorNodes = root.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
      if (errorNodes.length > 0) {
        errors.push(`${filePath}: parse error (${errorNodes.length} syntax error(s))`)
        continue
      }

      let found
      try {
        // parse as rule object if JSON
        let ruleOrPattern: string | Record<string, unknown> = pattern
        try {
          const parsed = JSON.parse(pattern)
          if (parsed && typeof parsed === 'object' && 'rule' in parsed) {
            ruleOrPattern = parsed
          }
        } catch { /* not JSON — use as pattern string */ }
        found = root.findAll(ruleOrPattern as string)
      } catch {
        errors.push(`${filePath}: pattern compile error`)
        continue
      }

      for (const node of found) {
        if (matches.length >= limit) break
        const range = node.range()
        const line = range.start.line + 1
        const col = range.start.column + 1
        const match: AstGrepMatch = { file: filePath, line, column: col, matchText: node.text() }
        if (includeMeta) {
          match.metaVariables = {}
          // extract meta-variables from named pattern captures ($NAME, $$ARGS etc.)
          const metaVarDefs = collectMetaVarNames(pattern)
          for (const { name, multi } of metaVarDefs) {
            if (multi) {
              const mvs = node.getMultipleMatches(name)
              if (mvs && mvs.length > 0) match.metaVariables[name] = mvs.map(n => n.text()).join(', ')
            } else {
              const mv = node.getMatch(name)
              if (mv) match.metaVariables[name] = mv.text()
            }
          }
        }
        matches.push(match)
      }
      if (matches.length >= limit) break
    }

    const summary = `${matches.length} match(es) in ${filesScanned} file(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`
    const body = matches.map(m => formatMatch(m, includeMeta)).join('\n')
    const errorSection = errors.length > 0 ? `\n\nErrors:\n${errors.map(e => `  - ${e}`).join('\n')}` : ''

    return { content: `${summary}\n\n${body}${errorSection}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
