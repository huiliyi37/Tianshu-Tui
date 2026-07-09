import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  inferLang,
  resolveLang,
  collectFiles,
  collectMetaVarNames,
  buildLangMap,
  isDynamicLang,
  ensureDynamicLangsRegistered,
} from './ast-shared.js'

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

function formatMatch(m: AstGrepMatch, includeMeta: boolean): string {
  // Multi-line matches (e.g. a whole function) would dump the body into the
  // result line and bury the meta-vars at the end. Show only the first line of
  // the match + a line-count marker, so the meta-var shape summaries stay
  // visible on the same logical line the model scans.
  const raw = m.matchText
  const lines = raw.split('\n')
  const head = lines.length > 1 ? `${lines[0]!.slice(0, 70)} (+${lines.length - 1} lines)` : lines[0]!.slice(0, 80)
  const base = `${m.file}:${m.line}:${m.column}: ${head}`
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

    // Parse the pattern once: a bare pattern string and a `{ rule: ... }` JSON
    // object are both valid ast-grep inputs. Detect rule objects early so we
    // can skip the regex-misuse guard on their internal fields.
    let ruleOrPattern: string | Record<string, unknown> = pattern
    let isRuleObject = false
    try {
      const parsed = JSON.parse(pattern)
      if (parsed && typeof parsed === 'object' && 'rule' in parsed) {
        ruleOrPattern = parsed
        isRuleObject = true
      }
    } catch { /* not JSON — use as bare pattern string */ }

    // Regex-misuse guard: ast_grep uses ast-grep pattern syntax ($NAME, $$NAME),
    // not regular expressions. \d \w \1 etc. will not work as intended.
    if (!isRuleObject && /\\[dDwWsSbB1-9]/.test(pattern)) {
      return {
        content: `Error: pattern contains regex tokens (\\d, \\w, \\s, \\1, etc.).\n\nast_grep uses ast-grep syntax, not regular expressions. Use $NAME for single-node captures and $$NAME for ellipsis (multi-node) captures.\n\nOffending pattern: ${pattern.slice(0, 80)}`,
        isError: true,
      }
    }

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
      try {
        allFiles.push(...collectFiles(resolved))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: `Error: ${message}`, isError: true }
      }
    }

    const matches: AstGrepMatch[] = []
    const errors: string[] = []
    let filesScanned = 0

    // Lang uses non-enumerable getters — build the map from the resolved napi.
    const LANG_MAP = buildLangMap(napi)
    // Register dynamic languages (python/json) once before any parse — lazy,
    // single-shot, degrades gracefully if the lang-* package is missing.
    await ensureDynamicLangsRegistered(napi)

    for (const filePath of allFiles) {
      const langStr = resolveLang(explicitLang, filePath)
      if (!langStr) {
        errors.push(`${filePath}: unsupported language (no grammar for extension)`)
        continue
      }

      // Dynamic languages (python/json) are parsed by their registered name;
      // built-in languages go through napi.Lang.X via LANG_MAP.
      const langValue = isDynamicLang(langStr) ? langStr : LANG_MAP[langStr]
      // runtime assertion: napi.Lang uses non-enumerable getters — verify we got a real string
      if (typeof langValue !== 'string') {
        errors.push(`${filePath}: LANG_MAP returned non-string for "${langStr}" — possible @ast-grep/napi API change`)
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
              if (mvs && mvs.length > 0) {
                // Shape summary, not raw text: a $$$BODY capture can span an
                // entire function (KB of source). The model needs the SHAPE
                // (how big, what it starts with) to judge whether the match is
                // sane — the full text is read_file's job. Precise counts avoid
                // ambiguity: "8 lines" is unambiguous, a truncated code blob is not.
                const texts = mvs.map(n => n.text())
                const nodeCount = texts.length
                const lineCount = texts.reduce((sum, t) => sum + t.split('\n').length, 0)
                const firstLine = texts[0]!.split('\n')[0]!.trim().slice(0, 50)
                match.metaVariables[name] = `${nodeCount}n/${lineCount}L: ${firstLine}`
              }
            } else {
              const mv = node.getMatch(name)
              if (mv) match.metaVariables[name] = mv.text().slice(0, 120)
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
