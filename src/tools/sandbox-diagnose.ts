/**
 * Attribute a failed bash command to the sandbox write boundary.
 *
 * Without this, a Seatbelt/bwrap denial reaches the model as a bare
 * "Operation not permitted" — whose standard model reaction is sudo/chmod
 * retry, i.e. the documented doom-loop shape. Attribution turns a dead end
 * into a routable action (request_path_access).
 *
 * Pure: given stderr + backend + the writable roots that were in effect,
 * decide whether the boundary caused the failure and which paths it refused.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SandboxBackendKind } from './sandbox-profile.js'
import { isPathUnder } from './path-grants.js'

export interface SandboxDenial {
  backend: SandboxBackendKind
  /** Absolute paths refused, deduped, first-seen order. May be empty when the
   *  denial is certain but no path could be extracted. */
  paths: string[]
}

/**
 * Denial fingerprints.
 * - Seatbelt returns EPERM  → "Operation not permitted"
 * - bwrap/firejail mount the root read-only → EROFS → "Read-only file system"
 * - Landlock allow-list denials → EACCES → "Permission denied"
 * All families are accepted regardless of backend: a command may shell out to
 * something that reports the other wording, and a false positive here only
 * costs an extra hint line.
 */
const DENIAL_MARKERS =
  /Operation not permitted|operation not permitted|Read-only file system|read-only file system|Permission denied|permission denied|\bEPERM\b|\bEROFS\b|\bEACCES\b/

/** bwrap failing to construct the sandbox itself (exit 127 + its own prefix). */
const BWRAP_SELF_FAILURE = /^bwrap: /m

const PATH_PATTERNS: readonly RegExp[] = [
  // Node: EPERM: operation not permitted, mkdir '/path'
  //       EROFS: read-only file system, open '/path'
  //       EACCES: permission denied, open '/path'（Landlock allow-list 拒绝方言）
  /E(?:PERM|ROFS|ACCES): (?:operation not permitted|read-only file system|permission denied), \w+ '([^']+)'/g,
  // coreutils / shell: "mkdir: /path: Operation not permitted"
  //                    "sh: /path: Operation not permitted"
  //                    "touch: /path: Read-only file system"
  //                    "touch: /path: Permission denied"
  /(?:^|\n)[^\n:]{0,48}?: (\/[^\n:]+): (?:Operation not permitted|Read-only file system|Permission denied)/g,
  // Rust / Go / generic: failed to create directory `/path`
  // {0,40} is greedy — the character class excludes quotes, so the gap can
  // never cross a delimiter and greedy/lazy are equivalent here.
  /(?:failed to|cannot|unable to) (?:create|open|write to|remove)[^\n'"`]{0,40}[`'"](\/[^`'"\n]+)[`'"]/g,
  // bwrap self-failure: "bwrap: Can't create file at /path: No such file…"
  // landlock launcher self-failure: "landlock-run: cannot open rule path: /path: …"
  //   （launcher CLI 契约：所有 launcher 级 fatal 都以 landlock-run: 前缀输出）
  // [^\s:,;]+ rather than \S+: \S+ swallows the trailing colon and yields
  // "/nonexistent/x:", a path that matches no real directory and makes the
  // request_path_access the model is told to call fail.
  /^bwrap: [^\n]*?(\/[^\s:,;]+)/gm,
  /^landlock-run: [^\n]*?(\/[^\s:,;]+)/gm,
]

/** Extract candidate absolute paths from a denial stderr, first-seen order. */
export function extractDeniedPaths(stderr: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const re of PATH_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(stderr)) !== null) {
      const p = m[1]?.trim()
      if (!p || !p.startsWith('/') || seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/**
 * Decide whether this failure is a sandbox write-boundary denial.
 * Paths already inside a writable root are dropped — a refusal there is not a
 * boundary problem (bad permission bits, missing parent, disk full…), and
 * reporting it would send the model chasing a grant it already has.
 */
export function classifySandboxDenial(opts: {
  stderr: string
  backend: SandboxBackendKind
  writableRoots: readonly string[]
}): SandboxDenial | null {
  const { stderr, backend, writableRoots } = opts
  if (backend === 'none') return null
  if (!DENIAL_MARKERS.test(stderr) && !BWRAP_SELF_FAILURE.test(stderr)) return null

  const allPaths = extractDeniedPaths(stderr)
  const paths = allPaths.filter(
    p => !writableRoots.some(root => isPathUnder(root, p)),
  )
  // Markers present but every extracted path is already writable → the failure
  // is something else wearing the same wording. Stay silent.
  if (paths.length === 0 && allPaths.length > 0) return null
  return { backend, paths }
}

/** Model-facing hint. Names the paths and routes to the one action that works. */
export function buildSandboxDenialHint(denial: SandboxDenial): string {
  const head = `沙箱写边界拦截（backend=${denial.backend}）：命令试图写入工作区之外的路径。`
  const body = denial.paths.length > 0
    ? '被拒路径：\n' + denial.paths.map(p => `  - ${p}`).join('\n')
    : '未能从输出中定位具体路径 —— 请从命令本身判断它要写哪个工作区外目录。'
  const action = denial.paths.length > 0
    ? `继续的唯一正确做法：调用 request_path_access({ path: "${denial.paths[0]}", mode: "write", remember: true }) 取得用户授权，批准后原命令直接重跑即可（授权对下一条 bash 立即生效）。`
    : '继续的唯一正确做法：用 request_path_access({ path: "<目标目录>", mode: "write", remember: true }) 申请该目录的写权限，批准后重跑原命令。'
  const antiPattern = '这不是文件权限位问题，也不是代码缺陷 —— 不要用 sudo、chmod、chown 重试，它们在沙箱下同样会被拒。若该路径本就不该被写入，改用工作区内路径（如 ./target、./build、./dist）。'
  return [head, body, action, antiPattern].join('\n')
}

/**
 * Append a learn-mode observation. One JSON object per line so the file can be
 * folded into the toolchain table with jq. Best-effort: a logging failure
 * must never break the command.
 */
export function recordSandboxLearn(entry: {
  cwd: string
  command: string
  backend: SandboxBackendKind
  deniedPaths: readonly string[]
  retried: boolean
}, rivetHomeDir: string): void {
  try {
    const file = join(rivetHomeDir, 'sandbox-learn.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf-8')
  } catch {
    /* best-effort */
  }
}
