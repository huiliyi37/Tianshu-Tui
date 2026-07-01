import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { applyEol, chooseEol, detectEol } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import {
  inferLang,
  resolveLang,
  collectFiles,
  collectMetaVarNames,
  buildLangMap,
  isDynamicLang,
  ensureDynamicLangsRegistered,
} from './ast-shared.js'

// ── types ─────────────────────────────────────────────────────────

export interface AstEditOp {
  find: string
  replace: string
}

export interface AstEditInput {
  ops: AstEditOp[]
  paths?: string[]
  lang?: string
  dryRun?: boolean
  limit?: number
}

interface FileChange {
  before: string
  after: string
  line: number
}

// ── tool ──────────────────────────────────────────────────────────

interface SgNodeLike {
  text(): string
  range(): { start: { index: number; line: number; column: number }; end: { index: number; line: number; column: number } }
  getMatch(name: string): SgNodeLike | null
  getMultipleMatches(name: string): SgNodeLike[] | null
}

function interpolateTemplate(template: string, node: SgNodeLike): string {
  let result = template
  const vars = collectMetaVarNames(template)
  // replace in reverse order of length to avoid partial matches (e.g. $NAME vs $NAME2)
  for (const { name, multi } of vars.sort((a, b) => b.name.length - a.name.length)) {
    if (multi) {
      const mvs = node.getMultipleMatches(name)
      if (mvs && mvs.length > 0) {
        result = result.replace(new RegExp(`\\$\\$\\${name}`, 'g'), mvs.map((n: SgNodeLike) => n.text()).join(''))
      }
    } else {
      const mv = node.getMatch(name)
      if (mv) {
        result = result.replace(new RegExp(`\\$${name}\\b`, 'g'), mv.text())
      }
    }
  }
  return result
}

export const AST_EDIT_TOOL: Tool = {
  definition: {
    name: 'ast_edit',
    description:
      'Edit code by AST structure (not text). Use ast-grep patterns to find and replace syntax nodes. Defaults to dryRun (preview only). Set dryRun:false to write files. For TypeScript/JavaScript/Tsx/Html/Css.',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'ast-grep pattern to find (e.g. "var $NAME = $VAL")' },
              replace: { type: 'string', description: 'Replacement template (e.g. "const $NAME = $VAL")' },
            },
            required: ['find', 'replace'],
          },
          description: 'Ordered list of find/replace operations',
        },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories to edit' },
        lang: { type: 'string', description: 'Language: TypeScript, Tsx, JavaScript, Html, Css' },
        dryRun: { type: 'boolean', description: 'If true (default), preview only — do not write files' },
        limit: { type: 'integer', description: 'Max changes per file (default 50)' },
      },
      required: ['ops'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const input = params.input as Record<string, unknown>
    const ops = Array.isArray(input.ops) ? (input.ops as AstEditOp[]) : []
    if (ops.length === 0) return { content: 'Error: at least one find/replace op is required', isError: true }

    for (const op of ops) {
      if (typeof op.find !== 'string' || !op.find.trim()) {
        return { content: 'Error: each op must have a non-empty "find" pattern', isError: true }
      }
      if (typeof op.replace !== 'string') {
        return { content: 'Error: each op must have a "replace" template', isError: true }
      }
    }

    const paths = Array.isArray(input.paths) ? (input.paths as string[]).filter(p => typeof p === 'string') : ['.']
    const explicitLang = typeof input.lang === 'string' && input.lang.trim() ? input.lang.trim() : undefined
    const dryRun = input.dryRun !== false // default true
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50

    let napi: typeof import('@ast-grep/napi')
    try {
      napi = await import('@ast-grep/napi')
    } catch {
      return { content: 'Error: @ast-grep/napi is not installed. Run: npm install @ast-grep/napi', isError: true }
    }

    const LANG_MAP = buildLangMap(napi)
    await ensureDynamicLangsRegistered(napi)

    const allFiles: string[] = []
    for (const p of paths) {
      const resolved = resolve(params.cwd ?? process.cwd(), p)
      allFiles.push(...collectFiles(resolved))
    }

    const fileResults: Array<{ file: string; changes: FileChange[]; error?: string }> = []
    const errors: string[] = []

    for (const filePath of allFiles) {
      const langStr = resolveLang(explicitLang, filePath)
      if (!langStr) {
        errors.push(`${filePath}: unsupported language`)
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

      const changes: FileChange[] = []
      let currentSource = source

      for (const op of ops) {
        let root: ReturnType<ReturnType<typeof napi.parse>['root']>
        try {
          root = napi.parse(langValue, currentSource).root()
        } catch {
          errors.push(`${filePath}: parse error on op "${op.find.slice(0, 40)}"`)
          break
        }

        // detect syntax errors in current source
        const errorNodes = root.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
        if (errorNodes.length > 0) {
          errors.push(`${filePath}: parse error (${errorNodes.length} syntax error(s))`)
          break
        }

        // parse as rule object if JSON
        let pattern: string | Record<string, unknown> = op.find
        try {
          const parsed = JSON.parse(op.find)
          if (parsed && typeof parsed === 'object' && 'rule' in parsed) {
            pattern = parsed
          }
        } catch { /* not JSON */ }

        let found: ReturnType<typeof root.findAll>
        try {
          found = root.findAll(pattern as string)
        } catch {
          errors.push(`${filePath}: pattern compile error for "${op.find.slice(0, 40)}"`)
          continue
        }

        if (found.length === 0) continue

        // collect edits (limited), substituting meta-variables
        const edits: Array<{ startPos: number; endPos: number; insertedText: string }> = []
        const count = Math.min(found.length, limit)
        for (let i = 0; i < count; i++) {
          const node = found[i]!
          const before = node.text()
          const range = node.range()
          const line = range.start.line + 1
          // interpolate template with meta-variable values
          const after = interpolateTemplate(op.replace, node)

          changes.push({ before, after, line })
          edits.push({
            startPos: range.start.index,
            endPos: range.end.index,
            insertedText: after,
          })
        }

        // Overlap guard: findAll returns non-nested matches, but a pattern can
        // still produce ranges that touch/cross when meta-variables expand
        // asymmetrically. commitEdits on overlapping ranges corrupts the output.
        // Drop any edit whose range encloses or is enclosed by an earlier one,
        // keeping the first (outermost) match intact.
        edits.sort((a, b) => a.startPos - b.startPos)
        const deduped: typeof edits = []
        let skippedOverlap = 0
        for (const e of edits) {
          const prev = deduped[deduped.length - 1]
          if (prev && e.startPos < prev.endPos) {
            // overlaps or nested — skip to avoid corrupting commitEdits
            skippedOverlap++
            continue
          }
          deduped.push(e)
        }
        if (skippedOverlap > 0) {
          errors.push(`${filePath}: skipped ${skippedOverlap} overlapping match(es) for "${op.find.slice(0, 40)}" — nested ranges would corrupt the edit`)
        }

        // apply edits and re-parse for next op
        try {
          currentSource = root.commitEdits(deduped)
        } catch {
          errors.push(`${filePath}: commitEdits failed for "${op.find.slice(0, 40)}"`)
          break
        }
      }

      if (changes.length > 0) {
        // Final syntax check on the post-edit source before writing. The per-op
        // loop detects ERROR nodes between ops, but the LAST op's result is
        // never re-checked — a replacement can itself introduce invalid syntax
        // (e.g. an unbalanced brace in the replace template). Catch it here so
        // we never persist a broken file silently.
        let finalSyntaxOk = true
        if (!dryRun) {
          try {
            const finalRoot = napi.parse(langValue, currentSource).root()
            const finalErrors = finalRoot.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
            if (finalErrors.length > 0) {
              errors.push(`${filePath}: post-edit syntax error (${finalErrors.length} ERROR node(s)) — file NOT written, change discarded`)
              finalSyntaxOk = false
            }
          } catch {
            errors.push(`${filePath}: post-edit parse failed — file NOT written, change discarded`)
            finalSyntaxOk = false
          }
        }
        if (finalSyntaxOk) {
          fileResults.push({ file: filePath, changes })
          if (!dryRun) {
            try {
              params.onFileWrite?.(filePath)
              // Preserve the file's original line endings (CRLF on Windows-authored
              // files); ast-grep edits operate on \n-normalized ranges internally.
              const eol = chooseEol(filePath, detectEol(source), getTargetEol())
              await writeFileAtomicAsync(filePath, applyEol(currentSource, eol))
            } catch {
              errors.push(`${filePath}: failed to write changes`)
            }
          }
        }
      }
    }

    // ── format output ─────────────────────────────────────────────

    const totalChanges = fileResults.reduce((sum, f) => sum + f.changes.length, 0)
    const action = dryRun ? 'preview' : 'applied'

    let body = ''
    for (const fr of fileResults) {
      body += `\n${fr.file}:`
      for (const ch of fr.changes) {
        // Multi-line-aware preview: show before/after as separate blocks instead
        // of collapsing newlines to \n. The model can judge whether a structural
        // replacement is correct only if it sees the actual shape of the change.
        const beforeLines = ch.before.split('\n')
        const afterLines = ch.after.split('\n')
        const beforeShow = beforeLines.length > 1
          ? beforeLines.slice(0, 3).join('\n    ') + (beforeLines.length > 3 ? `\n    … (+${beforeLines.length - 3} lines)` : '')
          : beforeLines[0]!.slice(0, 80)
        const afterShow = afterLines.length > 1
          ? afterLines.slice(0, 3).join('\n    ') + (afterLines.length > 3 ? `\n    … (+${afterLines.length - 3} lines)` : '')
          : afterLines[0]!.slice(0, 80)
        body += `\n  L${ch.line}:\n    - ${beforeShow}\n    + ${afterShow}`
      }
    }

    const summary = `${totalChanges} change(s) ${action} in ${fileResults.length} file(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`
    const errorSection = errors.length > 0 ? `\n\nErrors:\n${errors.map(e => `  - ${e}`).join('\n')}` : ''

    return { content: `${summary}\n${body}${errorSection}` }
  },

  requiresApproval: () => true, // ast-edit writes files — needs approval
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
