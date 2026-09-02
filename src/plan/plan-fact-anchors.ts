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
 * - Re-root before reporting: a miss at cwd probes alternate roots (cwd
 *   subdirs → parent → sibling projects) and reports `root-mismatch` with the
 *   actual location instead of `missing-file` — cross-project plans and
 *   subpackage-rooted paths are drift of phrasing, not hallucination.
 *   Re-rooted files are stat'ed only, never read (containment).
 * - Placeholder-shaped basenames (`foo.ts`, `a.py`, …) missing at every root
 *   are treated as illustrative prose and skipped; a real file with such a
 *   name is still checked normally.
 */

import { stat, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path'

export type PlanAnchorDriftKind = 'missing-file' | 'line-out-of-range' | 'root-mismatch'

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
  /** 换根探测实际发生的 syscall 数（stat + readdir，预算 REROOT_PROBE_BUDGET
   *  封顶）。0 = 本次调用无需换根探测。观测与测试断言预算封顶的依据。 */
  rerootProbes: number
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

/** A known-extension-shaped intermediate segment (`README.md/…`) means the
 *  token is glued prose enumeration (`README.md/README.zh.md/…`), not one real
 *  path — a file cannot be a directory. Reject the whole token (fail-open: the
 *  pieces lack dir segments and would be uncheckable anyway). */
const KNOWN_EXT_TAIL_RE = new RegExp(String.raw`\.(?:${EXT_ALTERNATION})$`, 'i')
function hasFileShapedIntermediateSegment(path: string): boolean {
  const segments = path.split('/')
  return segments.slice(0, -1).some(s => KNOWN_EXT_TAIL_RE.test(s))
}

/** Placeholder-shaped basenames used in illustrative prose (`src/foo.ts`,
 *  `src/a.py`). Consulted only after the file proves missing at every root —
 *  a real file with such a name is still checked normally. */
const PLACEHOLDER_BASENAMES = new Set(['foo', 'bar', 'baz', 'qux', 'quux', 'example', 'sample', 'demo', 'dummy', 'placeholder'])
function isPlaceholderShaped(path: string): boolean {
  const base = (path.split('/').pop() ?? path).replace(/\.[^.]*$/, '').toLowerCase()
  return PLACEHOLDER_BASENAMES.has(base) || /^[a-z]$/.test(base)
}

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
  placeholderShaped: boolean
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
      if (hasFileShapedIntermediateSegment(rawPath)) continue
      const lineNo = match[2] ? Number.parseInt(match[2], 10) : undefined
      const key = `${rawPath}:${lineNo ?? ''}`
      const existing = anchors.get(key)
      if (existing) {
        // A "新增" marker anywhere wins — the plan declares intent to create.
        if (declaredNew && !existing.declaredNew) existing.declaredNew = true
        continue
      }
      anchors.set(key, { raw: match[0], path: rawPath, line: lineNo, declaredNew, placeholderShaped: isPlaceholderShaped(rawPath) })
    }
  }
  return [...anchors.values()]
}

/** Same containment judgment as validatePathSafe, minus grants/sensitive logic. */
function isInsideProject(cwd: string, inputPath: string): boolean {
  const rel = relative(resolve(cwd), resolve(cwd, inputPath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Re-root probe exclusions — dependency/build dirs and dotdirs are never alternative roots. */
const REROOT_EXCLUDE_DIRS = new Set(['node_modules', 'dist'])

/** 换根探测总 syscall 预算（stat + readdir 合计）。渐进探测的核心承诺：
 *  最坏成本与目录规模解耦——300 还是 3000 个子目录都在预算内封顶，
 *  预算耗尽后剩余锚点 fail-open 降级为 missing-file（软阻塞性质不变）。 */
const REROOT_PROBE_BUDGET = 128
/** 单个父级目录的枚举截断（极端目录兜底，超出部分不参与换根探测）。 */
const MAX_ROOT_ENUM = 512

interface AltRoot {
  /** Display prefix relative to cwd: `desktop/`, `../`, `../sib/`. */
  label: string
  abs: string
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !REROOT_EXCLUDE_DIRS.has(e.name))
      .map(e => e.name)
  } catch {
    return []
  }
}

/**
 * 换根探测会话：一次 checkPlanFactAnchors 调用内共享预算与枚举缓存。
 * 渐进层级（命中即停，未命中按序推进）：
 * - L0 常数定向：父目录根，每锚点 1 次 stat，不枚举任何目录（跨项目计划主场景）
 * - L1 精确过滤枚举：候选根（cwd 子目录 + parent 兄弟目录）逐 root 一次
 *   readdir 取直接子目录名，与锚点首段求交——命中 ⟹ root 下存在与首段
 *   同名的直接子目录，无假阴性（首段是 rel 存在的必要条件）
 * - L2 完整探测：对首段命中的候选 root stat join(root, rel)
 * 预算：stat/readdir 各扣 1；firstLevel 缓存命中不扣。预算耗尽即停止探测。
 */
interface RerootProbe {
  cwd: string
  parent: string
  selfName: string
  /** 实际发生的探测 syscall 数（写入报告 rerootProbes，测试断言预算封顶的依据）。 */
  probes: number
  /** 候选根（cwd 子目录 + parent 兄弟），惰性构建，跨锚点共享。 */
  roots: AltRoot[] | null
  /** root → 直接子目录名集合（每 root readdir 一次，首段过滤缓存）。 */
  firstLevel: Map<string, Set<string>>
}

function createRerootProbe(cwd: string): RerootProbe {
  return {
    cwd,
    parent: dirname(cwd),
    selfName: basename(cwd),
    probes: 0,
    roots: null,
    firstLevel: new Map(),
  }
}

/** 扣减预算；预算耗尽返回 false（调用方停止探测，fail-open）。 */
function probeSpend(p: RerootProbe): boolean {
  if (p.probes >= REROOT_PROBE_BUDGET) return false
  p.probes += 1
  return true
}

/** 惰性构建候选根列表（readdir(cwd) + readdir(parent) 各一次，跨锚点共享）。
 *  返回 null 表示预算耗尽无法枚举。 */
function ensureRerootRoots(p: RerootProbe): AltRoot[] | null {
  if (p.roots) return p.roots
  if (!probeSpend(p)) return null
  const subs = listSubdirs(p.cwd).slice(0, MAX_ROOT_ENUM)
  const roots: AltRoot[] = subs.map(n => ({ label: `${n}/`, abs: join(p.cwd, n) }))
  if (p.parent !== p.cwd) {
    if (!probeSpend(p)) {
      p.roots = roots
      return roots
    }
    const siblings = listSubdirs(p.parent).filter(n => n !== p.selfName).slice(0, MAX_ROOT_ENUM)
    roots.push(...siblings.map(n => ({ label: `../${n}/`, abs: join(p.parent, n) })))
  }
  p.roots = roots
  return roots
}

/** 单个候选根的 first-level 过滤集（readdir 一次缓存，重复访问不扣预算）。 */
function rootFirstLevel(p: RerootProbe, rootAbs: string): Set<string> | null {
  const cached = p.firstLevel.get(rootAbs)
  if (cached) return cached
  if (!probeSpend(p)) return null
  const set = new Set(listSubdirs(rootAbs))
  p.firstLevel.set(rootAbs, set)
  return set
}

/**
 * 渐进换根探测：L0 父目录根 → L1 root 枚举 + 首段精确过滤 → L2 候选根
 * stat。命中返回带展示标签的候选根；预算耗尽或全部未命中返回 null。
 * 只 stat/readdir，从不读取文件内容、不做行号校验（containment 纪律）。
 */
async function probeReroot(p: RerootProbe, rel: string): Promise<AltRoot | null> {
  // L0：父目录根（跨项目计划主场景，常数 stat，不枚举任何目录）
  if (!probeSpend(p)) return null
  const parentHit = await stat(join(p.parent, rel)).catch(() => null)
  if (parentHit?.isFile()) return { label: '../', abs: p.parent }

  // L1+L2：候选根逐 root 过滤 + 完整探测（预算内，命中即停）
  const roots = ensureRerootRoots(p)
  if (!roots) return null
  const s1 = rel.split('/')[0]!
  for (const root of roots) {
    const first = rootFirstLevel(p, root.abs)
    if (!first) return null // 预算耗尽
    if (!first.has(s1)) continue // 首段不匹配（精确过滤，无假阴性）
    if (!probeSpend(p)) return null
    const hit = await stat(join(root.abs, rel)).catch(() => null)
    if (hit?.isFile()) return root
  }
  return null
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
  // 换根探测统一在第二阶段做（共享预算与枚举缓存）；此处分流使主循环
  // 保持单 stat/锚点，探测成本与 miss 数量解耦。
  const pendingReroot: ExtractedAnchor[] = []
  let probe: RerootProbe | null = null

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
      // 换根重试（第二阶段统一执行）：锚点相对会话目录缺失时，按序探测
      // 父目录根 → cwd 子目录/兄弟项目根（首段精确过滤）——跨项目计划与
      // 子包根写法是"根错位"（给出实际位置），不是"文件不存在"。
      pendingReroot.push(anchor)
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

  // 第二阶段：渐进换根探测（预算封顶、共享枚举、命中即停）。
  if (pendingReroot.length > 0) {
    probe ??= createRerootProbe(cwd)
    for (const anchor of pendingReroot) {
      const hit = await probeReroot(probe, anchor.path)
      if (hit) {
        drifts.push({
          anchor: anchor.raw,
          path: anchor.path,
          kind: 'root-mismatch',
          detail: `计划引用 \`${anchor.raw}\`，相对会话目录不存在，但实际位于 \`${hit.label}${anchor.path}\`——把引用补全为带根前缀的路径，或确认执行目录后再动手。`,
        })
        continue
      }
      // 占位形态（foo/bar/a.py…）且任何根下都不存在（或预算耗尽无法确认）
      // → 视为举例散文，不上报。
      if (anchor.placeholderShaped) continue
      drifts.push({
        anchor: anchor.raw,
        path: anchor.path,
        kind: 'missing-file',
        detail: `计划引用 \`${anchor.raw}\`，但该文件在当前项目中不存在——用工具核实真实路径，或如果是有意新建请标注「新增」。`,
      })
    }
  }

  return { checked, drifts, rerootProbes: probe?.probes ?? 0 }
}

/** Render a drift report as markdown bullet lines (shared by submit/approve surfaces). */
export function formatAnchorDrifts(drifts: PlanAnchorDrift[]): string {
  return drifts.map(d => `- ${d.detail}`).join('\n')
}
