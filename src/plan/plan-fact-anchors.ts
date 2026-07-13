/**
 * Plan fact-anchor verification — checks that file paths (and optional line
 * anchors) referenced by a plan actually exist in the current working tree.
 *
 * Born from a real failure: a plan proposed "新增 src/tui/components/… — Ink
 * 组件" while the project had migrated to pure ANSI and `src/tui/components/`
 * did not exist. Scouts had read stale docs, the planner never re-verified,
 * and submit/approve gates only checked form (mermaid/placeholders), not facts.
 *
 * Design constraints:
 * - Generic: Rivet ships to arbitrary user projects. Path recognition is purely
 *   shape-based (contains '/', ends with a known file extension) + filesystem
 *   stat — never a hardcoded directory whitelist of this repo's layout.
 * - Fail-open on ambiguity: anchors that resolve outside the project, URLs,
 *   module-relative imports and unparseable tokens are skipped, not flagged.
 *   The consumer (plan submit) is a one-shot soft block, so false positives
 *   cost one resubmit, never a dead end.
 */

import { stat, readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname } from 'node:path'

export type PlanAnchorDriftKind = 'missing-file' | 'missing-parent-dir' | 'line-out-of-range'

export interface PlanAnchorDrift {
  /** Raw anchor as written in the plan, e.g. `src/agent/loop.ts:643` */
  anchor: string
  /** Normalized project-relative path */
  path: string
  line?: number
  kind: PlanAnchorDriftKind
  detail: string
}

export interface PlanAnchorReport {
  /** Number of distinct anchors that were actually verified */
  checked: number
  drifts: PlanAnchorDrift[]
}

/**
 * Generic file-extension set — recognition is shape-based, not project-based.
 * Extending this list is safe; anchors with unknown extensions are simply not
 * checked (fail-open).
 */
const EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'jsonc', 'md', 'mdx', 'txt',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift',
  'sh', 'bash', 'zsh', 'ps1', 'bat',
  'yml', 'yaml', 'toml', 'ini', 'env.example', 'sql', 'graphql', 'proto',
] as const

// Token shape: at least one directory segment + filename with known extension,
// optionally followed by :line or :line-line. The lookbehind rejects tokens
// glued to URL/path prefixes (e.g. `github.com/...` inside an https URL is
// preceded by '/', so it never matches). Alternation is longest-first and the
// trailing (?!\w) guard prevents `selector.tsx` from being clipped to
// `selector.ts` by a shorter alternative winning the ordered alternation.
const EXT_ALTERNATION = [...EXTENSIONS]
  .sort((a, b) => b.length - a.length)
  .map(ext => ext.replace(/\./g, String.raw`\.`))
  .join('|')
const PATH_TOKEN_RE = new RegExp(
  String.raw`(?<![\w./\\-])((?:[\w.@-]+/)+[\w.@-]+\.(?:${EXT_ALTERNATION}))(?!\w)(?::(\d+)(?:-\d+)?)?`,
  'g',
)

/** Markers that declare a referenced file as intentionally new (not yet existing).
 *  Deliberately narrow — a broad marker (e.g. English "add") would exempt most
 *  anchors in English prose and gut the existence check (fail-open too far). */
const NEW_FILE_MARKER_RE = /新增|新建|创建|\bnew file\b|\bcreate[ds]?\b/i

/** Fence languages whose contents still carry checkable project paths. */
const CHECKABLE_FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', ''])

/** Skip line-count verification for files larger than this (cost guard). */
const LINE_CHECK_MAX_BYTES = 2 * 1024 * 1024

/** Bound total anchor verification work per plan. */
const MAX_ANCHORS = 200

interface ExtractedAnchor {
  raw: string
  path: string
  line?: number
  declaredNew: boolean
}

/**
 * Extract candidate anchors from plan markdown. Fenced blocks are skipped
 * except shell-ish fences (verification command blocks reference real test
 * paths); mermaid/diff/code-proposal fences are full of module-relative or
 * illustrative paths and would only produce noise.
 */
export function extractPlanAnchors(content: string): ExtractedAnchor[] {
  const anchors = new Map<string, ExtractedAnchor>()
  let inFence = false
  let fenceLang = ''

  for (const line of content.split('\n')) {
    const fenceMatch = line.match(/^\s*```([\w-]*)/)
    if (fenceMatch) {
      inFence = !inFence
      fenceLang = inFence ? (fenceMatch[1] ?? '').toLowerCase() : ''
      continue
    }
    if (inFence && !CHECKABLE_FENCE_LANGS.has(fenceLang)) continue

    const declaredNew = NEW_FILE_MARKER_RE.test(line)
    for (const match of line.matchAll(PATH_TOKEN_RE)) {
      const rawPath = match[1]!
      // Module-relative or escaping references are import-style, not project
      // anchors — resolution base is unknowable, skip.
      if (rawPath.startsWith('./') || rawPath.includes('..')) continue
      if (rawPath.includes('node_modules/')) continue
      const lineNo = match[2] ? Number.parseInt(match[2], 10) : undefined
      const key = `${rawPath}:${lineNo ?? ''}`
      const existing = anchors.get(key)
      if (existing) {
        // A "新增" marker anywhere wins — the plan declares intent to create.
        if (declaredNew && !existing.declaredNew) existing.declaredNew = true
        continue
      }
      anchors.set(key, { raw: match[0], path: rawPath, line: lineNo, declaredNew })
    }
  }
  return [...anchors.values()]
}

/** Same containment judgment as validatePathSafe, minus grants/sensitive logic. */
function isInsideProject(cwd: string, inputPath: string): boolean {
  const rel = relative(resolve(cwd), resolve(cwd, inputPath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Verify plan anchors against the working tree. Returns drift entries for
 * anchors that do not match reality; skipped (out-of-project / capped) anchors
 * are never reported as drift.
 */
export async function checkPlanFactAnchors(content: string, cwd: string): Promise<PlanAnchorReport> {
  const anchors = extractPlanAnchors(content).slice(0, MAX_ANCHORS)
  const drifts: PlanAnchorDrift[] = []
  let checked = 0

  // Paths declared new elsewhere in the plan stay exempt from existence checks
  // when re-referenced without the marker (e.g. task list + verification block).
  const declaredNewPaths = new Set(anchors.filter(a => a.declaredNew).map(a => a.path))

  for (const anchor of anchors) {
    if (!isInsideProject(cwd, anchor.path)) continue
    checked += 1
    const absolute = resolve(cwd, anchor.path)

    if (anchor.declaredNew || declaredNewPaths.has(anchor.path)) {
      // 计划明确要新建的文件：不再逐条校验父目录是否存在。
      // 新建模块时父目录自然也不存在，执行层 write_file 会按需创建；
      // 这里如果报漂移，只会把整份新模块计划的批准提示变成大量噪声。
      continue
    }

    const fileStat = await stat(absolute).catch(() => null)
    if (!fileStat || !fileStat.isFile()) {
      drifts.push({
        anchor: anchor.raw,
        path: anchor.path,
        kind: 'missing-file',
        detail: `计划引用 \`${anchor.raw}\`，但该文件在当前项目中不存在——用工具核实真实路径，或如果是有意新建请标注「新增」。`,
      })
      continue
    }

    if (anchor.line !== undefined && fileStat.size <= LINE_CHECK_MAX_BYTES) {
      const text = await readFile(absolute, 'utf-8').catch(() => null)
      if (text !== null) {
        const lineCount = text.split('\n').length
        if (anchor.line > lineCount) {
          drifts.push({
            anchor: anchor.raw,
            path: anchor.path,
            line: anchor.line,
            kind: 'line-out-of-range',
            detail: `计划引用 \`${anchor.raw}\`，但该文件当前只有 ${lineCount} 行——行号锚点已漂移，重读文件更新引用。`,
          })
        }
      }
    }
  }

  return { checked, drifts }
}

/** Render a drift report as markdown bullet lines (shared by submit/approve surfaces). */
export function formatAnchorDrifts(drifts: PlanAnchorDrift[]): string {
  return drifts.map(d => `- ${d.detail}`).join('\n')
}
