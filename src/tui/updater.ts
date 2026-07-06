/**
 * TUI 端自动更新检查与 `/update` 命令实现。
 *
 * 策略：
 * - 启动时异步检查最新版本：优先 npm registry，未发布则回退到 GitHub releases。
 * - 仅在有更新时显示一行提示，不阻塞启动。
 * - `/update` 根据安装来源执行对应命令：
 *   - 源码（含 .git）：git pull && npm install && npm run build
 *   - npm 全局安装：npm install -g <pkg>@<channel>
 *   - npm 本地项目依赖：提示用户到项目根目录手动执行
 * - 更新成功后自动拉起新进程并退出当前进程。
 *
 * 可用环境变量关闭启动检查：RIVET_NO_UPDATE_CHECK=1
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { updateCheckPath } from '../config/paths.js'
import { WinStreamDecoder } from '../platform.js'

const NPM_REGISTRY_URL = 'https://registry.npmjs.org'
const GITHUB_API_URL = 'https://api.github.com/repos'
const UPDATE_CHECK_TIMEOUT_MS = 5_000
// 旧值 24h 会导致用户安装新版本后一整天都看不到更新横幅。
// npm 发布频率下 1h 足够及时，又不会过度请求 registry。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

interface UpdateCache {
  timestamp: number
  latest: string | null
  source?: 'npm' | 'github'
}

function getUpdateCachePath(): string {
  return updateCheckPath()
}

function readUpdateCache(): UpdateCache | null {
  try {
    const raw = readFileSync(getUpdateCachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as UpdateCache
    if (typeof parsed.timestamp === 'number') return parsed
  } catch {
    // cache missing or corrupt — fall through to network
  }
  return null
}

function writeUpdateCache(latest: string | null, source?: 'npm' | 'github'): void {
  try {
    const dir = dirname(getUpdateCachePath())
    mkdirSync(dir, { recursive: true })
    writeFileAtomicSync(
      getUpdateCachePath(),
      JSON.stringify({ timestamp: Date.now(), latest, source }) + '\n',
    )
  } catch {
    // best-effort cache
  }
}

export type InstallType = 'source' | 'global' | 'local' | 'unknown'

let cachedGlobalNpmRoot: string | null | undefined

function getGlobalNpmRoot(): string | null {
  if (cachedGlobalNpmRoot !== undefined) return cachedGlobalNpmRoot
  try {
    cachedGlobalNpmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5_000 }).trim()
  } catch {
    cachedGlobalNpmRoot = null
  }
  return cachedGlobalNpmRoot
}

export function parseSemver(version: string): [number, number, number, prerelease?: string] {
  const clean = version.replace(/^v/, '')
  const plusIdx = clean.indexOf('+')
  const base = plusIdx >= 0 ? clean.slice(0, plusIdx) : clean
  const split = base.split('-', 2)
  const core = split[0] ?? '0'
  const pre = split[1]
  const parts = core.split('.').map(x => {
    const n = Number.parseInt(x, 10)
    return Number.isFinite(n) ? n : 0
  })
  while (parts.length < 3) parts.push(0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre]
}

function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const xa = pa[i]
    const xb = pb[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const na = Number.parseInt(xa, 10)
    const nb = Number.parseInt(xb, 10)
    const bothNumeric = Number.isFinite(na) && Number.isFinite(nb)
    if (bothNumeric) {
      if (na !== nb) return na - nb
    } else {
      const sa = bothNumeric ? undefined : xa
      const sb = bothNumeric ? undefined : xb
      if (sa !== undefined && sb !== undefined) {
        if (sa !== sb) return sa < sb ? -1 : 1
      }
    }
  }
  return 0
}

/** Semver 比较。返回值 < 0 表示 a < b。 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] as number
    const bi = pb[i] as number
    if (ai !== bi) return ai - bi
  }
  const preA = pa[3]
  const preB = pb[3]
  if (!preA && !preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  return comparePrerelease(preA, preB)
}

/** 根据当前进程入口定位安装根目录（package.json 所在目录）。 */
export function detectInstallRoot(): string | null {
  const script = process.argv[1]
  if (!script) return null
  try {
    const real = realpathSync(script)
    let dir = dirname(real)
    for (let i = 0; i < 20; i++) {
      const pkg = join(dir, 'package.json')
      if (existsSync(pkg)) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    return null
  }
  return null
}

function readPackageName(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string }
    return pkg.name ?? null
  } catch {
    return null
  }
}

export function getCurrentVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

export function detectInstallType(root: string): InstallType {
  if (existsSync(join(root, '.git'))) return 'source'
  const name = readPackageName(root)
  const globalRoot = getGlobalNpmRoot()
  if (globalRoot && name) {
    const globalPackageRoot = join(globalRoot, name)
    if (root === globalPackageRoot) return 'global'
  }
  if (root.includes(`${sep}node_modules${sep}`)) return 'local'
  return 'unknown'
}

export interface LatestVersionInfo {
  version: string
  publishedAt?: string
  source: 'npm' | 'github'
}

async function fetchWithTimeout(
  url: string,
  options?: RequestInit,
): Promise<Response | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch {
    return null
  }
}

export async function fetchNpmLatestVersion(
  packageName: string,
): Promise<LatestVersionInfo | null> {
  const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}/latest`
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } })
  if (!res || !res.ok) return null
  const data = await res.json() as { version?: string; time?: Record<string, string> }
  if (typeof data.version !== 'string') return null
  return { version: data.version, publishedAt: data.time?.[data.version], source: 'npm' }
}

export async function npmPackageExists(packageName: string): Promise<boolean> {
  const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}/latest`
  const res = await fetchWithTimeout(url, { method: 'HEAD' })
  return res !== null && res.ok
}

export function parseGitHubRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (!match) return null
  const owner = match[1] ?? ''
  let repo = match[2] ?? ''
  if (repo.endsWith('.git')) repo = repo.slice(0, -4)
  return owner && repo ? { owner, repo } : null
}

export function getGitHubRepo(root: string): { owner: string; repo: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      repository?: { url?: string }
      homepage?: string
    }
    const repoUrl = pkg.repository?.url ?? pkg.homepage ?? ''
    return parseGitHubRepoFromUrl(repoUrl)
  } catch {
    return null
  }
}

export async function fetchGitHubLatestVersion(
  owner: string,
  repo: string,
): Promise<LatestVersionInfo | null> {
  const url = `${GITHUB_API_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res || !res.ok) return null
  const data = await res.json() as { tag_name?: string; published_at?: string }
  const tag = data.tag_name
  if (typeof tag !== 'string') return null
  const version = tag.replace(/^v/, '')
  return { version, publishedAt: data.published_at, source: 'github' }
}

export async function fetchLatestVersion(
  packageName: string,
  root?: string,
): Promise<LatestVersionInfo | null> {
  const npm = await fetchNpmLatestVersion(packageName)
  if (npm) return npm
  const gh = root ? getGitHubRepo(root) : null
  if (gh) {
    return fetchGitHubLatestVersion(gh.owner, gh.repo)
  }
  return null
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  current: string
  latest: string
  installType: InstallType
  source: 'npm' | 'github'
}

export interface CheckForUpdateOptions {
  /** 跳过本地缓存，强制重新请求。 */
  bypassCache?: boolean
}

/** 检查是否有可用更新。不抛异常：任何失败都返回 null。 */
export async function checkForUpdate(
  root?: string,
  options?: CheckForUpdateOptions,
): Promise<UpdateCheckResult | null> {
  const installRoot = root ?? detectInstallRoot()
  if (!installRoot) return null
  const name = readPackageName(installRoot)
  if (!name) return null
  const current = getCurrentVersion(installRoot)
  if (!current) return null

  let latestInfo: LatestVersionInfo | null = null

  if (!options?.bypassCache) {
    const cache = readUpdateCache()
    if (cache && Date.now() - cache.timestamp < UPDATE_CHECK_INTERVAL_MS && cache.latest) {
      latestInfo = { version: cache.latest, source: cache.source ?? 'github' }
    }
  }

  if (!latestInfo) {
    latestInfo = await fetchLatestVersion(name, installRoot)
    writeUpdateCache(latestInfo?.version ?? null, latestInfo?.source)
  }

  if (!latestInfo) return null
  const latest = latestInfo.version
  const installType = detectInstallType(installRoot)
  return {
    hasUpdate: compareSemver(current, latest) < 0,
    current,
    latest,
    installType,
    source: latestInfo.source,
  }
}

export function formatUpdateBanner(current: string, latest: string): string {
  return `⬆️  Update available: ${current} → ${latest}. Run /update to upgrade.`
}

export interface UpdateResult {
  ok: boolean
  skipped: boolean
  message: string
}

export function emitLines(text: string, onLine: (line: string) => void): void {
  if (text.length === 0) return
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (line.length === 0 && text.endsWith('\n')) continue
    onLine(line)
  }
}

export async function runUpdate(
  root: string,
  channel: string,
  onLine: (line: string) => void,
): Promise<UpdateResult> {
  const name = readPackageName(root)
  if (!name) {
    return { ok: false, skipped: true, message: 'Could not read package name.' }
  }

  const type = detectInstallType(root)
  let command: string | null = null

  if (type === 'source') {
    command = 'git pull && npm install && npm run build'
  } else if (type === 'global') {
    const published = await npmPackageExists(name)
    if (!published) {
      return {
        ok: false,
        skipped: true,
        message: `Package "${name}" is not yet published to npm. Update from source or wait for the first npm release.`,
      }
    }
    command = `npm install -g ${name}@${channel}`
  } else if (type === 'local') {
    return {
      ok: false,
      skipped: true,
      message: `Local project install: run "npm install ${name}@${channel}" in your project root.`,
    }
  } else {
    return {
      ok: false,
      skipped: true,
      message: `Unknown install type. Run "npm install -g ${name}@${channel}" manually.`,
    }
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let lastErr = ''
    // Windows: npm/git may emit localized lines in the console code page (GBK),
    // not UTF-8 — stream-decode with auto-detection to avoid mojibake (乱码).
    const stdoutDecoder = new WinStreamDecoder()
    const stderrDecoder = new WinStreamDecoder()
    child.stdout?.on('data', (data: Buffer) => {
      emitLines(stdoutDecoder.write(data), onLine)
      lastErr = ''
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = stderrDecoder.write(data)
      emitLines(text, onLine)
      lastErr += text
    })
    child.on('error', (err) => {
      resolve({ ok: false, skipped: false, message: `Failed to start update: ${err.message}` })
    })
    child.on('close', (code) => {
      // Flush any bytes buffered mid multi-byte character.
      emitLines(stdoutDecoder.end(), onLine)
      const stderrTail = stderrDecoder.end()
      if (stderrTail) { emitLines(stderrTail, onLine); lastErr += stderrTail }
      if (code === 0) {
        resolve({ ok: true, skipped: false, message: 'Update completed.' })
      } else {
        const tail = lastErr.slice(-500).trim() || `exit code ${code ?? 'unknown'}`
        resolve({ ok: false, skipped: false, message: `Update failed: ${tail}` })
      }
    })
  })
}

/**
 * 为重启 argv 注入「恢复当前会话」标志。
 *
 * 背景：默认启动铸造全新会话（session-recovery：无隐式恢复）。update 重启若沿用
 * 原始 argv（用户多为 `rivet` 无参启动），新进程就开新会话 → 历史丢失、模型不记得。
 * 这里剔除已有的会话选择标志（`--new` / `--continue`/`-c` / `--resume`/`-r` [id]，含其值），
 * 再追加 `--resume <sessionId>`（映射 RIVET_RESUME_ID），让重启确定性续接当前会话。
 * 指定 id 的恢复不受 cleanExit 影响，且同 cwd 天然通过校验。
 *
 * 纯函数，便于单测。sessionId 缺省时原样返回（去除会话标志后的 argv）。
 */
export function withResumeArgs(argv: string[], sessionId?: string): string[] {
  const cleaned: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--new' || a === '--continue' || a === '-c') continue
    if (a === '--resume' || a === '-r') {
      // 连带吞掉其可选值（下一个非 flag token 视为会话 id/prefix）。
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) i++
      continue
    }
    cleaned.push(a)
  }
  if (sessionId) cleaned.push('--resume', sessionId)
  return cleaned
}

/** 更新成功后拉起新进程并退出当前进程。sessionId 存在时重启续接该会话。 */
export function restartProcess(sessionId?: string): void {
  const args = withResumeArgs(process.argv.slice(1), sessionId)
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  process.exit(0)
}

/**
 * Windows 自更新脚本构造（纯函数，便于单测）。
 *
 * 背景：Windows 会锁定「正在运行的进程已加载的可执行文件与原生模块」
 * （这里是 better_sqlite3.node）。在进程存活时执行 `npm install -g` 覆盖
 * 全局包目录，会命中「另一个程序正在使用此文件」→ 安装失败/半装坏。
 *
 * 方案：spawn 一个分离的 PowerShell —— 先 `Wait-Process` 等当前进程退出、
 * 释放文件锁，再 `npm install -g`，成功后（可选）`Start-Process` 重新拉起。
 * 单引号包裹并把内嵌单引号翻倍（PowerShell 转义），避免路径含空格/引号被截断。
 */
export function buildWindowsSelfUpdateScript(opts: {
  pid: number
  packageName: string
  channel: string
  execPath: string
  argv: string[]
  cwd: string
  relaunch: boolean
}): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const argList = opts.argv.map(q).join(', ')
  const parts = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `try { Wait-Process -Id ${opts.pid} -Timeout 120 } catch {}`,
    `Start-Sleep -Milliseconds 800`,
    `npm install -g ${opts.packageName}@${opts.channel}`,
  ]
  if (opts.relaunch) {
    const relaunchArgs = argList ? `-ArgumentList @(${argList}) ` : ''
    parts.push(
      `if ($LASTEXITCODE -eq 0) { Start-Process -FilePath ${q(opts.execPath)} ${relaunchArgs}-WorkingDirectory ${q(opts.cwd)} }`,
    )
  }
  return parts.join('; ')
}

/**
 * 安排 Windows 后台自更新：spawn 分离 PowerShell（等本进程退出→装→重启），
 * 返回是否成功排程。调用方随后应主动退出当前进程释放文件锁。
 */
export function spawnWindowsSelfUpdate(root: string, channel: string, relaunch = true, sessionId?: string): boolean {
  const name = readPackageName(root)
  if (!name) return false
  const script = buildWindowsSelfUpdateScript({
    pid: process.pid,
    packageName: name,
    channel,
    execPath: process.execPath,
    argv: withResumeArgs(process.argv.slice(1), sessionId),
    cwd: process.cwd(),
    relaunch,
  })
  try {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.unref()
    return true
  } catch {
    return false
  }
}
